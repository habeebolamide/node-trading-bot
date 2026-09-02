/**
 * Market Memory (§16) — "how setups behave under different market regimes."
 *
 * A QUERY, NOT A TABLE. Part II §8 already resolved that regime is one of the bucketed
 * fingerprint dimensions ("Regime requires no separate handling... a bull-market setup and an
 * otherwise-identical bear-market setup already hash to different setupIds"). So the regime
 * breakdown falls out of Setup Memory by grouping. Adding a table would duplicate data
 * `brain_setup_memory` already stores and create a second thing to keep in sync.
 *
 * Flagged explicitly because "Market Memory" reads like a noun that wants a table, and the next
 * person to read §16 will reasonably wonder where it went.
 */
import { and, eq, inArray, lte } from 'drizzle-orm';
import { brainSetupOccurrence, type Db } from '@tip/database';
import { setupFingerprint, dimensionsFor, type Bucket, type Domain, type FeatureTuple } from './fingerprint.js';
import { HALFLIFE_DAYS, TRUST_THRESHOLD_EFFECTIVE_N, type Evidence } from './setup-memory.js';
import { recencyWeight, weightedMedian, wilsonInterval, type WeightedItem } from './stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKETS: readonly Bucket[] = ['LOW', 'MED', 'HIGH'];

/** Representative score for each bucket — any value inside the band hashes identically. */
const REPRESENTATIVE: Record<Bucket, number> = { LOW: -0.9, MED: 0, HIGH: 0.9 };

export interface RegimeStats {
  readonly regime: Bucket; // LOW = bearish regime bias, MED = range, HIGH = bullish
  readonly effectiveN: number;
  readonly winRate: number | null;
  readonly medianReturn: number | null;
  readonly wilsonLower: number | null;
  readonly wilsonUpper: number | null;
  readonly evidence: Evidence;
}

export interface MarketMemory {
  readonly domain: Domain;
  readonly byRegime: readonly RegimeStats[];
  readonly asOf: Date;
}

/**
 * Enumerate the setupIds that share a given regime bucket, holding every other dimension across
 * its full range. That is 3^(d−1) ids per bucket — 81 for memecoin, 2,187 for perp — which is a
 * single `IN` query, not a scan.
 *
 * Exported for direct testing: the "every setup lands in exactly one regime bucket" invariant is
 * a property of these id sets (disjoint, and together covering the whole cell space), and is far
 * better asserted here than through a shared database other tests write to concurrently.
 */
export function idsForRegime(domain: Domain, regime: Bucket): string[] {
  const dims = dimensionsFor(domain);
  const others = dims.filter((d) => d !== 'market_regime');
  const ids: string[] = [];
  const total = 3 ** others.length;
  for (let i = 0; i < total; i++) {
    const t: Record<string, number> = { market_regime: REPRESENTATIVE[regime] };
    let n = i;
    for (const d of others) {
      t[d] = REPRESENTATIVE[BUCKETS[n % 3]!];
      n = Math.floor(n / 3);
    }
    ids.push(setupFingerprint(domain, t as FeatureTuple));
  }
  return ids;
}

/**
 * Win rate / median return per regime bucket, recency-weighted as of `asOf`.
 *
 * Point-in-time like every other Brain read: occurrences are filtered to `closed_at <= asOf`
 * (rules 11/21/22).
 */
export async function marketMemory(db: Db, domain: Domain, asOf: Date): Promise<MarketMemory> {
  const halflifeDays = HALFLIFE_DAYS[domain];
  const byRegime: RegimeStats[] = [];

  for (const regime of BUCKETS) {
    const rows = await db
      .select({
        closedAt: brainSetupOccurrence.closedAt,
        won: brainSetupOccurrence.won,
        returnPct: brainSetupOccurrence.returnPct,
      })
      .from(brainSetupOccurrence)
      .where(and(
        eq(brainSetupOccurrence.domain, domain),
        inArray(brainSetupOccurrence.setupId, idsForRegime(domain, regime)),
        lte(brainSetupOccurrence.closedAt, asOf),
      ));

    let effectiveN = 0;
    let effectiveWins = 0;
    const returns: WeightedItem[] = [];
    for (const r of rows) {
      const weight = recencyWeight((asOf.getTime() - r.closedAt.getTime()) / DAY_MS, halflifeDays);
      effectiveN += weight;
      if (r.won) effectiveWins += weight;
      returns.push({ value: Number(r.returnPct), weight });
    }

    const sufficient = effectiveN >= TRUST_THRESHOLD_EFFECTIVE_N;
    const ci = sufficient ? wilsonInterval(effectiveWins, effectiveN, 0.95) : null;
    byRegime.push({
      regime,
      effectiveN,
      winRate: effectiveN > 0 ? effectiveWins / effectiveN : null,
      medianReturn: weightedMedian(returns),
      wilsonLower: ci?.lower ?? null,
      wilsonUpper: ci?.upper ?? null,
      evidence: sufficient ? 'SUFFICIENT' : 'INSUFFICIENT',
    });
  }

  return { domain, byRegime, asOf };
}
