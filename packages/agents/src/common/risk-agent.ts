/**
 * Risk Agent (§40.12) — post-aggregation veto. Consumes `signal.created` events (published by
 * the Signal Engine in m4-signal-engine), evaluates the domain-appropriate check set, writes a
 * `signal_risk` row, and transitions the Signal to INVALIDATED if the level is INVALIDATED.
 *
 * Not in the composite (§7 rule) — this runs AFTER scoring, BEFORE downstream consumers
 * (Trade Planner M6, Judge M7). AgentPerformance still gets a row so the "how often did
 * INVALIDATED signals turn out to have been correctly invalidated?" question is answerable
 * once M7 shadow trades exist.
 */
import { eq } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { signal as signalTable, signalRisk } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { transitionSignal } from '@tip/trading-agents';
import {
  evaluateMemecoinRisk, evaluatePerpRisk, type MemecoinRiskInputs, type PerpRiskInputs, type RiskResult,
} from './risk-checks.js';

const KEY = 'risk';
const VERSION = 1;

/** Payload of a `signal.created` event (per m4-signal-engine SignalEngine.performFlush). */
interface SignalCreatedPayload {
  signalId: string;
  tradingAgentId: string;
  symbol: string;
  domain: 'perp' | 'memecoin';
  direction: string; // Direction from scoring.ts
  compositeScore: number;
  confidence: number;
  configVersion: number;
  expiresAt: string;
}

/**
 * Load-inputs seams — injectable so tests can drive the pipeline without a full DB fixture
 * for every scenario. Production wiring builds these from the M1/M4 rolling state + tables.
 */
export interface RiskInputLoaders {
  loadPerpInputs?: (p: SignalCreatedPayload) => Promise<PerpRiskInputs | null>;
  loadMemecoinInputs?: (p: SignalCreatedPayload) => Promise<MemecoinRiskInputs | null>;
}

export interface RiskAgentDeps extends RiskInputLoaders {
  bus?: EventBus;
  log?: (msg: string, meta?: unknown) => void;
}

/** Persist the risk verdict + transition the signal if INVALIDATED. Also broadcasts the outcome. */
async function applyRiskVerdict(
  ctx: AgentContext,
  signalId: string,
  domain: 'perp' | 'memecoin',
  result: RiskResult,
  bus?: EventBus,
): Promise<void> {
  await ctx.db
    .insert(signalRisk)
    .values({ signalId, riskLevel: result.level, riskFlags: result.flags, agentVersion: VERSION })
    .onConflictDoUpdate({
      target: signalRisk.signalId,
      set: { riskLevel: result.level, riskFlags: result.flags, agentVersion: VERSION, evaluatedAt: new Date() },
    });

  if (result.level === 'INVALIDATED') {
    await transitionSignal(ctx.db, signalId, 'INVALIDATED');
    if (bus) {
      await bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
        type: EVENT_NAMES.SIGNAL_INVALIDATED,
        eventTime: new Date().toISOString(),
        source: 'risk-agent',
        payload: { signalId, domain, reasons: result.flags },
      });
    }
  }
}

export function createRiskAgent(deps: RiskAgentDeps = {}): AnalysisAgent {
  const log = deps.log ?? (() => {});
  return {
    key: KEY,
    version: VERSION,
    trigger: 'EVENT',
    canHandle(event: DomainEvent) {
      return event.type === EVENT_NAMES.SIGNAL_CREATED;
    },
    async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
      const p = event.payload as SignalCreatedPayload;
      if (!p?.signalId) return null;

      // Skip if the signal was already invalidated by another path.
      const rows = await ctx.db.select({ state: signalTable.state }).from(signalTable).where(eq(signalTable.id, p.signalId)).limit(1);
      if (rows.length === 0 || rows[0]!.state !== 'ACTIVE') return null;

      let result: RiskResult | null = null;
      if (p.domain === 'perp' && deps.loadPerpInputs) {
        const inputs = await deps.loadPerpInputs(p);
        if (inputs) result = evaluatePerpRisk(inputs);
      } else if (p.domain === 'memecoin' && deps.loadMemecoinInputs) {
        const inputs = await deps.loadMemecoinInputs(p);
        if (inputs) result = evaluateMemecoinRisk(inputs);
      }
      if (!result) return null;

      await applyRiskVerdict(ctx, p.signalId, p.domain, result, deps.bus);
      log('risk verdict', { signalId: p.signalId, domain: p.domain, level: result.level, flags: result.flags });

      // Non-directional agent (§7 special-case): direction NEUTRAL, no composite contribution.
      return {
        agent: KEY,
        agentVersion: VERSION,
        direction: 'NEUTRAL',
        score: 0,
        confidence: 1,
        features: { signalId: p.signalId, riskLevel: result.level, riskFlags: result.flags, invalidated: result.level === 'INVALIDATED' },
      };
    },
  };
}
