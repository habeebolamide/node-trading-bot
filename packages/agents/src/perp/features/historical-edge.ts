/**
 * Perp Historical Edge Feature (§40.16). Weight 5% of the perp composite.
 *
 * A Feature, not an Agent (§40 "Features (not Agents)"): no trigger, no agentVersion, no
 * AgentPerformance record, no BrainAgentMemory, no user-facing toggle. Its weight is settable
 * (including to 0) but the computation itself is not skippable.
 *
 * Replaces the M4 `historical-edge-stub.ts`, which returned INSUFFICIENT unconditionally until
 * BrainSetupMemory landed. The type name is kept stable so downstream imports did not churn.
 */
import type { Db } from '@tip/database';
import { historicalEdge, type FeatureTuple, type HistoricalEdge } from '@tip/brain';

export type { HistoricalEdge } from '@tip/brain';

export const PERP_HISTORICAL_EDGE_KEY = 'historical_edge';

/**
 * Read the perp Brain's edge for this feature snapshot as of `asOf`.
 *
 * `asOf` is the primary-TF close time, never wall clock — a signal formed on a candle that
 * closed at T must be scored on what was known at T (rules 11/21/22).
 */
export async function perpHistoricalEdge(db: Db, features: FeatureTuple, asOf: Date): Promise<HistoricalEdge> {
  return historicalEdge(db, 'perp', features, asOf);
}
