import { describe, it, expect } from 'vitest';
import { DEEPSEEK_V4_FLASH, MODEL_PRICES, estimateCost } from './cost.js';

describe('estimateCost', () => {
  it('DeepSeek V4-Flash is priced from the code-side table (not env), so review sees changes', () => {
    expect(MODEL_PRICES[DEEPSEEK_V4_FLASH]).toBeDefined();
  });

  it('cost = prompt/1e6 × promptPrice + completion/1e6 × completionPrice', () => {
    const cost = estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 1_000_000, completionTokens: 0 });
    expect(cost).toBeCloseTo(MODEL_PRICES[DEEPSEEK_V4_FLASH]!.promptPerMTok, 10);
    const cost2 = estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 0, completionTokens: 1_000_000 });
    expect(cost2).toBeCloseTo(MODEL_PRICES[DEEPSEEK_V4_FLASH]!.completionPerMTok, 10);
  });

  it('zero tokens → zero cost', () => {
    expect(estimateCost({ model: DEEPSEEK_V4_FLASH, promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it('unknown model → throws (adding a new model is a code change, review-visible)', () => {
    expect(() => estimateCost({ model: 'made-up-9999', promptTokens: 10, completionTokens: 5 })).toThrow(/unknown model/);
  });
});
