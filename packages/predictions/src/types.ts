/**
 * Prediction shape at the module boundary (§19). Immutable after creation (rule 10, enforced by
 * a Postgres trigger on the `prediction` table). Not a Drizzle inferSelect: numeric columns
 * come back as strings from the DB, but callers deserve numbers.
 */
import type { Domain } from '@tip/trading-agents';
import type { Horizon, TradeSetup } from '@tip/planner';

export interface AgentContribution {
  readonly agent: string;
  readonly agentVersion: number;
  /** `weight × score` for the composite; already renormalized (m4-signal-engine composeSignal). */
  readonly contribution: number;
  readonly weight: number;
  readonly score: number;
}

export interface PredictionRow {
  readonly id: string;
  readonly tradingAgentId: string;
  readonly signalId: string;
  readonly domain: Domain;
  readonly symbol: string;
  readonly direction: string;
  readonly score: number;
  readonly confidence: number;
  readonly horizon: Horizon;
  readonly entry: number;
  readonly stopLoss: number;
  readonly takeProfit: number | null;
  readonly positionSize: number;
  readonly notional: number;
  readonly leverage: number | null;
  readonly requiredMargin: number | null;
  readonly riskReward: number;
  readonly thesis: string | null;
  readonly features: unknown;
  readonly invalidators: unknown;
  readonly configVersion: number;
  readonly isShadow: boolean;
  readonly shadowOf: string | null;
  readonly createdAt: Date;
}

export interface CreatePredictionInput {
  readonly signalId: string;
  readonly tradingAgentId: string;
  readonly setup: TradeSetup;
  readonly signalScore: number;
  readonly confidence: number;
  readonly direction: string;
  readonly features: readonly AgentContribution[];
  readonly invalidators?: unknown;
  /** M7 fills; null is a complete, valid prediction. */
  readonly thesis?: string | null;
  /** §18 Judge-override machinery (M7). Both stay defaults here. */
  readonly isShadow?: boolean;
  readonly shadowOf?: string | null;
  /**
   * Optional override for `createdAt` — the seeder passes the historical bar's close time
   * so the outcome resolver can find the RIGHT 1m candles. Omit in live code so `defaultNow()`
   * stamps the actual insert wall-clock.
   */
  readonly createdAt?: Date;
}

export interface CreatePredictionResult {
  readonly created: true;
  readonly prediction: PredictionRow;
}

export type CreatePredictionOutcome =
  | CreatePredictionResult
  | { readonly created: false; readonly reason: 'SIGNAL_NOT_ACTIVE'; readonly currentState: string | null }
  | { readonly created: false; readonly reason: 'DUPLICATE_SIGNAL'; readonly existingPredictionId: string };
