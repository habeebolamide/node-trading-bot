/**
 * Default ScoringConfig templates used to prefill the Create-Agent form. These MUST match
 * DEFAULT_AGENT_WEIGHTS in @tip/trading-agents/config.ts — the shapes are the same because
 * the api validates against the same Zod schema. If a weight table changes there, mirror it
 * here (a plan-sync moment — same rule as CLAUDE.md's "plan and code stay in sync").
 */
export const DEFAULT_CONFIG_PERP = {
  riskPercent: 0.01,
  minRR: 1.5,
  maxConcurrentPositions: 1,
  leverageMax: 10,
  agentWeights: {
    'perp.momentum': 0.20,
    'perp.open_interest': 0.20,
    'perp.market_regime': 0.15,
    'perp.liquidation': 0.15,
    'perp.funding': 0.10,
    'perp.positioning': 0.10,
    volume: 0.05,
    historical_edge: 0.05,
  },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

export const DEFAULT_CONFIG_MEMECOIN = {
  riskPercent: 0.01,
  minRR: 1.5,
  maxConcurrentPositions: 1,
  agentWeights: {
    'memecoin.smart_money': 0.25,
    'memecoin.convergence': 0.20,
    early_entry: 0.15,
    'memecoin.momentum': 0.15,
    'memecoin.token_quality': 0.10,
    'memecoin.market_regime': 0.05,
    freshness: 0.05,
    historical_edge: 0.05,
  },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2 },
  stopPct: 0.2,
  takeProfitPct: 0.6,
};
