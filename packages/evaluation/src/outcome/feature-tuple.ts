/**
 * Assemble a domain-feature tuple from a prediction's stored contributions for the setup
 * fingerprint (M5, `setupFingerprint`). We do NOT re-run the agents at outcome time — the
 * scores that produced the composite are already persisted on `signal_feature` (M4). Reading
 * them back is the whole reason that table exists (§22 attribution + m5-agent-memory).
 *
 * Any tuple dimension without a corresponding agent score is treated as 0 (MED bucket); missing
 * data is bucketed conservatively rather than throwing, because a change 4 that refused to write
 * an occurrence over a missing dimension would drop the row from every Brain memory silently.
 * The bucket cut at 0 keeps MED, so an omitted dimension contributes no directional information.
 */
import { eq } from 'drizzle-orm';
import { signalFeature, type Db } from '@tip/database';
import { MEMECOIN_DIMENSIONS, PERP_DIMENSIONS, type Domain, type FeatureTuple } from '@tip/brain';

/**
 * Map agent keys to the fingerprint dimensions they contribute to. The plan's ranking of
 * dimensions matches its agent names 1:1 for perp; memecoin dimensions are named directly by the
 * agent keys except for `volatility`, which does not exist on memecoin.
 *
 * Perp `volatility` is m5-brain-core's ADDED dimension (not a plan-weighted composite input);
 * there is no perp.volatility agent, so it stays at 0 (MED) until an ATR-based feed writes it.
 * Documented in the archived m5-historical-edge design as the deliberate "unranked" position.
 */
const PERP_AGENT_TO_DIM: Record<string, (typeof PERP_DIMENSIONS)[number]> = {
  'perp.momentum': 'momentum',
  'perp.open_interest': 'open_interest',
  'perp.market_regime': 'market_regime',
  'perp.liquidation': 'liquidation',
  'perp.funding': 'funding',
  'perp.positioning': 'positioning',
  'volume': 'volume',
};

const MEMECOIN_AGENT_TO_DIM: Record<string, (typeof MEMECOIN_DIMENSIONS)[number]> = {
  'memecoin.smart_money': 'smart_money',
  'memecoin.convergence': 'convergence',
  'memecoin.momentum': 'momentum',
  'memecoin.token_quality': 'token_quality',
  'memecoin.market_regime': 'market_regime',
};

/**
 * Build the feature tuple for a signal by reading its `signal_feature` rows and mapping agent
 * keys to dimensions. Missing dimensions default to 0 (MED bucket) so the fingerprint stays
 * complete without inventing a directional lean — see the missing-data note above.
 */
export async function featureTupleFor(db: Db, signalId: string, domain: Domain): Promise<FeatureTuple> {
  const rows = await db
    .select({ agentKey: signalFeature.agentKey, score: signalFeature.score })
    .from(signalFeature)
    .where(eq(signalFeature.signalId, signalId));

  const dims = domain === 'memecoin' ? MEMECOIN_DIMENSIONS : PERP_DIMENSIONS;
  const map = domain === 'memecoin' ? MEMECOIN_AGENT_TO_DIM : PERP_AGENT_TO_DIM;
  const tuple: Record<string, number> = {};
  for (const d of dims) tuple[d] = 0;
  for (const r of rows) {
    const d = map[r.agentKey];
    if (d) tuple[d] = Number(r.score);
  }
  return tuple as FeatureTuple;
}

/**
 * Contributions in the shape m5-agent-memory's `recordAgentOutcome` expects. Includes EVERY
 * signal_feature row — including agents that don't participate in the fingerprint (e.g. features
 * like `volume`, or the Risk Agent's row which agentMemory will exclude by its own rules).
 */
export async function contributionsFor(db: Db, signalId: string) {
  const rows = await db.select().from(signalFeature).where(eq(signalFeature.signalId, signalId));
  return rows.map((r) => ({ agent: r.agentKey, agentVersion: r.agentVersion, score: Number(r.score) }));
}
