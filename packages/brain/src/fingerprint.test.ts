import { describe, it, expect } from 'vitest';
import { ValidationError } from '@tip/domain';
import {
  bucket, dimensionsFor, setupFingerprint,
  MEMECOIN_DIMENSIONS, PERP_DIMENSIONS,
  type Dimension, type FeatureTuple,
} from './fingerprint.js';

/** Representative score for each bucket. */
const SCORES: Record<'LOW' | 'MED' | 'HIGH', number> = { LOW: -0.9, MED: 0, HIGH: 0.9 };

/** Cartesian product of LOW/MED/HIGH across `dims` → every possible tuple. */
function* allTuples(dims: readonly Dimension[]): Generator<FeatureTuple> {
  const buckets = ['LOW', 'MED', 'HIGH'] as const;
  const total = 3 ** dims.length;
  for (let i = 0; i < total; i++) {
    const t: Record<string, number> = {};
    let n = i;
    for (const d of dims) {
      t[d] = SCORES[buckets[n % 3]!];
      n = Math.floor(n / 3);
    }
    yield t as FeatureTuple;
  }
}

describe('bucket', () => {
  it('splits at ∓1/3', () => {
    expect(bucket(-0.5)).toBe('LOW');
    expect(bucket(0)).toBe('MED');
    expect(bucket(0.5)).toBe('HIGH');
    expect(bucket(-1)).toBe('LOW');
    expect(bucket(1)).toBe('HIGH');
  });
  it('boundary values land in MED (inclusive band)', () => {
    expect(bucket(-1 / 3)).toBe('MED');
    expect(bucket(1 / 3)).toBe('MED');
  });
  it('rejects non-finite input', () => {
    expect(() => bucket(NaN)).toThrow(ValidationError);
    expect(() => bucket(Infinity)).toThrow(ValidationError);
  });
});

describe('dimension tuples', () => {
  it('memecoin has the 5 dimensions Part II §8 names', () => {
    expect(MEMECOIN_DIMENSIONS).toEqual([
      'smart_money', 'convergence', 'momentum', 'token_quality', 'market_regime',
    ]);
  });
  it('perp has 8 dimensions (resolved: 7 composite inputs + volatility, Historical Edge excluded)', () => {
    expect(PERP_DIMENSIONS).toHaveLength(8);
    expect(PERP_DIMENSIONS).not.toContain('historical_edge'); // circular — see design.md
    expect(PERP_DIMENSIONS).toContain('volatility');
  });
  it('dimensionsFor routes by domain', () => {
    expect(dimensionsFor('memecoin')).toBe(MEMECOIN_DIMENSIONS);
    expect(dimensionsFor('perp')).toBe(PERP_DIMENSIONS);
  });
});

describe('setupFingerprint', () => {
  const meme: FeatureTuple = {
    smart_money: 0.8, convergence: 0.5, momentum: -0.1, token_quality: 0.9, market_regime: 0.4,
  };

  it('is deterministic', () => {
    expect(setupFingerprint('memecoin', meme)).toBe(setupFingerprint('memecoin', meme));
  });

  it('is order-independent — key insertion order cannot change the hash', () => {
    const reversed: FeatureTuple = {
      market_regime: 0.4, token_quality: 0.9, momentum: -0.1, convergence: 0.5, smart_money: 0.8,
    };
    expect(setupFingerprint('memecoin', reversed)).toBe(setupFingerprint('memecoin', meme));
  });

  it('is insensitive to within-bucket variation, sensitive to crossing a boundary', () => {
    const sameBuckets = { ...meme, smart_money: 0.4 }; // 0.8 → 0.4, both HIGH
    expect(setupFingerprint('memecoin', sameBuckets)).toBe(setupFingerprint('memecoin', meme));
    const crossed = { ...meme, smart_money: 0.2 }; // HIGH → MED
    expect(setupFingerprint('memecoin', crossed)).not.toBe(setupFingerprint('memecoin', meme));
  });

  it('domains never collide on identical bucket patterns', () => {
    const dims: FeatureTuple = Object.fromEntries(
      [...MEMECOIN_DIMENSIONS, ...PERP_DIMENSIONS].map((d) => [d, 0.9]),
    );
    expect(setupFingerprint('memecoin', dims)).not.toBe(setupFingerprint('perp', dims));
  });

  it('throws on a missing dimension — never fingerprints a partial tuple (rule 24)', () => {
    const { market_regime: _drop, ...partial } = meme;
    expect(() => setupFingerprint('memecoin', partial)).toThrow(ValidationError);
    expect(() => setupFingerprint('memecoin', partial)).toThrow(/market_regime/);
  });

  it('memecoin covers exactly 243 distinct cells (3^5 — Part II §8)', () => {
    const ids = new Set<string>();
    for (const t of allTuples(MEMECOIN_DIMENSIONS)) ids.add(setupFingerprint('memecoin', t));
    expect(ids.size).toBe(243);
  });

  it('perp covers exactly 6,561 distinct cells (3^8 — CLAUDE.md\'s "~6,500")', () => {
    const ids = new Set<string>();
    for (const t of allTuples(PERP_DIMENSIONS)) ids.add(setupFingerprint('perp', t));
    expect(ids.size).toBe(6561);
  });

  it('produces a 32-char hex id', () => {
    expect(setupFingerprint('memecoin', meme)).toMatch(/^[0-9a-f]{32}$/);
  });

  describe('retain (backoff arity — used by m5-historical-edge)', () => {
    it('a narrowed tuple hashes differently from the full one', () => {
      const narrowed = setupFingerprint('memecoin', meme, ['smart_money', 'convergence']);
      expect(narrowed).not.toBe(setupFingerprint('memecoin', meme));
    });

    it('a dropped dimension is OMITTED, not MED-bucketed — no arity collision', () => {
      // The critical case: a 2-dim fingerprint must never collide with a 5-dim one whose other
      // three dimensions happen to sit at MED.
      const twoDim = setupFingerprint('memecoin', meme, ['smart_money', 'convergence']);
      const fiveDimWithMeds = setupFingerprint('memecoin', {
        ...meme, momentum: 0, token_quality: 0, market_regime: 0,
      });
      expect(twoDim).not.toBe(fiveDimWithMeds);
    });

    it('retained dimensions keep canonical order regardless of the order passed', () => {
      const a = setupFingerprint('memecoin', meme, ['convergence', 'smart_money']);
      const b = setupFingerprint('memecoin', meme, ['smart_money', 'convergence']);
      expect(a).toBe(b);
    });

    it('a dropped dimension may be absent from the tuple entirely', () => {
      const { market_regime: _d, ...partial } = meme;
      const retained = MEMECOIN_DIMENSIONS.filter((d) => d !== 'market_regime');
      expect(() => setupFingerprint('memecoin', partial, retained)).not.toThrow();
    });
  });
});
