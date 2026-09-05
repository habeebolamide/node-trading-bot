/**
 * DeepSeek pricing table (§23 cost tracking). Prices live in CODE, not env — a price change
 * shows up in review and freezes historical costs (`llm_call_log.cost` is computed at call time
 * from THIS table, so historical rows never rewrite themselves later).
 *
 * PRICING UPDATE 2026-09-05: DeepSeek retired the flat $0.14/$0.28 V4-Flash rate and, effective
 * 2026-08-16 16:00 UTC, bills peak/off-peak:
 *   - peak  (01:00-04:00 + 06:00-10:00 UTC): $0.44 /1M input, $1.32 /1M output
 *   - off-peak (all other hours):            $0.22 /1M input, $0.66 /1M output
 * We use the OFF-PEAK rate as the table baseline (off-peak covers 17 of 24 hours). This is a
 * single-number ESTIMATE — a call made during peak costs 2×. `reasoning_tokens` bill as output
 * (they're part of completion_tokens), so a reasoning-heavy autopsy batch is dominated by the
 * output rate. Historical `llm_call_log.cost` rows keep whatever price was live when written;
 * updating this table only affects future estimates.
 *
 * If they change again, bump this table; never mutate historical prices in place. (Precise
 * peak/off-peak accounting by call timestamp is a future refinement — the flat off-peak baseline
 * is honest for on-demand cost display.)
 */
export interface ModelPrice {
  /** Per 1M tokens, USD. */
  promptPerMTok: number;
  completionPerMTok: number;
}

/** MODEL_PRICES holds the OFF-PEAK rate; peak is PEAK_MULTIPLIER × these (see header). */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { promptPerMTok: 0.22, completionPerMTok: 0.66 },
};

export const DEEPSEEK_V4_FLASH = 'deepseek-v4-flash';

/**
 * DeepSeek peak/off-peak billing (effective 2026-08-16). Peak hours are 01:00-04:00 and
 * 06:00-10:00 UTC; peak rate is 2× off-peak. MODEL_PRICES stores off-peak; a call made during
 * a peak window costs double. estimateCost applies this from the call time so both the live
 * `llm_call_log.cost` and the pre-run UI estimate reflect the actual rate.
 */
export const PEAK_MULTIPLIER = 2;

/** True when `at` (default now) falls in a DeepSeek peak window (UTC 01-04 or 06-10). */
export function isDeepSeekPeak(at: Date = new Date()): boolean {
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/**
 * Cost in USD. `at` (default now) decides peak vs off-peak — a call/estimate during a peak window
 * is billed at 2× the off-peak MODEL_PRICES rate. Callers recording historical cost pass no `at`
 * (they compute at call time); the UI estimate also uses now, matching when the run will execute.
 */
export function estimateCost(input: {
  model: string; promptTokens: number; completionTokens: number; at?: Date;
}): number {
  const p = MODEL_PRICES[input.model];
  if (!p) throw new Error(`unknown model "${input.model}" — add it to MODEL_PRICES before use`);
  const mult = isDeepSeekPeak(input.at ?? new Date()) ? PEAK_MULTIPLIER : 1;
  return ((input.promptTokens / 1_000_000) * p.promptPerMTok
        + (input.completionTokens / 1_000_000) * p.completionPerMTok) * mult;
}
