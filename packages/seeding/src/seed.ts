/**
 * Brain Seeding runner (§25, §30 pre-launch gate). PERP-ONLY (§25 memecoin scope).
 *
 * Composition, not new machinery — every piece exists:
 *   M1  ReplayEngine + AsOfMarketData + HistoricalMarketReader
 *   M4  perp agents + composeSignal + createSignal
 *   M6c1 planTrade → TradeSetup
 *   M6c2 createPrediction (isShadow = false — these are REAL predictions about the past,
 *        distinguishable by outcomeResolution = CANDLE_1M_CONSERVATIVE)
 *   M6c4 resolvePrediction(mode='CANDLE_1M_CONSERVATIVE') + Brain wiring
 *   M5  updateSetupMemory / recordSetupOutcome / recordAgentOutcome (called by resolver)
 *
 * NO LOOK-AHEAD (rules 11/21/22): every read goes through ReplayEngine's `AsOfMarketData` view;
 * the resolver reads only bars ≤ horizonEnd (its own responsibility, tested in change 4).
 *
 * WHY SEEDED PREDICTIONS ARE REAL, NOT SHADOWS: `isShadow` marks §18 Judge-override
 * counterfactuals ("what if we had gone the other way"). A seeded prediction IS a prediction the
 * system would have made had it been running, resolved against what actually happened. Storing
 * them as shadows would corrupt that column before M7 ever uses it. They stay distinguishable
 * from live predictions by `predictionOutcome.outcomeResolution = CANDLE_1M_CONSERVATIVE`,
 * which §21 mandates for reporting anyway.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';
import { perpAgents } from '@tip/agents';
import { createLogger } from '@tip/domain';
import { marketSymbol, type MarketSymbol } from '@tip/domain';
import { ValidationError } from '@tip/domain';
import { ReplayEngine, resolvePrediction, planningHorizonFor } from '@tip/evaluation';
import { EVENT_NAMES } from '@tip/events';
import { createPrediction } from '@tip/predictions';
import {
  composeSignal, computeConfidence, createSignal, signalFingerprint,
  PRIMARY_TF, SIGNAL_TTL_MS,
  type AgentContext, type Domain, type ScoringConfig, type TradingStyle,
} from '@tip/trading-agents';
import { planTrade, tradeDirection } from '@tip/planner';
import { prediction, scoringConfig, tradingAgent, type Db } from '@tip/database';
import { readCheckpoint, writeCheckpoint } from './checkpoint.js';

const log = createLogger('seed');

export interface SeedOptions {
  db: Db;
  tradingAgentId: string;
  symbols: readonly string[];
  from: Date;
  to: Date;
  /** When true, do NO writes — report what would have happened. Useful for gate-sizing. */
  dryRun?: boolean;
  /** Cap per-symbol replay steps so a runaway run stays bounded. */
  maxStepsPerSymbol?: number;
}

export interface SeedStats {
  readonly symbol: string;
  readonly stepsWalked: number;
  readonly signalsCreated: number;
  readonly predictionsCreated: number;
  readonly outcomesResolved: number;
  readonly noTrades: number;
  readonly skippedNeutral: number;
  readonly checkpointCursor: Date | null;
  readonly errors: number;
}

/** Read the TradingAgent's active config + style — the ScoringConfig table stores it. */
async function loadAgentSnapshot(db: Db, tradingAgentId: string): Promise<{ style: TradingStyle; domain: Domain; config: ScoringConfig; configVersion: number }> {
  const a = (await db.select().from(tradingAgent).where(eq(tradingAgent.id, tradingAgentId)).limit(1))[0];
  if (!a) throw new ValidationError(`tradingAgent ${tradingAgentId} not found`);
  if (a.domain !== 'perp') {
    throw new ValidationError(`seedBrain: perp only (§25 — memecoin is scoped out of historical backtest in MVP)`);
  }
  const cfgRow = (await db.select().from(scoringConfig)
    .where(and(eq(scoringConfig.tradingAgentId, tradingAgentId), eq(scoringConfig.active, true)))
    .limit(1))[0];
  if (!cfgRow) throw new ValidationError(`tradingAgent ${tradingAgentId} has no active scoringConfig`);
  return {
    style: a.tradingStyle as TradingStyle,
    domain: 'perp',
    config: cfgRow.config as ScoringConfig,
    configVersion: cfgRow.version,
  };
}

/** Build an AgentContext bound to `now` — walletScoreAsOf is inert for perp (no wallet input). */
function buildCtx(db: Db, agentId: string, configVersion: number, primaryTf: string, now: Date): AgentContext {
  return {
    db, now, tradingAgentId: agentId, configVersion, domain: 'perp',
    primaryTf: primaryTf as AgentContext['primaryTf'],
    walletScoreAsOf: async () => null,
    activeClusterMap: async () => new Map(),
  };
}

/**
 * Seed the perp Brain for ONE symbol over `[from, to]`. Composition of the M1–M6 pieces above.
 *
 * On every primary-TF bar close:
 *   1. Synthesize a `perp.kline.closed` event carrying the bar's fields (matches M1's shape).
 *   2. Every CADENCE / CONDITIONAL perp agent that canHandle it runs against the AsOfMarketData
 *      view — the SAME reads live agents make, no look-ahead by construction (§25).
 *   3. Compose the composite; if the direction reaches at least WEAK_LONG/WEAK_SHORT and the
 *      planner returns a TRADE, create a Signal + Prediction (isShadow=false; seeded rows are
 *      REAL predictions about the past).
 *   4. Resolve immediately in `CANDLE_1M_CONSERVATIVE` mode — the horizon is closed by definition
 *      when we're seeding history. Feeds the Brain per M5.
 */
export async function seedSymbol(opts: SeedOptions & { symbol: string }): Promise<SeedStats> {
  if (opts.dryRun) log.info('dry-run: no writes will land');
  const agent = await loadAgentSnapshot(opts.db, opts.tradingAgentId);
  const primaryTf = PRIMARY_TF[agent.style];
  const symbol = marketSymbol(opts.symbol) as MarketSymbol;

  // Resume from checkpoint if any — cursor is the last COMPLETED bar close.
  const cp = await readCheckpoint(opts.db, { symbol: opts.symbol, style: agent.style, agentId: opts.tradingAgentId });
  const rangeFrom = cp && cp.cursor > opts.from ? cp.cursor : opts.from;

  const engine = new ReplayEngine(opts.db);
  const stats = {
    symbol: opts.symbol, stepsWalked: 0, signalsCreated: 0, predictionsCreated: 0,
    outcomesResolved: 0, noTrades: 0, skippedNeutral: 0, errors: 0,
    checkpointCursor: cp?.cursor ?? null as Date | null,
  };
  const cap = opts.maxStepsPerSymbol ?? Infinity;

  for await (const step of engine.replay({ symbol, primaryTf, from: rangeFrom, to: opts.to })) {
    if (stats.stepsWalked >= cap) break;
    stats.stepsWalked++;
    // Advance the checkpoint FIRST — every bar we saw counts even if this step produced no
    // signal, no prediction, or was a fingerprint dedup. Resuming skips it and we don't loop
    // back over silent bars.
    stats.checkpointCursor = step.bar.closeTime;
    if (!opts.dryRun) {
      await writeCheckpoint(opts.db, {
        symbol: opts.symbol, style: agent.style, agentId: opts.tradingAgentId,
        cursor: step.bar.closeTime, writtenAt: new Date(),
      });
    }
    try {
      // Synthesize the CADENCE trigger. Bar shape matches m1-bybit-adapter's payload — one
      // parser, one behaviour (§12), so downstream agents cannot tell live from replayed.
      const evt = {
        id: `seed-${randomUUID()}`,
        type: EVENT_NAMES.PERP_KLINE_CLOSED,
        version: 1,
        eventTime: step.bar.closeTime.toISOString(),
        processingTime: step.asOf.toISOString(),
        source: 'seed-brain',
        payload: {
          symbol, timeframe: primaryTf,
          openTime: step.bar.openTime, closeTime: step.bar.closeTime,
          open: step.bar.open, high: step.bar.high, low: step.bar.low, close: step.bar.close,
          volume: step.bar.volume, turnover: step.bar.turnover ?? undefined,
          eventTime: step.bar.closeTime.toISOString(),
          processingTime: step.asOf.toISOString(),
          confirm: true,
        },
      };

      // Run every agent that handles this event; skip returns are legitimate (dead candles per
      // §40.1, positioning without a poll, etc.).
      const ctx = buildCtx(opts.db, opts.tradingAgentId, agent.configVersion, primaryTf, step.asOf);
      const outputs: Awaited<ReturnType<typeof perpAgents[number]['analyze']>>[] = [];
      for (const a of perpAgents) {
        if (!a.canHandle(evt)) continue;
        const out = await a.analyze(evt, ctx);
        if (out) outputs.push(out);
      }
      if (outputs.length === 0) continue;

      const composite = composeSignal(
        outputs.filter((o): o is NonNullable<typeof o> => o !== null),
        agent.config.agentWeights, agent.config.signalThresholds, 'perp',
      );
      if (!composite) continue;
      const dir = tradeDirection(composite.direction);
      if (!dir) { stats.skippedNeutral++; continue; }

      const confidence = computeConfidence(
        { compositeScore: composite.compositeScore, agentAgreement: composite.agentAgreement },
        agent.config.confidenceWeights,
      );
      const fingerprint = signalFingerprint({
        tradingAgentId: opts.tradingAgentId, symbol: opts.symbol,
        direction: composite.direction, primaryTfCloseAt: step.bar.closeTime,
      });

      if (opts.dryRun) {
        // In dry-run mode we still walk the planner to gauge feasibility, but write nothing.
        const plan = await planTrade(
          { symbol: opts.symbol, domain: 'perp', direction: composite.direction },
          { style: agent.style, config: agent.config, configVersion: agent.configVersion,
            balance: 10_000, view: step.data },
        );
        if (plan.kind === 'NO_TRADE') stats.noTrades++;
        continue;
      }

      // Real seed: create Signal in CONSUMED state so createPrediction's ACTIVE-check would
      // otherwise reject it. Trick: create ACTIVE, then let createPrediction consume it — same
      // path live signals take.
      const createdAt = step.bar.closeTime; // seeded rows carry TRUE historical dates (§25)
      const expiresAt = new Date(createdAt.getTime() + SIGNAL_TTL_MS[agent.style]['perp']);
      const sigRes = await createSignal(opts.db, {
        tradingAgentId: opts.tradingAgentId, symbol: opts.symbol, domain: 'perp',
        direction: composite.direction, compositeScore: composite.compositeScore, confidence,
        createdAt, expiresAt,
        configVersion: agent.configVersion, fingerprint,
        evidence: { agentAgreement: composite.agentAgreement, contributingCount: composite.contributingCount, contributions: composite.contributions },
        contributions: outputs.filter((o): o is NonNullable<typeof o> => o !== null),
      });
      if (!sigRes.created || !sigRes.signalId) continue; // fingerprint dedup — the same bar seen twice
      stats.signalsCreated++;

      const plan = await planTrade(
        { symbol: opts.symbol, domain: 'perp', direction: composite.direction },
        { style: agent.style, config: agent.config, configVersion: agent.configVersion,
          balance: 10_000, view: step.data },
      );
      if (plan.kind === 'NO_TRADE') { stats.noTrades++; continue; }

      const predRes = await createPrediction(opts.db, {
        signalId: sigRes.signalId, tradingAgentId: opts.tradingAgentId,
        setup: plan.setup, signalScore: composite.compositeScore, confidence,
        direction: composite.direction, features: composite.contributions.map((c) => ({
          agent: c.agent, agentVersion: c.agentVersion, contribution: c.contribution, weight: c.weight,
          score: outputs.find((o) => o?.agent === c.agent)?.score ?? 0,
        })),
      });
      if (!predRes.created) continue;
      stats.predictionsCreated++;

      // T1 (fill) = the bar's close time — seeded runs fill "at" the same close the signal
      // emerged from, matching the T1 anchoring §21 mandates for live outcomes. No paper
      // position row is written (§25 seeding does not open paper positions — it just resolves
      // the counterfactual and feeds the Brain), so the outcome resolver falls back to using
      // `prediction.createdAt` as T1, which IS the bar close here — same anchor.
      const written = await resolvePrediction(opts.db, {
        predictionId: predRes.prediction.id,
        now: opts.to,
        mode: 'CANDLE_1M_CONSERVATIVE',
        style: agent.style,
      });
      stats.outcomesResolved += written;
    } catch (e) {
      stats.errors++;
      log.warn('seed step failed', { symbol: opts.symbol, at: step.asOf.toISOString(), err: String(e) });
    }

  }

  log.info('seed done', stats);
  return stats;
}

/** Seed multiple symbols sequentially — Bybit historical data isn't cross-symbol dependent. */
export async function seedBrain(opts: SeedOptions): Promise<{ perSymbol: SeedStats[] }> {
  const perSymbol: SeedStats[] = [];
  for (const sym of opts.symbols) {
    perSymbol.push(await seedSymbol({ ...opts, symbol: sym }));
  }
  return perSymbol.length === 0 ? { perSymbol: [] } : { perSymbol };
}
