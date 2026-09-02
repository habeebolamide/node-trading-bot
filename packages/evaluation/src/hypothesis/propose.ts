/**
 * Category → weight-delta table. §24: the LLM never proposes the numeric weight change — the
 * PATTERN (recurring category) triggers a proposal, but the size of the delta lives in code
 * where it's reviewable. §33 rule 13.
 *
 * Deltas start small (2–3%). §24's example (10% → 18%) is a large jump; that requires several
 * rounds of promotion. Conservative because a promoted change is hard to unwind.
 */
export type CategoryKind = 'FAILURE' | 'SUCCESS';

export type ProposedChange =
  | { readonly kind: 'weightDelta'; readonly agentKey: string; readonly delta: number };

export interface CategoryEntry {
  readonly kind: CategoryKind;
  readonly change: ProposedChange;
}

/**
 * V1 table. Adding a category is a code change, review-visible; the pipeline REFUSES to
 * propose for an unknown category (returns null in `proposeFromPattern`) rather than
 * guess a mapping.
 */
export const CATEGORY_TO_ADJUSTMENT_V1: Readonly<Record<string, CategoryEntry>> = {
  POSITIONING_MISREAD:       { kind: 'FAILURE', change: { kind: 'weightDelta', agentKey: 'perp.positioning',   delta: +0.03 } },
  MOMENTUM_OVERWEIGHTED:     { kind: 'FAILURE', change: { kind: 'weightDelta', agentKey: 'perp.momentum',      delta: -0.03 } },
  REGIME_SHIFTED_MID_TRADE:  { kind: 'FAILURE', change: { kind: 'weightDelta', agentKey: 'perp.market_regime', delta: +0.02 } },
  FUNDING_UNDERWEIGHTED:     { kind: 'FAILURE', change: { kind: 'weightDelta', agentKey: 'perp.funding',       delta: +0.03 } },
  LIQUIDATION_SIGNAL_MISSED: { kind: 'FAILURE', change: { kind: 'weightDelta', agentKey: 'perp.liquidation',   delta: +0.02 } },
  MOMENTUM_CONFIRMED_EARLY:  { kind: 'SUCCESS', change: { kind: 'weightDelta', agentKey: 'perp.momentum',      delta: +0.02 } },
  REGIME_ALIGNED:            { kind: 'SUCCESS', change: { kind: 'weightDelta', agentKey: 'perp.market_regime', delta: +0.02 } },
};

export interface Pattern {
  readonly setupId: string;
  readonly domain: 'perp';
  readonly category: string;
  readonly categoryKind: CategoryKind;
  readonly evidenceCount: number;
}

export interface ProposedHypothesis {
  readonly setupId: string;
  readonly domain: 'perp';
  readonly category: string;
  readonly categoryKind: CategoryKind;
  readonly evidenceCount: number;
  readonly proposedChange: ProposedChange;
}

/** Unknown category → null (no proposal). Extending the table is a code change. */
export function proposeFromPattern(pattern: Pattern): ProposedHypothesis | null {
  const entry = CATEGORY_TO_ADJUSTMENT_V1[pattern.category];
  if (!entry) return null;
  // Sanity: the entry's kind must match the pattern's — a WIN row must not propose a FAILURE
  // remediation and vice versa.
  if (entry.kind !== pattern.categoryKind) return null;
  return {
    setupId: pattern.setupId, domain: pattern.domain,
    category: pattern.category, categoryKind: pattern.categoryKind,
    evidenceCount: pattern.evidenceCount,
    proposedChange: entry.change,
  };
}

/** Apply a delta to a weights map, renormalizing to sum 1. */
export function applyWeightDelta(
  weights: Readonly<Record<string, number>>,
  change: ProposedChange,
): Record<string, number> {
  if (change.kind !== 'weightDelta') return { ...weights };
  const raw: Record<string, number> = { ...weights };
  const cur = raw[change.agentKey] ?? 0;
  raw[change.agentKey] = Math.max(0, cur + change.delta);
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  if (total <= 0) return { ...weights };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v / total;
  return out;
}
