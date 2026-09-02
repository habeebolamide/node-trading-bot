import { describe, it, expect } from 'vitest';
import { JudgeOutput } from './schema.js';

const baseValid = {
  direction: 'LONG' as const, confidence: 0.75, thesis: 'because momentum + regime aligned',
  keyRisks: ['funding elevated'], invalidators: [{ type: 'price_below' as const, value: 50 }],
  confidenceTag: 'moderate' as const,
};

describe('JudgeOutput schema (§40.14 with closed invalidator vocabulary)', () => {
  it('accepts a well-formed judgment', () => {
    expect(JudgeOutput.safeParse(baseValid).success).toBe(true);
  });

  it('rejects out-of-range confidence', () => {
    expect(JudgeOutput.safeParse({ ...baseValid, confidence: 1.5 }).success).toBe(false);
    expect(JudgeOutput.safeParse({ ...baseValid, confidence: -0.1 }).success).toBe(false);
  });

  it('rejects empty thesis', () => {
    expect(JudgeOutput.safeParse({ ...baseValid, thesis: '' }).success).toBe(false);
  });

  it('rejects overly long thesis (runaway response guard)', () => {
    expect(JudgeOutput.safeParse({ ...baseValid, thesis: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('caps keyRisks and invalidators', () => {
    expect(JudgeOutput.safeParse({ ...baseValid, keyRisks: Array(7).fill('r') }).success).toBe(false);
    expect(JudgeOutput.safeParse({
      ...baseValid,
      invalidators: Array(5).fill({ type: 'price_below', value: 1 }),
    }).success).toBe(false);
  });

  it('rejects unknown invalidator types — the vocabulary is CLOSED', () => {
    expect(JudgeOutput.safeParse({
      ...baseValid,
      invalidators: [{ type: 'invented_type', value: 1 }],
    }).success).toBe(false);
  });

  it('accepts every declared invalidator type', () => {
    for (const inv of [
      { type: 'price_above', value: 100 },
      { type: 'price_below', value: 100 },
      { type: 'ttl_expired', horizon: '4h' },
      { type: 'funding_extreme', threshold: 0.001 },
      { type: 'stop_moved', price: 99 },
    ] as const) {
      expect(JudgeOutput.safeParse({ ...baseValid, invalidators: [inv] }).success).toBe(true);
    }
  });

  it('rejects confidenceTag outside the fixed enum', () => {
    expect(JudgeOutput.safeParse({ ...baseValid, confidenceTag: 'ok' }).success).toBe(false);
  });
});
