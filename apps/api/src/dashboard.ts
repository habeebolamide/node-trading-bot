/**
 * Dashboard read routes (m8-api-surface). All GET, all JSON, all projecting M6/M7 read helpers
 * verbatim. Every route responds with the exact shape the underlying helper returns — no new
 * DTOs so the dashboard can type against the exported helper types directly.
 *
 * Nothing here writes. Rule 20 (paper only) is trivially satisfied; §33 rule 16 (config
 * versioning) means config edits stay CLI-only in MVP — reviewable like code.
 */
import { Router, type Request, type Response } from 'express';
import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '@tip/database';
import {
  brainAgentMemory, brainTokenMemory, clusterRun, domainEvent,
  judgeDecision, learningHypothesis, llmCallLog,
  paperPortfolio, paperPosition, prediction, predictionOutcome, signal, signalFeature,
  signalNoTrade, signalRisk, token, tradeAutopsy, tradingAgent, wallet, walletCluster,
} from '@tip/database';
import { createBrain, tokenMemoryAsOf, type Domain } from '@tip/brain';
import {
  byHorizon, calibrationSummary, compareShadowVsBaseline, compareShadowVsReal,
  evaluateFold, factorPredictiveValue, headlineMetrics, isBootstrapping, walkForwardFolds,
} from '@tip/evaluation';

type H = (req: Request, res: Response) => Promise<void> | void;

function asNumber(v: unknown, fallback?: number): number | undefined {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asDate(v: unknown, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? fallback : d;
}
function asString(v: unknown, fallback?: string): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/** All dashboard routes under /api. */
export function dashboardRouter(db: Db): Router {
  const r = Router();

  // ── PREDICTIONS ─────────────────────────────────────────────────────
  const listPredictions: H = async (req, res) => {
    const agentId = asString(req.query.agentId);
    const domain = asString(req.query.domain) as Domain | undefined;
    const from = req.query.from ? asDate(req.query.from, new Date(0)) : undefined;
    const to = req.query.to ? asDate(req.query.to, new Date()) : undefined;
    const limit = Math.min(500, asNumber(req.query.limit, 50)!);
    const offset = Math.max(0, asNumber(req.query.offset, 0)!);
    const conds = [] as ReturnType<typeof eq>[];
    if (agentId) conds.push(eq(prediction.tradingAgentId, agentId));
    if (domain) conds.push(eq(prediction.domain, domain));
    if (from) conds.push(gte(prediction.createdAt, from));
    if (to) conds.push(lte(prediction.createdAt, to));
    const where = conds.length ? and(...conds) : undefined;
    // LEFT JOIN paper_position (the position that this prediction opened, if any) so the row
    // carries close_reason + realized_pnl + closed_at without a second round-trip. Positions
    // are unique on prediction_id, so this is a scalar join.
    const rows = await db.select({
      // prediction cols
      id: prediction.id, tradingAgentId: prediction.tradingAgentId, signalId: prediction.signalId,
      agentName: tradingAgent.name,
      domain: prediction.domain, symbol: prediction.symbol, direction: prediction.direction,
      score: prediction.score, confidence: prediction.confidence, horizon: prediction.horizon,
      entry: prediction.entry, stopLoss: prediction.stopLoss, takeProfit: prediction.takeProfit,
      positionSize: prediction.positionSize, notional: prediction.notional,
      leverage: prediction.leverage, requiredMargin: prediction.requiredMargin,
      riskReward: prediction.riskReward, thesis: prediction.thesis,
      isShadow: prediction.isShadow, shadowOf: prediction.shadowOf,
      configVersion: prediction.configVersion, createdAt: prediction.createdAt,
      // Position outcome (nullable — the LIVE path opens one via the entry orchestrator).
      positionState: paperPosition.state, closeReason: paperPosition.closeReason,
      closedAt: paperPosition.closedAt, realizedPnl: paperPosition.realizedPnl,
      // Seeded-outcome fallback: `npm run seed-brain` resolves predictions directly against
      // 1m candles WITHOUT opening a paper position (§25 seeding does not open positions —
      // it just feeds the Brain). Those outcomes live in prediction_outcome. Joining on the
      // primary horizon lets the UI render the seeded WIN/LOSS + return alongside real trades.
      outcomeWon: predictionOutcome.won,
      outcomeReturnPct: predictionOutcome.returnPct,
      outcomeHitTarget: predictionOutcome.hitTarget,
      outcomeResolution: predictionOutcome.outcomeResolution,
      outcomeResolvedAt: predictionOutcome.resolvedAt,
    })
      .from(prediction)
      .innerJoin(tradingAgent, eq(tradingAgent.id, prediction.tradingAgentId))
      .leftJoin(paperPosition, eq(paperPosition.predictionId, prediction.id))
      .leftJoin(predictionOutcome, and(
        eq(predictionOutcome.predictionId, prediction.id),
        eq(predictionOutcome.horizon, prediction.horizon),
      ))
      .where(where)
      .orderBy(desc(prediction.createdAt))
      .limit(limit).offset(offset);
    const [totalRow] = await db.select({ n: count() }).from(prediction).where(where);
    res.json({ rows, total: Number(totalRow?.n ?? 0), limit, offset });
  };
  r.get('/predictions', listPredictions);

  r.get('/predictions/:id', async (req, res) => {
    const row = (await db.select().from(prediction).where(eq(prediction.id, req.params.id)).limit(1))[0];
    if (!row) { res.status(404).json({ error: 'not found' }); return; }
    const [outcomes, position] = await Promise.all([
      db.select().from(predictionOutcome).where(eq(predictionOutcome.predictionId, row.id)),
      db.select().from(paperPosition).where(eq(paperPosition.predictionId, row.id)).limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    res.json({ prediction: row, outcomes, position });
  });

  r.get('/predictions/:id/attribution', async (req, res) => {
    // §22 attribution: the signal_feature rows for the source signal.
    const p = (await db.select().from(prediction).where(eq(prediction.id, req.params.id)).limit(1))[0];
    if (!p) { res.status(404).json({ error: 'not found' }); return; }
    const features = await db.select().from(signalFeature).where(eq(signalFeature.signalId, p.signalId));
    const risk = (await db.select().from(signalRisk).where(eq(signalRisk.signalId, p.signalId)).limit(1))[0] ?? null;
    const judge = (await db.select().from(judgeDecision).where(eq(judgeDecision.signalId, p.signalId)).limit(1))[0] ?? null;
    res.json({ predictionId: p.id, features, risk, judge });
  });

  r.get('/predictions/:id/autopsy', async (req, res) => {
    const rows = await db.select().from(tradeAutopsy).where(eq(tradeAutopsy.predictionId, req.params.id)).limit(1);
    if (rows.length === 0) { res.status(404).json({ error: 'no autopsy for this prediction' }); return; }
    res.json(rows[0]!);
  });

  // ── METRICS ────────────────────────────────────────────────────────
  r.get('/metrics/headline', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const configVersion = asNumber(req.query.configVersion);
    const horizon = asString(req.query.horizon);
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || configVersion === undefined || !horizon) {
      res.status(400).json({ error: 'domain, configVersion, horizon are required' }); return;
    }
    const m = await headlineMetrics(db, { domain, configVersion, horizon, asOf });
    res.json(m);
  });

  r.get('/metrics/by-horizon', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const configVersion = asNumber(req.query.configVersion);
    const horizonsStr = asString(req.query.horizons);
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || configVersion === undefined || !horizonsStr) {
      res.status(400).json({ error: 'domain, configVersion, horizons (comma-separated) are required' }); return;
    }
    const horizons = horizonsStr.split(',').map((s) => s.trim()).filter(Boolean);
    const rows = await byHorizon(db, { domain, configVersion, asOf, horizons });
    res.json({ rows });
  });

  r.get('/metrics/calibration', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const configVersion = asNumber(req.query.configVersion);
    const horizon = asString(req.query.horizon);
    const bins = asNumber(req.query.bins, 10)!;
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || configVersion === undefined || !horizon) {
      res.status(400).json({ error: 'domain, configVersion, horizon are required' }); return;
    }
    // Compose (confidence, won) points from prediction + prediction_outcome.
    const rows = await db.select({
      confidence: prediction.confidence,
      won: predictionOutcome.won,
    })
      .from(prediction)
      .innerJoin(predictionOutcome, eq(prediction.id, predictionOutcome.predictionId))
      .where(and(
        eq(prediction.domain, domain),
        eq(prediction.configVersion, configVersion),
        eq(predictionOutcome.horizon, horizon),
        lte(prediction.createdAt, asOf),
      ));
    const points = rows.map((r) => ({ confidence: Number(r.confidence), won: r.won }));
    res.json(calibrationSummary(points, bins));
  });

  r.get('/metrics/factor', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const agentKey = asString(req.query.agentKey);
    const configVersion = asNumber(req.query.configVersion);
    const horizon = asString(req.query.horizon, '1h');
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || !agentKey || configVersion === undefined) {
      res.status(400).json({ error: 'domain, agentKey, configVersion are required' }); return;
    }
    const fpv = await factorPredictiveValue(db, {
      domain, agentKey, configVersion, asOf, ...(horizon ? { horizon } : {}),
    });
    res.json(fpv);
  });

  r.get('/metrics/bootstrap', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const configVersion = asNumber(req.query.configVersion);
    const horizon = asString(req.query.horizon);
    const minN = asNumber(req.query.minN);
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || configVersion === undefined || !horizon) {
      res.status(400).json({ error: 'domain, configVersion, horizon are required' }); return;
    }
    res.json(await isBootstrapping(db, { domain, configVersion, horizon, asOf, ...(minN !== undefined ? { minN } : {}) }));
  });

  r.get('/metrics/shadow/vs-real', async (req, res) => {
    const configVersion = asNumber(req.query.configVersion);
    const horizon = asString(req.query.horizon, '4h')!;
    const asOf = asDate(req.query.asOf, new Date());
    if (configVersion === undefined) { res.status(400).json({ error: 'configVersion required' }); return; }
    res.json(await compareShadowVsReal(db, { configVersion, horizon, asOf }));
  });

  r.get('/metrics/shadow/vs-baseline', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const configVersion = asNumber(req.query.configVersion);
    const horizon = asString(req.query.horizon, '4h')!;
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || configVersion === undefined) {
      res.status(400).json({ error: 'domain and configVersion required' }); return;
    }
    res.json(await compareShadowVsBaseline(db, { domain, configVersion, horizon, asOf }));
  });

  // ── HYPOTHESES ─────────────────────────────────────────────────────
  r.get('/hypotheses', async (req, res) => {
    const status = asString(req.query.status);
    const setupId = asString(req.query.setupId);
    const limit = asNumber(req.query.limit, 200)!;
    const conds = [] as ReturnType<typeof eq>[];
    if (status) conds.push(eq(learningHypothesis.status, status));
    if (setupId) conds.push(eq(learningHypothesis.setupId, setupId));
    const rows = await db.select().from(learningHypothesis)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(learningHypothesis.createdAt))
      .limit(limit);
    res.json({ rows });
  });

  r.get('/hypotheses/:id', async (req, res) => {
    const row = (await db.select().from(learningHypothesis).where(eq(learningHypothesis.id, req.params.id)).limit(1))[0];
    if (!row) { res.status(404).json({ error: 'not found' }); return; }
    res.json(row);
  });

  // ── AUTOPSIES ──────────────────────────────────────────────────────
  r.get('/autopsies', async (req, res) => {
    const setupId = asString(req.query.setupId);
    const status = asString(req.query.status);
    const outcome = asString(req.query.outcome);
    const limit = asNumber(req.query.limit, 50)!;
    const offset = asNumber(req.query.offset, 0)!;
    const conds = [] as ReturnType<typeof eq>[];
    if (setupId) conds.push(eq(tradeAutopsy.setupId, setupId));
    if (status) conds.push(eq(tradeAutopsy.status, status));
    if (outcome) conds.push(eq(tradeAutopsy.outcome, outcome));
    const where = conds.length ? and(...conds) : undefined;
    const [rows, totalRow] = await Promise.all([
      db.select().from(tradeAutopsy).where(where)
        .orderBy(desc(tradeAutopsy.createdAt)).limit(limit).offset(offset),
      db.select({ n: count() }).from(tradeAutopsy).where(where),
    ]);
    res.json({ rows, total: Number(totalRow[0]?.n ?? 0), limit, offset });
  });

  // ── BRAIN ──────────────────────────────────────────────────────────
  r.get('/brain/setup', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const featuresParam = asString(req.query.features);
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || !featuresParam) {
      res.status(400).json({ error: 'domain and features (JSON) required' }); return;
    }
    try {
      const features = JSON.parse(featuresParam);
      const brain = createBrain(db, domain);
      res.json(await brain.setup(features, asOf));
    } catch (e) {
      res.status(400).json({ error: `features JSON invalid: ${String(e)}` });
    }
  });

  r.get('/brain/agent', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const agentKey = asString(req.query.agentKey);
    const version = asNumber(req.query.version);
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain || !agentKey || version === undefined) {
      res.status(400).json({ error: 'domain, agentKey, version required' }); return;
    }
    res.json(await createBrain(db, domain).agent(agentKey, version, asOf));
  });

  r.get('/brain/agents', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    if (!domain) { res.status(400).json({ error: 'domain required' }); return; }
    const rows = await db.select().from(brainAgentMemory).where(eq(brainAgentMemory.domain, domain));
    res.json({ rows });
  });

  r.get('/brain/market', async (req, res) => {
    const domain = asString(req.query.domain) as Domain | undefined;
    const asOf = asDate(req.query.asOf, new Date());
    if (!domain) { res.status(400).json({ error: 'domain required' }); return; }
    res.json(await createBrain(db, domain).market(asOf));
  });

  r.get('/brain/wallet/:walletId', async (req, res) => {
    const domain = asString(req.query.domain, 'memecoin') as Domain;
    const asOf = asDate(req.query.asOf, new Date());
    if (domain !== 'memecoin') { res.status(400).json({ error: 'wallet memory is memecoin-only' }); return; }
    res.json(await createBrain(db, 'memecoin').wallet(req.params.walletId, asOf));
  });

  // ── SIGNALS ────────────────────────────────────────────────────────
  r.get('/signals', async (req, res) => {
    const agentId = asString(req.query.agentId);
    const state = asString(req.query.state);
    const domain = asString(req.query.domain);
    const limit = asNumber(req.query.limit, 200)!;
    const conds = [] as ReturnType<typeof eq>[];
    if (agentId) conds.push(eq(signal.tradingAgentId, agentId));
    if (state) conds.push(eq(signal.state, state));
    if (domain) conds.push(eq(signal.domain, domain));
    const rows = await db.select().from(signal)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(signal.createdAt))
      .limit(limit);
    res.json({ rows });
  });

  r.get('/signals/:id', async (req, res) => {
    const s = (await db.select().from(signal).where(eq(signal.id, req.params.id)).limit(1))[0];
    if (!s) { res.status(404).json({ error: 'not found' }); return; }
    const features = await db.select().from(signalFeature).where(eq(signalFeature.signalId, s.id));
    const risk = (await db.select().from(signalRisk).where(eq(signalRisk.signalId, s.id)).limit(1))[0] ?? null;
    const noTrade = (await db.select().from(signalNoTrade).where(eq(signalNoTrade.signalId, s.id)).limit(1))[0] ?? null;
    const judge = (await db.select().from(judgeDecision).where(eq(judgeDecision.signalId, s.id)).limit(1))[0] ?? null;
    res.json({ signal: s, features, risk, noTrade, judge });
  });

  // ── PORTFOLIOS ─────────────────────────────────────────────────────
  r.get('/portfolios', async (req, res) => {
    const agentId = asString(req.query.agentId);
    const rows = await db.select().from(paperPortfolio)
      .where(agentId ? eq(paperPortfolio.tradingAgentId, agentId) : undefined)
      .orderBy(desc(paperPortfolio.updatedAt));
    res.json({ rows });
  });

  r.get('/portfolios/:id/positions', async (req, res) => {
    const state = asString(req.query.state);
    const conds = [eq(paperPosition.portfolioId, req.params.id)];
    if (state) conds.push(eq(paperPosition.state, state));
    const rows = await db.select().from(paperPosition)
      .where(and(...conds))
      .orderBy(desc(paperPosition.openedAtProcessing))
      .limit(500);
    res.json({ rows });
  });

  // ── OVERVIEW ───────────────────────────────────────────────────────
  // ── BACKTEST (audit #15, §26) — walk-forward folds + per-fold TEST-window metrics ──────
  r.get('/backtest/walk-forward', async (req, res) => {
    const to = asDate(req.query.to, new Date());
    const from = asDate(req.query.from, new Date(to.getTime() - 180 * 24 * 3600_000));
    const configVersion = asNumber(req.query.configVersion, 1)!;
    const horizon = asString(req.query.horizon, '4h')!;
    const trainDays = asNumber(req.query.trainDays, 60)!;
    const testDays = asNumber(req.query.testDays, 20)!;
    try {
      const folds = walkForwardFolds('perp', { from, to, trainDays, testDays });
      const rows = await Promise.all(folds.map(async (fold) => ({
        fold,
        metrics: await evaluateFold(db, { fold, configVersion, horizon }),
      })));
      res.json({ folds: rows, configVersion, horizon, from, to });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── LLM COSTS (audit #17, §23) — "is the LLM worth it" needs the ledger visible ────────
  r.get('/llm/costs', async (req, res) => {
    const days = asNumber(req.query.days, 30)!;
    const since = new Date(Date.now() - days * 24 * 3600_000);
    const [byAgent, byDay, totals] = await Promise.all([
      db.select({
        agent: llmCallLog.agent,
        calls: count(),
        cost: sql<string>`coalesce(sum(${llmCallLog.cost}), 0)`,
        promptTokens: sql<string>`coalesce(sum(${llmCallLog.promptTokens}), 0)`,
        completionTokens: sql<string>`coalesce(sum(${llmCallLog.completionTokens}), 0)`,
        failures: sql<string>`count(*) filter (where not ${llmCallLog.success})`,
        avgLatencyMs: sql<string>`coalesce(avg(${llmCallLog.latencyMs}), 0)`,
      }).from(llmCallLog).where(gte(llmCallLog.calledAt, since)).groupBy(llmCallLog.agent),
      db.select({
        day: sql<string>`date_trunc('day', ${llmCallLog.calledAt})`,
        calls: count(),
        cost: sql<string>`coalesce(sum(${llmCallLog.cost}), 0)`,
      }).from(llmCallLog).where(gte(llmCallLog.calledAt, since))
        .groupBy(sql`date_trunc('day', ${llmCallLog.calledAt})`)
        .orderBy(sql`date_trunc('day', ${llmCallLog.calledAt})`),
      db.select({
        calls: count(),
        cost: sql<string>`coalesce(sum(${llmCallLog.cost}), 0)`,
      }).from(llmCallLog).where(gte(llmCallLog.calledAt, since)),
    ]);
    res.json({ days, totals: totals[0] ?? { calls: 0, cost: '0' }, byAgent, byDay });
  });

  // ── SMART MONEY (audit #19, §26/§27) — rated wallets, active clusters, recent activity ──
  r.get('/smart-money', async (_req, res) => {
    const [topWallets, activeRun, recentBuys, recentConvergences] = await Promise.all([
      // Latest score per rated wallet (append-only log → DISTINCT ON latest row, §4).
      db.execute(sql`
        SELECT DISTINCT ON (e.wallet_id) e.wallet_id AS "walletId", e.score, e.timestamp,
               w.trade_count AS "tradeCount", w.status
          FROM wallet_score_event e
          JOIN wallet w ON w.address = e.wallet_id
         ORDER BY e.wallet_id, e.timestamp DESC
      `),
      db.select().from(clusterRun).where(eq(clusterRun.status, 'active')).orderBy(desc(clusterRun.runAt)).limit(1),
      db.select().from(domainEvent)
        .where(eq(domainEvent.type, 'memecoin.wallet.buy.detected'))
        .orderBy(desc(domainEvent.eventTime)).limit(20),
      db.select().from(domainEvent)
        .where(eq(domainEvent.type, 'memecoin.wallet.convergence.detected'))
        .orderBy(desc(domainEvent.eventTime)).limit(20),
    ]);
    const run = activeRun[0] ?? null;
    const clusters = run
      ? await db.select({
          clusterId: walletCluster.clusterId,
          members: count(),
        }).from(walletCluster).where(eq(walletCluster.clusterRunId, run.runId))
          .groupBy(walletCluster.clusterId).orderBy(desc(count())).limit(50)
      : [];
    const wallets = ([...(topWallets as unknown as Iterable<Record<string, unknown>>)] as {
      walletId: string; score: string; timestamp: Date; tradeCount: number; status: string;
    }[]).sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 50);
    res.json({ wallets, clusterRun: run, clusters, recentBuys, recentConvergences });
  });

  // ── TOKENS (audit #20, §26) — browse top-scored tokens, not just point lookup ──────────
  r.get('/tokens/top', async (req, res) => {
    const limit = asNumber(req.query.limit, 50)!;
    const rows = await db.select({
      mint: brainTokenMemory.mint,
      score: brainTokenMemory.score,
      evidence: brainTokenMemory.evidence,
      outcomes: brainTokenMemory.outcomes,
      profile: brainTokenMemory.profile,
      updatedAt: brainTokenMemory.updatedAt,
      symbol: token.symbol,
      name: token.name,
    }).from(brainTokenMemory)
      .leftJoin(token, eq(token.mint, brainTokenMemory.mint))
      .orderBy(sql`${brainTokenMemory.score} DESC NULLS LAST`, desc(brainTokenMemory.updatedAt))
      .limit(limit);
    res.json({ tokens: rows, count: rows.length });
  });

  // BrainTokenMemory point lookup — the Tokens page previously (wrongly) hit /brain/wallet/:id.
  r.get('/brain/token/:mint', async (req, res) => {
    const memory = await tokenMemoryAsOf(db, req.params.mint, new Date());
    res.json(memory);
  });

  r.get('/overview', async (_req, res) => {
    // KPIs the dashboard's Overview page reads. Cheap counts + one recent aggregate.
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
    const [openSignals, recentSignals, recentPredictions, portfolios] = await Promise.all([
      db.select({ n: count() }).from(signal).where(eq(signal.state, 'ACTIVE')),
      db.select({ n: count() }).from(signal).where(gte(signal.createdAt, dayAgo)),
      db.select({ n: count() }).from(prediction).where(gte(prediction.createdAt, weekAgo)),
      db.select({ equity: paperPortfolio.equity, drawdown: paperPortfolio.maxDrawdown }).from(paperPortfolio),
    ]);
    const totalEquity = portfolios.reduce((a, p) => a + Number(p.equity ?? 0), 0);
    void inArray;
    res.json({
      openSignals: Number(openSignals[0]?.n ?? 0),
      signalsLast24h: Number(recentSignals[0]?.n ?? 0),
      predictionsLast7d: Number(recentPredictions[0]?.n ?? 0),
      portfolios: portfolios.length,
      totalEquity,
    });
  });

  return r;
}
