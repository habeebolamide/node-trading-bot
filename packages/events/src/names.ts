/**
 * Canonical event names (§10). Lowercase-dotted, matched exactly — event names
 * are part of the plan's contract (CLAUDE.md — "Naming"). Declared in full here
 * so later milestones REFERENCE these constants, never re-declare a string.
 *
 * The first block is the §10 "Event Architecture" list verbatim. The second block
 * is the additional concrete events the Part IV Agent Catalog (§40) and the
 * lifecycle sections (§36) refer to — included because those sections use them by
 * name; they are not new invention.
 */
export const EVENT_NAMES = {
  // ── §10 Event Architecture list ───────────────────────────────
  WALLET_TRANSACTION_DETECTED: 'wallet.transaction.detected',
  WALLET_TRADE_DETECTED: 'wallet.trade.detected',
  WALLET_PROFILE_UPDATED: 'wallet.profile.updated',
  WALLET_SCORE_UPDATED: 'wallet.score.updated',

  TOKEN_ACTIVITY_DETECTED: 'token.activity.detected',
  TOKEN_PROFILE_UPDATED: 'token.profile.updated',

  MEMECOIN_WALLET_BUY_DETECTED: 'memecoin.wallet.buy.detected',
  MEMECOIN_WALLET_CONVERGENCE_DETECTED: 'memecoin.wallet.convergence.detected',
  MEMECOIN_WALLET_EXIT_DETECTED: 'memecoin.wallet.exit.detected',
  MEMECOIN_SIGNAL_CREATED: 'memecoin.signal.created',

  PERP_FUNDING_UPDATED: 'perp.funding.updated',
  PERP_OPEN_INTEREST_UPDATED: 'perp.open_interest.updated',
  PERP_LIQUIDATION_DETECTED: 'perp.liquidation.detected',
  PERP_SIGNAL_CREATED: 'perp.signal.created',

  AGENT_ANALYSIS_COMPLETED: 'agent.analysis.completed',
  BRAIN_SCORE_UPDATED: 'brain.score.updated',

  PREDICTION_CREATED: 'prediction.created',
  PREDICTION_EXPIRED: 'prediction.expired',
  PREDICTION_RESOLVED: 'prediction.resolved',

  AGENT_PERFORMANCE_UPDATED: 'agent.performance.updated',
  SETUP_PERFORMANCE_UPDATED: 'setup.performance.updated',

  SIGNAL_RETRIGGER_REQUESTED: 'signal.retrigger.requested',
  PAPER_TRADE_TP_HIT: 'paper_trade.tp_hit',
  PAPER_TRADE_SL_HIT: 'paper_trade.sl_hit',
  // Build-time addition (audit-2 #1 — entry orchestrator): the §11 fast lane's entry receipt.
  // Added to the plan's §10 list in the same change, per CLAUDE.md "done" rules.
  PAPER_TRADE_OPENED: 'paper_trade.opened',

  // ── Referenced by Part IV (§40) and the lifecycle sections (§36) ──
  PERP_KLINE_CLOSED: 'perp.kline.closed',
  PERP_POSITIONING_POLLED: 'perp.positioning.polled',
  PERP_REGIME_CLASSIFIED: 'perp.regime.classified',
  MEMECOIN_REGIME_CLASSIFIED: 'memecoin.regime.classified',
  SIGNAL_CREATED: 'signal.created',
  SIGNAL_INVALIDATED: 'signal.invalidated',
  TOKEN_RISK_VETOED: 'token.risk.vetoed',
  JUDGE_EVALUATION_COMPLETED: 'judge.evaluation.completed',

  // ── Raw ingestion hand-off (build-time addition — see CLAUDE.md "done": new
  //    events get added to the §10 list). The api webhook endpoint authenticates
  //    and enqueues the raw Helius body under this name; the Helius adapter
  //    (m1-helius-adapter) consumes it, parses, and emits the normalized
  //    wallet/token events above. Kept distinct so the un-normalized payload
  //    never masquerades as a normalized domain event (§12).
  HELIUS_WEBHOOK_RECEIVED: 'helius.webhook.received',
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

const ALL: ReadonlySet<string> = new Set(Object.values(EVENT_NAMES));

/** True when `name` is a known event name. Guards adapters against typos. */
export function isEventName(name: string): name is EventName {
  return ALL.has(name);
}
