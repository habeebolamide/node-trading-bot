/**
 * Judge tier (§18, §40.14, M7 wiring). Two processors on the signal-processing queue:
 *
 *   1. `signal.created` → run the Judge agent → publish `judge.evaluation.completed`.
 *      Perp only; the Judge agent itself refuses memecoin (§40.14). Risk-INVALIDATED signals
 *      short-circuit (the Judge agent's canHandle already checks). LLM failure → the agent
 *      returns null → NO judge event → the gate DEFERs by absence (§18 graceful degradation).
 *
 *   2. `judge.evaluation.completed` → `handleJudgeEvaluation` (the m7-override-gate consumer):
 *      AGREE/DEFER → deterministic prediction; FLIP → re-plan for the Judge direction, create
 *      the Judge-direction prediction (or downgrade to DEFER if the planner refuses);
 *      STAND_ASIDE → INVALIDATE the signal, no real trade.
 *
 * The Judge needs a DeepSeek client. If `DEEPSEEK_API_KEY` is unset the whole tier is a no-op —
 * §18: "LLM down = trades without narrative or override capability." The deterministic
 * prediction path (a separate consumer) still creates predictions.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { scoringConfig, tradingAgent } from '@tip/database';
import type { DomainEvent } from '@tip/domain';
import type { EventBus } from '@tip/events';
import { EVENT_NAMES, QUEUE_NAMES } from '@tip/events';
import { AsOfMarketData } from '@tip/evaluation';
import type { DeepSeekClient } from '@tip/llm';
import { planTrade } from '@tip/planner';
import { createJudgeAgent, handleJudgeEvaluation } from '@tip/agents';
import type { AgentContext } from '@tip/trading-agents';

interface SignalCreatedPayload {
  signalId: string; tradingAgentId: string; symbol: string; domain: 'perp' | 'memecoin';
  direction: string; compositeScore: number; confidence: number; configVersion: number; expiresAt: string;
}

export interface JudgeTierDeps {
  db: Db;
  bus: EventBus;
  llm: DeepSeekClient;
  log?: (msg: string, meta?: unknown) => void;
}

/**
 * Build the tier's two handlers WITHOUT registering queue workers. Multiple BullMQ workers on
 * one queue COMPETE for jobs, and the signal-processing queue has several concerns (Judge, gate,
 * convergence, alerts) — main.ts owns the single dispatcher that fans out to all of them
 * (audit #11/#12 dispatcher fix; the registry.ts doc prescribes exactly this composition).
 */
export function createJudgeTierHandlers(deps: JudgeTierDeps): {
  judgeHandler: (event: DomainEvent<SignalCreatedPayload>) => Promise<void>;
  gateHandler: (event: DomainEvent) => Promise<void>;
} {
  const log = deps.log ?? (() => {});
  const judge = createJudgeAgent({ llm: deps.llm, bus: deps.bus });

  // 1. signal.created → Judge
  const judgeHandler = async (event: DomainEvent<SignalCreatedPayload>): Promise<void> => {
    if (event.type !== EVENT_NAMES.SIGNAL_CREATED) return;
    if (event.payload.domain !== 'perp') return; // Judge is perp-only (§40.14)
    const p = event.payload;
    const a = (await deps.db.select().from(tradingAgent).where(eq(tradingAgent.id, p.tradingAgentId)).limit(1))[0];
    if (!a) return;
    const cfg = (await deps.db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, p.tradingAgentId), eq(scoringConfig.active, true))).limit(1))[0];
    if (!cfg) return;
    const ctx: AgentContext = {
      db: deps.db, now: new Date(), tradingAgentId: p.tradingAgentId, configVersion: p.configVersion,
      domain: 'perp', primaryTf: '1h', walletScoreAsOf: async () => null, activeClusterMap: async () => new Map(),
    };
    try {
      // The Judge agent reads evidence, calls the LLM, and (via its injected bus) publishes
      // judge.evaluation.completed itself. If it returns null (LLM failure / memecoin), nothing
      // downstream fires — the deterministic path already created / will create the prediction.
      await judge.analyze(event, ctx);
    } catch (e) {
      log('judge failed; deterministic path unaffected', { signalId: p.signalId, err: String(e) });
    }
  };

  // 2. judge.evaluation.completed → gate
  const gateHandler = async (event: DomainEvent): Promise<void> => {
    if (event.type !== EVENT_NAMES.JUDGE_EVALUATION_COMPLETED) return;
    await handleJudgeEvaluation(
      {
        db: deps.db,
        bus: deps.bus,
        runFlipPlanner: async (input) => {
          const plan = await planTrade(
            { symbol: input.symbol, domain: 'perp', direction: input.judgeDirection as 'STRONG_LONG' },
            { style: input.style, config: input.config, configVersion: input.configVersion, balance: 10_000, view: input.view },
          );
          return plan.kind === 'TRADE'
            ? { ok: true as const, direction: input.judgeDirection }
            : { ok: false as const, reason: plan.reason };
        },
      },
      event as DomainEvent<Parameters<typeof handleJudgeEvaluation>[1]['payload']>,
      async (signalId) => {
        // Provide an as-of view for the FLIP re-plan. Bound to now (the gate runs at signal time).
        void signalId; void scoringConfig;
        return new AsOfMarketData(deps.db, new Date());
      },
    );
  };

  return { judgeHandler, gateHandler };
}

/**
 * Register the tier with its OWN workers. Only for processes where nothing else consumes the
 * signal-processing queue (tests) — the main worker composes `createJudgeTierHandlers` into its
 * shared dispatcher instead.
 */
export function registerJudgeTier(deps: JudgeTierDeps): void {
  const { judgeHandler, gateHandler } = createJudgeTierHandlers(deps);
  deps.bus.createWorker<SignalCreatedPayload>(QUEUE_NAMES.SIGNAL_PROCESSING, judgeHandler);
  deps.bus.createWorker(QUEUE_NAMES.SIGNAL_PROCESSING, gateHandler);
}
