/**
 * Memecoin agents + features (m4-memecoin-agents, §40.7–§40.11, §40.13, §40.17, §40.18).
 * `memecoinAgents` returns the five composite-participating Analysis Agents in the order they
 * appear in the plan's roster. Token Risk is exported separately — it's a HARD VETO (§40.13),
 * not a composite input, so downstream wires it via `isVetoed` before scoring.
 */
import type { AnalysisAgent } from '@tip/trading-agents';
import { memecoinSmartMoneyAgent } from './smart-money.js';
import { memecoinConvergenceAgent } from './convergence.js';
import { memecoinMomentumAgent } from './momentum.js';
import { memecoinTokenQualityAgent } from './token-quality.js';
import { memecoinMarketRegimeAgent } from './market-regime.js';
import { memecoinTokenRiskAgent } from './token-risk.js';

export { memecoinSmartMoneyAgent } from './smart-money.js';
export { memecoinConvergenceAgent } from './convergence.js';
export { memecoinMomentumAgent, MEMECOIN_TOKEN_CANDLE_EVENT } from './momentum.js';
export { memecoinTokenQualityAgent } from './token-quality.js';
export { memecoinMarketRegimeAgent, type Regime as MemecoinRegime } from './market-regime.js';
export { memecoinTokenRiskAgent, isVetoed, type TokenRiskPayload, type TokenRiskVerdict } from './token-risk.js';
export { computeEarlyEntry, type EarlyEntryInput, type EarlyEntryOutput } from './features/early-entry.js';
export { freshness, DEFAULT_FRESHNESS_TAU_MS } from './features/freshness.js';
export { memecoinHistoricalEdge, MEMECOIN_HISTORICAL_EDGE_KEY } from './features/historical-edge.js';

/** The 5 memecoin agents that participate in the composite (Token Risk is a hard veto, separate). */
export const memecoinAgents: readonly AnalysisAgent[] = [
  memecoinSmartMoneyAgent,
  memecoinConvergenceAgent,
  memecoinMomentumAgent,
  memecoinTokenQualityAgent,
  memecoinMarketRegimeAgent,
];
export * from './token-claim.js';
