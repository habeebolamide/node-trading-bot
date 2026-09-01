/**
 * Perp agents (m4-perp-agents, §40.1–§40.6, §40.15, §40.16). `perpAgents` returns the 6
 * composite participants in plan-roster order.
 */
import type { AnalysisAgent } from '@tip/trading-agents';
import { perpMomentumAgent } from './momentum.js';
import { perpOpenInterestAgent } from './open-interest.js';
import { perpMarketRegimeAgent } from './market-regime.js';
import { perpLiquidationAgent } from './liquidation.js';
import { perpFundingAgent } from './funding.js';
import { perpPositioningAgent } from './positioning.js';

export { perpMomentumAgent } from './momentum.js';
export { perpOpenInterestAgent, type OIQuadrant } from './open-interest.js';
export { perpMarketRegimeAgent, type PerpRegime } from './market-regime.js';
export { perpLiquidationAgent } from './liquidation.js';
export { perpFundingAgent } from './funding.js';
export { perpPositioningAgent, scoreFromLSRatio } from './positioning.js';
export * from './indicators.js';
export { volumeSignedDirection, type VolumeCandle } from './features/volume.js';
export { historicalEdgeStub, type HistoricalEdgeResult } from './features/historical-edge-stub.js';

export const perpAgents: readonly AnalysisAgent[] = [
  perpMomentumAgent,
  perpOpenInterestAgent,
  perpMarketRegimeAgent,
  perpLiquidationAgent,
  perpFundingAgent,
  perpPositioningAgent,
];
