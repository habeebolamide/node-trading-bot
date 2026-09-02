/**
 * Memecoin Historical Edge Feature (§40.19). Weight 5% of the Opportunity Score (Part II §9).
 *
 * Same read as the perp counterpart (§40.16) against the memecoin Brain — the fingerprint tuple
 * (5 dimensions) and half-life (30d) differ, and both live in `@tip/brain`, so this is a thin
 * domain binding rather than a second implementation.
 */
import type { Db } from '@tip/database';
import { historicalEdge, type FeatureTuple, type HistoricalEdge } from '@tip/brain';

export type { HistoricalEdge } from '@tip/brain';

export const MEMECOIN_HISTORICAL_EDGE_KEY = 'historical_edge';

/** `asOf` is the signal's evaluation time — never wall clock (rules 11/21/22). */
export async function memecoinHistoricalEdge(db: Db, features: FeatureTuple, asOf: Date): Promise<HistoricalEdge> {
  return historicalEdge(db, 'memecoin', features, asOf);
}
