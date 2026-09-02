/**
 * Aggregate trade_autopsy rows into (setupId, category) patterns with recency-weighted
 * effective-n. Reuses @tip/brain's `recencyWeight` + `HALFLIFE_DAYS` — one statistics
 * vocabulary, everywhere (§41's "one tested function"). Refuses to yield below effective-n ≥ 20
 * (§24 eligibility floor, higher than Setup Memory's ≥ 10).
 */
import { and, eq, lte } from 'drizzle-orm';
import { tradeAutopsy, type Db } from '@tip/database';
import { HALFLIFE_DAYS, recencyWeight } from '@tip/brain';
import type { Pattern } from './propose.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const HYPOTHESIS_ELIGIBILITY_FLOOR = 20;

/**
 * Yield eligible patterns for a domain at `asOf`. Groups SUCCESS autopsies where
 * `success_factor` is populated, and FAILURE autopsies where `failure_category` is populated.
 * FAILED_LLM rows are excluded (they carry no category tag).
 */
export async function* aggregatePatterns(
  db: Db,
  input: { domain: 'perp'; asOf: Date; minEvidenceN?: number },
): AsyncGenerator<Pattern> {
  const rows = await db
    .select({
      predictionId: tradeAutopsy.predictionId,
      setupId: tradeAutopsy.setupId,
      failureCategory: tradeAutopsy.failureCategory,
      successFactor: tradeAutopsy.successFactor,
      createdAt: tradeAutopsy.createdAt,
      outcome: tradeAutopsy.outcome,
      status: tradeAutopsy.status,
    })
    .from(tradeAutopsy)
    .where(and(
      eq(tradeAutopsy.status, 'SUCCESS'),
      lte(tradeAutopsy.createdAt, input.asOf),
    ));

  const halflifeDays = HALFLIFE_DAYS.perp;
  const floor = input.minEvidenceN ?? HYPOTHESIS_ELIGIBILITY_FLOOR;

  // Bucket by (setupId, category, categoryKind) → sum recency-weighted effective-n.
  const buckets = new Map<string, { setupId: string; category: string; kind: 'FAILURE' | 'SUCCESS'; n: number }>();
  for (const r of rows) {
    const category = r.failureCategory ?? r.successFactor;
    if (!category) continue;
    const kind: 'FAILURE' | 'SUCCESS' = r.outcome === 'LOSS' ? 'FAILURE' : 'SUCCESS';
    const key = `${r.setupId}::${kind}::${category}`;
    const ageDays = (input.asOf.getTime() - r.createdAt.getTime()) / DAY_MS;
    const weight = recencyWeight(ageDays, halflifeDays);
    const cur = buckets.get(key);
    if (cur) cur.n += weight;
    else buckets.set(key, { setupId: r.setupId, category, kind, n: weight });
  }

  for (const b of buckets.values()) {
    if (b.n < floor) continue;
    yield {
      setupId: b.setupId, domain: 'perp',
      category: b.category, categoryKind: b.kind, evidenceCount: b.n,
    };
  }
}
