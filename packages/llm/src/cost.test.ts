import { describe, it, expect } from 'vitest';
import { DEEPSEEK_V4_FLASH, MODEL_PRICES, estimateCost, isDeepSeekPeak, PEAK_MULTIPLIER } from './cost.js';

// Fixed times so the peak/off-peak multiplier is deterministic regardless of when tests run.
const OFF_PEAK = new Date('2026-09-06T12:00:00Z'); // 12:00 UTC — off-peak
const PEAK = new Date('2026-09-06T02:00:00Z');     // 02:00 UTC — peak window

describe('estimateCost', () => {
  it('DeepSeek V4-Flash is priced from the code-side table (not env), so review sees changes', () => {
    expect(MODEL_PRICES[DEEPSEEK_V4_FLASH]).toBeDefined();
  });

  it('off-peak: cost = prompt/1e6 × promptPrice + completion/1e6 × completionPrice', () => {
    const cost = estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 1_000_000, completionTokens: 0, at: OFF_PEAK });
    expect(cost).toBeCloseTo(MODEL_PRICES[DEEPSEEK_V4_FLASH]!.promptPerMTok, 10);
    const cost2 = estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 0, completionTokens: 1_000_000, at: OFF_PEAK });
    expect(cost2).toBeCloseTo(MODEL_PRICES[DEEPSEEK_V4_FLASH]!.completionPerMTok, 10);
  });

  it('peak: same call costs PEAK_MULTIPLIER× the off-peak rate', () => {
    const off = estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 1_000_000, completionTokens: 1_000_000, at: OFF_PEAK });
    const peak = estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 1_000_000, completionTokens: 1_000_000, at: PEAK });
    expect(peak).toBeCloseTo(off * PEAK_MULTIPLIER, 10);
  });

  it('isDeepSeekPeak windows — 01-04 and 06-10 UTC are peak, else off-peak', () => {
    expect(isDeepSeekPeak(new Date('2026-09-06T02:30:00Z'))).toBe(true);  // in 01-04
    expect(isDeepSeekPeak(new Date('2026-09-06T07:00:00Z'))).toBe(true);  // in 06-10
    expect(isDeepSeekPeak(new Date('2026-09-06T12:00:00Z'))).toBe(false); // midday
    expect(isDeepSeekPeak(new Date('2026-09-06T05:00:00Z'))).toBe(false); // gap between windows
    expect(isDeepSeekPeak(new Date('2026-09-06T10:00:00Z'))).toBe(false); // 10:00 is off-peak (exclusive)
  });

  it('zero tokens → zero cost', () => {
    expect(estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 0, completionTokens: 0, at: OFF_PEAK })).toBe(0);
  });

  it('unknown model → throws (adding a new model is a code change, review-visible)', () => {
    expect(() => estimateCost({ model: 'made-up-9999', promptTokens: 10, completionTokens: 5 })).toThrow(/unknown model/);
  });
});
