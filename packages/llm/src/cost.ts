/**
 * DeepSeek pricing table (§23 cost tracking). Prices live in CODE, not env — a price change
 * shows up in review and freezes historical costs (`llm_call_log.cost` is computed at call time
 * from THIS table, so historical rows never rewrite themselves later).
 *
 * Prices as of DeepSeek's public V4-Flash pricing at m7 scoping. If they change, bump this
 * table with a new model slug and let the code path route based on the resolved model at call
 * time. Never mutate historical prices in place.
 */
export interface ModelPrice {
  /** Per 1M tokens, USD. */
  promptPerMTok: number;
  completionPerMTok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { promptPerMTok: 0.14, completionPerMTok: 0.28 },
};

export const DEEPSEEK_V4_FLASH = 'deepseek-v4-flash';

export function estimateCost(input: { model: string; promptTokens: number; completionTokens: number }): number {
  const p = MODEL_PRICES[input.model];
  if (!p) throw new Error(`unknown model "${input.model}" — add it to MODEL_PRICES before use`);
  return (input.promptTokens / 1_000_000) * p.promptPerMTok
       + (input.completionTokens / 1_000_000) * p.completionPerMTok;
}
