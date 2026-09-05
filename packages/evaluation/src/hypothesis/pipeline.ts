/**
 * Hypothesis pipeline driver (§24). One entry point:
 *   1. aggregatePatterns → candidate patterns above the effective-n ≥ 20 floor
 *   2. proposeFromPattern → hypothesis rows (unknown categories are skipped)
 *   3. persistHypothesis (PROPOSED) — one row per (setupId, category, categoryKind)
 *
 * Backtest + OOS + promotion are separate operator-driven steps (m7-hypothesis-pipeline
 * design.md — human decides when to actually promote). The driver here just OPENS the
 * proposals.
 *
 * §16 descriptive-not-prescriptive — this module has NO import of `deepseek` or `llm` (the
 * LLM's role ended at autopsy narrative). Asserted by a structural test.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { learningHypothesis, type Db } from '@tip/database';
import { aggregatePatterns } from './aggregate.js';
import { proposeFromPattern, type ProposedHypothesis } from './propose.js';

export interface OpenHypothesesInput {
  readonly db: Db;
  readonly asOf: Date;
  /** Test seam — defaults to production floor (§24). */
  readonly minEvidenceN?: number;
}

export interface OpenHypothesesResult {
  readonly openedCount: number;
  readonly skippedNoMapping: number;
  readonly alreadyOpen: number;
  readonly proposals: readonly ProposedHypothesis[];
}

/**
 * Statuses that block re-opening the same (setupId, category, kind):
 *   - in-flight (PROPOSED / BACKTEST_PASSED / OOS_PENDING / OOS_PASSED) — already being processed
 *   - PROMOTED — the change is APPLIED; re-opening would double the delta on the next run
 * REJECTED and DEFERRED_BOOTSTRAP are intentionally NOT blocking — they mean "not now, retry when
 * evidence changes" (more autopsies clustered, or the domain matured past bootstrap). A re-run
 * legitimately reconsiders them.
 */
const BLOCKING_STATUSES = ['PROPOSED', 'BACKTEST_PASSED', 'OOS_PENDING', 'OOS_PASSED', 'PROMOTED'];

async function findExistingOpen(db: Db, p: ProposedHypothesis): Promise<boolean> {
  const rows = await db.select({ id: learningHypothesis.id }).from(learningHypothesis).where(and(
    eq(learningHypothesis.setupId, p.setupId),
    eq(learningHypothesis.category, p.category),
    eq(learningHypothesis.categoryKind, p.categoryKind),
    inArray(learningHypothesis.status, BLOCKING_STATUSES),
  )).limit(1);
  return rows.length > 0;
}

/**
 * Run one sweep: find eligible patterns, propose against the known category table, insert new
 * PROPOSED rows. Skips a pattern that already has an in-flight or PROMOTED row for the same
 * (setupId, category, kind) — the idempotent guard. REJECTED / DEFERRED_BOOTSTRAP rows are
 * reconsidered (a re-run may now have the evidence to pass).
 */
export async function openHypotheses(input: OpenHypothesesInput): Promise<OpenHypothesesResult> {
  let opened = 0; let noMapping = 0; let already = 0;
  const proposals: ProposedHypothesis[] = [];
  for await (const pattern of aggregatePatterns(input.db, {
    domain: 'perp', asOf: input.asOf,
    ...(input.minEvidenceN !== undefined ? { minEvidenceN: input.minEvidenceN } : {}),
  })) {
    const proposal = proposeFromPattern(pattern);
    if (!proposal) { noMapping++; continue; }
    proposals.push(proposal);
    if (await findExistingOpen(input.db, proposal)) { already++; continue; }
    await input.db.insert(learningHypothesis).values({
      id: randomUUID(),
      setupId: proposal.setupId, domain: proposal.domain,
      category: proposal.category, categoryKind: proposal.categoryKind,
      evidenceCount: String(proposal.evidenceCount),
      proposedChange: proposal.proposedChange,
      status: 'PROPOSED',
    });
    opened++;
  }
  return { openedCount: opened, skippedNoMapping: noMapping, alreadyOpen: already, proposals };
}
