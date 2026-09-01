/**
 * The base `AnalysisAgent` interface (§6, §7). Distinct from TradingAgent (§14) — an Analysis
 * Agent is a specialized reasoner (Momentum, Convergence, Funding, ...) that produces a
 * structured `{ score, confidence, features }` output. Many run per TradingAgent.
 *
 * Trigger types (§7):
 *   CADENCE     → fires on candle close of a timeframe
 *   EVENT       → fires on a specific raw event (e.g. perp.liquidation.detected)
 *   CONDITIONAL → CADENCE that skips a candle if nothing meaningful changed since last run
 *
 * Non-directional agents (Regime, Risk, Token Risk) return `direction: 'NEUTRAL'` and carry
 * their enum/verdict in `features` — special-cased downstream, per §7 "Agents vs Features."
 */
import type { DomainEvent } from '@tip/domain';
import type { Db } from '@tip/database';

export type Trigger = 'CADENCE' | 'EVENT' | 'CONDITIONAL';

export interface AgentOutput {
  agent: string; // agentKey, e.g. 'perp.momentum' / 'memecoin.smart_money'
  agentVersion: number; // integer, bumped only on behavioral change (Task 1)
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  score: number; // [-1, +1]  (or [0, 1] for unipolar agents; both fit)
  confidence: number; // [0, 1]
  features: Record<string, unknown>;
  /** True if a CONDITIONAL agent decided to skip this candle (dead-candle, etc.). */
  skipped?: boolean;
}

/** Point-in-time score lookup — never returns a score with timestamp > `at` (rule 21). */
export interface WalletScoreRow {
  score: number;
  timestamp: Date;
  configVersion: number;
  inputsUsed: unknown;
}
export type WalletScoreAsOfLookup = (walletId: string, at: Date) => Promise<WalletScoreRow | null>;

/**
 * The context every AnalysisAgent receives. All as-of readers preserve rule 21 in the replay
 * path too — no `latest()` / `currentScore()` accessors exposed here.
 */
export interface AgentContext {
  readonly db: Db;
  /** Deterministic clock; injected for replay/backtest determinism. */
  readonly now: Date;
  readonly tradingAgentId: string;
  readonly configVersion: number;
  readonly domain: 'perp' | 'memecoin';
  readonly primaryTf: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  readonly walletScoreAsOf: WalletScoreAsOfLookup;
  readonly activeClusterMap: () => Promise<Map<string, string>>;
}

/** The interface every specialized agent implements (§6). */
export interface AnalysisAgent {
  readonly key: string;
  readonly version: number;
  readonly trigger: Trigger;
  canHandle(event: DomainEvent): boolean;
  analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null>;
}
