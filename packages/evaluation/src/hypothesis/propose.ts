/**
 * Category → weight-delta table. §24: the LLM never proposes the numeric weight change — the
 * PATTERN (recurring category) triggers a proposal, but the size of the delta lives in code
 * where it's reviewable. §33 rule 13.
 *
 * Deltas start small (2–3%). §24's example (10% → 18%) is a large jump; that requires several
 * rounds of promotion. Conservative because a promoted change is hard to unwind.
 */
export type CategoryKind = 'FAILURE' | 'SUCCESS';

/** Tunable scalar config params the learning loop may adjust (beyond agent weights). */
export type TunableParam = 'minStopAtrMult' | 'takeProfitAtrMult';

/** Bounds for each tunable param — the loop can never push it outside these (clamped on apply). */
export const PARAM_BOUNDS: Readonly<Record<TunableParam, { min: number; max: number }>> = {
  minStopAtrMult: { min: 0, max: 3 },
  // TP distance cap in ATRs. Lower = nearer target (closes within the horizon more often), but a
  // TP pulled below minRR × stop makes the setup fail the R:R gate — that filtering is intended.
  takeProfitAtrMult: { min: 1, max: 6 },
};

export type ProposedChange =
  | { readonly kind: 'weightDelta'; readonly agentKey: string; readonly delta: number }
  | { readonly kind: 'paramDelta'; readonly param: TunableParam; readonly delta: number }
  // Widen the NEUTRAL dead-zone by `delta` on each side (weakLong += delta, weakShort -= delta),
  // clamped so the weak thresholds never cross the long/short thresholds. Filters marginal
  // low-conviction signals — they become NEUTRAL and don't trade.
  | { readonly kind: 'thresholdWiden'; readonly delta: number };

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
  // Stop-sizing (not an agent weight): a cluster of trades stopped by noise then moving the
  // predicted way → widen the ATR-based stop buffer. The LLM only TAGS the pattern; this
  // +0.25 step lives in code (rule 13). Clamped to PARAM_BOUNDS on apply; a re-run re-opens
  // it only if STOP_TOO_TIGHT still clusters, so it steps up gradually, never runs away.
  STOP_TOO_TIGHT:            { kind: 'FAILURE', change: { kind: 'paramDelta', param: 'minStopAtrMult',    delta: +0.25 } },
  // Chop / over-trading (data autopsy 2026-09-06: 35% of trades expired flat in a rangebound
  // market). The regime agent should have vetoed a no-move entry → raise its weight so the
  // composite leans harder on the regime read and stops firing in chop.
  NO_FOLLOW_THROUGH:         { kind: 'FAILURE', change: { kind: 'weightDelta', agentKey: 'perp.market_regime', delta: +0.02 } },
  // Target too ambitious (11%): trade reached >60% of the way to TP but the target was too far
  // to close within the horizon → pull the TP cap in. Mirror of STOP_TOO_TIGHT. If pulling it in
  // drops R:R below minRR the setup gets filtered — intended.
  TARGET_TOO_FAR:            { kind: 'FAILURE', change: { kind: 'paramDelta', param: 'takeProfitAtrMult', delta: -0.25 } },
  // Wrong from entry (17%): immediate adverse move, no favorable excursion. Data autopsy
  // 2026-09-06 — 79% of these are WEAK-band signals (|score| < 0.45, median 0.31) and 0% are
  // STRONG, with blame spread diffusely across agents. So it's a CONVICTION problem, not an
  // agent problem: widen the NEUTRAL dead-zone so marginal signals stop trading.
  WRONG_FROM_ENTRY:          { kind: 'FAILURE', change: { kind: 'thresholdWiden', delta: +0.05 } },
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

/**
 * Apply ANY proposed change to a config object, returning the fields to merge. `weightDelta`
 * returns a renormalized `agentWeights`; `paramDelta` returns the single scalar param, clamped to
 * PARAM_BOUNDS. Kept generic (`Record<string, unknown>` in) so promote.ts stays the only place
 * that knows the full ScoringConfig shape.
 */
export function applyChange(
  config: Readonly<Record<string, unknown>>,
  change: ProposedChange,
): Record<string, unknown> {
  if (change.kind === 'weightDelta') {
    const weights = (config.agentWeights as Record<string, number> | undefined) ?? {};
    return { agentWeights: applyWeightDelta(weights, change) };
  }
  if (change.kind === 'thresholdWiden') {
    // Widen the NEUTRAL dead-zone symmetrically; never let a weak threshold cross its long/short.
    const t = { ...((config.signalThresholds as Record<string, number> | undefined) ?? {}) };
    const longCap = t.long ?? 0.45;
    const shortCap = t.short ?? -0.45;
    if (t.weakLong !== undefined) t.weakLong = Math.min(longCap, t.weakLong + change.delta);
    if (t.weakShort !== undefined) t.weakShort = Math.max(shortCap, t.weakShort - change.delta);
    return { signalThresholds: t };
  }
  // paramDelta — bump the scalar, clamp to bounds.
  const bounds = PARAM_BOUNDS[change.param];
  const cur = typeof config[change.param] === 'number' ? (config[change.param] as number) : boundsDefault(change.param);
  const next = Math.max(bounds.min, Math.min(bounds.max, cur + change.delta));
  return { [change.param]: next };
}

/** Sensible starting value for a tunable param when the config doesn't carry one yet. */
function boundsDefault(param: TunableParam): number {
  switch (param) {
    case 'minStopAtrMult': return 1.0;    // matches the config.ts default
    case 'takeProfitAtrMult': return 3.0; // starts loose (~median TP); TARGET_TOO_FAR pulls it in
  }
}
