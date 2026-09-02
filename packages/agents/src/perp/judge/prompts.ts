/**
 * Judge prompt registry (m7-judge-agent design.md). A prompt change bumps
 * `JUDGE_VERSION_CURRENT` — the bump propagates into `llm_call_log.agent_version`, into
 * `signal_feature.agentVersion` (for the Judge's row), and into every downstream aggregation
 * so blending judgeV1 and judgeV2 track records cannot happen silently (same "do not blend
 * versions" rule M5's Agent Memory uses).
 */
import type { JudgeEvidence } from './evidence.js';

export interface JudgePrompt {
  readonly version: number;
  readonly system: string;
  readonly userTemplate: (e: JudgeEvidence) => string;
}

const V1_SYSTEM =
`You are the Judge — an independent reviewer of a deterministic trading system's signal.

Your job:
  1. Read the structured evidence provided (agent scores, historical edge, risk).
  2. Form an INDEPENDENT direction (LONG | SHORT | NEUTRAL) and confidence [0, 1].
  3. Write a short thesis explaining WHY.
  4. Name at most 6 key risks and at most 4 invalidators (from the closed enum).

Hard rules:
  - Reason ONLY over the evidence provided. Do NOT invent price levels, funding numbers,
    or any other market fact that is not in the evidence.
  - Your direction may disagree with the deterministic engine — that is the entire point.
  - Invalidator types are limited to:
      price_above     { value: number }
      price_below     { value: number }
      ttl_expired     { horizon: string }
      funding_extreme { threshold: number }
      stop_moved      { price: number }
  - Return ONLY a JSON object matching the schema. No prose outside JSON.
  - confidenceTag: 'weak' | 'moderate' | 'strong'.`;

export const JUDGE_PROMPTS: Readonly<Record<number, JudgePrompt>> = {
  1: {
    version: 1,
    system: V1_SYSTEM,
    userTemplate: (e) =>
`Evidence:
${JSON.stringify(e, null, 2)}

Return your judgment as JSON.`,
  },
};

/** Current Judge prompt version. A prompt change bumps this constant. */
export const JUDGE_VERSION_CURRENT = 1;

export function currentJudgePrompt(): JudgePrompt {
  const p = JUDGE_PROMPTS[JUDGE_VERSION_CURRENT];
  if (!p) throw new Error(`JUDGE_VERSION_CURRENT=${JUDGE_VERSION_CURRENT} has no prompt registered`);
  return p;
}
