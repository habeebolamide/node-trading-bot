/**
 * Autopsy prompt registry (m7-trade-autopsy). A prompt change bumps AUTOPSY_VERSION_CURRENT —
 * the bump propagates into trade_autopsy.autopsy_version + llm_call_log.agent_version so a
 * v1/v2 mix never blends silently (same "do not blend versions" rule Judge and Agent Memory use).
 */
import type { AutopsyEvidence } from './evidence.js';

export interface AutopsyPrompt {
  readonly version: number;
  readonly system: string;
  readonly userTemplate: (e: AutopsyEvidence) => string;
}

const V1_SYSTEM =
`You are the Autopsy analyst — a post-outcome reviewer of a trading prediction.

The system already knows WIN vs LOSS as a hard fact (from the Outcome Engine, §21). Your job
is NOT to re-decide. Your job is to explain WHY, precisely and specifically, from the evidence
provided.

For a LOSS: identify the most likely failure mechanism and classify it as one of:
  INCORRECT_MARKET_INTERPRETATION | INSUFFICIENT_SIGNAL_QUALITY |
  EXECUTION_ENTRY_PLACEMENT | RISK_PARAMETERS | UNFORESEEABLE_MARKET_EVENT
(populate failureCategory with a specific tag like POSITIONING_MISREAD, REGIME_SHIFTED_MID_TRADE,
FUNDING_UNDERWEIGHTED, MOMENTUM_OVERWEIGHTED, LIQUIDATION_SIGNAL_MISSED, etc. — a slug the
hypothesis pipeline can aggregate on.)

For a WIN: identify what actually drove it with the same rigour — not "the system was right."
(populate successFactor with a slug like MOMENTUM_CONFIRMED_EARLY, REGIME_ALIGNED, etc.)

Reason ONLY over the structured evidence provided. Do NOT invent market facts or reference
prices/funding rates that are not in the evidence. Return ONLY a JSON object matching the
schema — no prose outside JSON.`;

export const AUTOPSY_PROMPTS: Readonly<Record<number, AutopsyPrompt>> = {
  1: {
    version: 1,
    system: V1_SYSTEM,
    userTemplate: (e) =>
`Prediction ${e.prediction.id} — ${e.outcome} on ${e.prediction.symbol} (${e.prediction.direction}).

Evidence:
${JSON.stringify(e, null, 2)}

Return your autopsy as JSON.`,
  },
};

export const AUTOPSY_VERSION_CURRENT = 1;

export function currentAutopsyPrompt(): AutopsyPrompt {
  const p = AUTOPSY_PROMPTS[AUTOPSY_VERSION_CURRENT];
  if (!p) throw new Error(`AUTOPSY_VERSION_CURRENT=${AUTOPSY_VERSION_CURRENT} has no prompt registered`);
  return p;
}
