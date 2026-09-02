import { describe, it, expect } from 'vitest';
import { idsForRegime } from './market-memory.js';
import { MEMECOIN_DIMENSIONS, PERP_DIMENSIONS, setupFingerprint, type Bucket, type Domain, type FeatureTuple } from './fingerprint.js';

const REPRESENTATIVE: Record<Bucket, number> = { LOW: -0.9, MED: 0, HIGH: 0.9 };
const BUCKETS: readonly Bucket[] = ['LOW', 'MED', 'HIGH'];

/** Every cell in the domain's space. */
function allCells(domain: Domain): Set<string> {
  const dims = domain === 'memecoin' ? MEMECOIN_DIMENSIONS : PERP_DIMENSIONS;
  const ids = new Set<string>();
  const total = 3 ** dims.length;
  for (let i = 0; i < total; i++) {
    const t: Record<string, number> = {};
    let n = i;
    for (const d of dims) {
      t[d] = REPRESENTATIVE[BUCKETS[n % 3]!]!;
      n = Math.floor(n / 3);
    }
    ids.add(setupFingerprint(domain, t as FeatureTuple));
  }
  return ids;
}

describe('Market Memory regime partitioning (§16 — a query, not a table)', () => {
  for (const domain of ['memecoin', 'perp'] as const) {
    describe(domain, () => {
      const dimCount = (domain === 'memecoin' ? MEMECOIN_DIMENSIONS : PERP_DIMENSIONS).length;
      const perBucket = 3 ** (dimCount - 1);

      it(`each regime bucket enumerates 3^(d−1) = ${perBucket} cells`, () => {
        for (const r of BUCKETS) expect(new Set(idsForRegime(domain, r)).size).toBe(perBucket);
      });

      it('the three buckets are DISJOINT — a setup lands in exactly one regime bucket', () => {
        const [low, med, high] = BUCKETS.map((r) => new Set(idsForRegime(domain, r)));
        for (const id of low!) {
          expect(med!.has(id)).toBe(false);
          expect(high!.has(id)).toBe(false);
        }
        for (const id of med!) expect(high!.has(id)).toBe(false);
      });

      it('the three buckets together COVER the whole cell space — nothing is unattributable', () => {
        const union = new Set(BUCKETS.flatMap((r) => idsForRegime(domain, r)));
        const every = allCells(domain);
        expect(union.size).toBe(every.size);
        for (const id of every) expect(union.has(id)).toBe(true);
      });

      it('enumeration is deterministic', () => {
        expect(idsForRegime(domain, 'HIGH')).toEqual(idsForRegime(domain, 'HIGH'));
      });
    });
  }

  it('memecoin partitions 243 cells as 3 × 81; perp 6,561 as 3 × 2,187', () => {
    expect(idsForRegime('memecoin', 'HIGH')).toHaveLength(81);
    expect(idsForRegime('perp', 'HIGH')).toHaveLength(2187);
  });
});
