/**
 * Aggregate trade_autopsy rows into (category, kind) patterns with recency-weighted effective-n.
 * Reuses @tip/brain's `recencyWeight` + `HALFLIFE_DAYS` — one statistics vocabulary everywhere
 * (§41's "one tested function"). Refuses to yield below effective-n ≥ 20 (§24 eligibility floor,
 * higher than Setup Memory's ≥ 10).
 *
 * GROUPING = category, NOT (setupId, category)  (2026-09-05 fix):
 *   The remediation a pattern triggers is a GLOBAL weight delta — CATEGORY_TO_ADJUSTMENT_V1 is
 *   keyed by category alone and applyWeightDelta renormalizes the whole agent config. The setupId
 *   never scopes the change. Grouping evidence by setupId therefore fragmented a global signal
 *   for zero downstream benefit: with ~6500 possible perp fingerprints, no single (setup,category)
 *   bucket ever reaches 20 — the loop could never open a hypothesis at any realistic data volume.
 *   Observed live: 179 autopsies, POSITIONING_MISREAD=60 across 29 setups, biggest single-setup
 *   bucket=11 → zero hypotheses. Grouping by category alone surfaces the 60 as one clear pattern.
 *   `setupId` on the emitted pattern is the domain-level sentinel ALL_SETUPS — the hypothesis is
 *   "this category is systematically costing us across the book", not "in this one fingerprint".
 */
import { and, eq, lte } from 'drizzle-orm';
import { tradeAutopsy, type Db } from '@tip/database';
import { HALFLIFE_DAYS, recencyWeight } from '@tip/brain';
import type { Pattern } from './propose.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const HYPOTHESIS_ELIGIBILITY_FLOOR = 20;
/** Sentinel setupId for a category-level (cross-fingerprint) hypothesis. */
export const ALL_SETUPS = 'ALL';

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

  // Bucket by (category, categoryKind) across ALL setups → sum recency-weighted effective-n.
  const buckets = new Map<string, { category: string; kind: 'FAILURE' | 'SUCCESS'; n: number }>();
  for (const r of rows) {
    const category = r.failureCategory ?? r.successFactor;
    if (!category) continue;
    const kind: 'FAILURE' | 'SUCCESS' = r.outcome === 'LOSS' ? 'FAILURE' : 'SUCCESS';
    const key = `${kind}::${category}`;
    const ageDays = (input.asOf.getTime() - r.createdAt.getTime()) / DAY_MS;
    const weight = recencyWeight(ageDays, halflifeDays);
    const cur = buckets.get(key);
    if (cur) cur.n += weight;
    else buckets.set(key, { category, kind, n: weight });
  }

  for (const b of buckets.values()) {
    if (b.n < floor) continue;
    yield {
      setupId: ALL_SETUPS, domain: 'perp',
      category: b.category, categoryKind: b.kind, evidenceCount: b.n,
    };
  }
}
