/**
 * Judge response schema (§40.14 output). Discriminated invalidator union — a `type` string the
 * paper engine cannot act on is invalidator-shaped and worthless (m7-judge-agent design.md
 * "Judge invalidator vocabulary" resolution). Extending the enum is a JUDGE_VERSION_CURRENT
 * bump — review-visible, non-blending.
 */
import { z } from 'zod';

export const JudgeDirection = z.enum(['LONG', 'SHORT', 'NEUTRAL']);
export type JudgeDirection = z.infer<typeof JudgeDirection>;

export const JudgeInvalidator = z.discriminatedUnion('type', [
  z.object({ type: z.literal('price_above'), value: z.number() }),
  z.object({ type: z.literal('price_below'), value: z.number() }),
  z.object({ type: z.literal('ttl_expired'), horizon: z.string() }),
  z.object({ type: z.literal('funding_extreme'), threshold: z.number() }),
  z.object({ type: z.literal('stop_moved'), price: z.number() }),
]);
export type JudgeInvalidator = z.infer<typeof JudgeInvalidator>;

/** Every string + array has a cap. A runaway response fails validation → INVALID_JSON. */
export const JudgeOutput = z.object({
  direction: JudgeDirection,
  confidence: z.number().min(0).max(1),
  thesis: z.string().min(1).max(1000),
  keyRisks: z.array(z.string().max(200)).max(6),
  invalidators: z.array(JudgeInvalidator).max(4),
  confidenceTag: z.enum(['weak', 'moderate', 'strong']),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;
