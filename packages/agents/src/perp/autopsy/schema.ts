/**
 * Autopsy response schema (§24 output). Every field capped — a runaway response fails
 * validation → INVALID_JSON is logged → row inserts with status=FAILED_LLM.
 *
 * WIN/LOSS field-presence rule: `successFactor` present on WIN, `failureCategory` present on
 * LOSS. The database CHECK enforces this too so a bad payload cannot land as a bad row.
 */
import { z } from 'zod';

export const AutopsyAgentFailure = z.object({
  agent: z.string().min(1).max(60),
  assessment: z.string().max(200),
  impact: z.enum(['high', 'medium', 'low']),
});

export const AutopsyOutput = z.object({
  rootCause: z.string().min(1).max(200),
  failureCategory: z.string().max(80).optional(),
  successFactor: z.string().max(80).optional(),
  explanation: z.string().min(1).max(2000),
  contributingFactors: z.array(z.string().max(200)).max(10),
  agentFailures: z.array(AutopsyAgentFailure).max(15),
  lesson: z.string().max(500),
  recommendation: z.string().max(500),
});
export type AutopsyOutput = z.infer<typeof AutopsyOutput>;

/** Runtime WIN/LOSS presence rule — the DB CHECK is the ultimate guard, but early rejection
 *  lets the caller log a specific INVALID_JSON message rather than a Postgres CHECK error. */
export function validateOutcomeFields(o: AutopsyOutput, outcome: 'WIN' | 'LOSS'): void | never {
  if (outcome === 'WIN' && (!o.successFactor || o.failureCategory)) {
    throw new Error(`autopsy WIN row must have successFactor and no failureCategory (got successFactor=${o.successFactor ?? 'null'}, failureCategory=${o.failureCategory ?? 'null'})`);
  }
  if (outcome === 'LOSS' && (!o.failureCategory || o.successFactor)) {
    throw new Error(`autopsy LOSS row must have failureCategory and no successFactor`);
  }
}
