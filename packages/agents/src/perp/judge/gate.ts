/**
 * §18 FLIP / STAND_ASIDE / DEFER gate. Pure function — same inputs → same output. The four
 * thresholds live on `ScoringConfig.overrideGate`, versioned like every other scoring input
 * (rule 16). Change 3 of M7.
 */
import type { ScoringConfig } from '@tip/trading-agents';

export type JudgeAction = 'AGREE' | 'FLIP' | 'STAND_ASIDE' | 'DEFER';

/** Collapse an M4 direction bucket into signed +1 (long side), -1 (short side), or 0 (neutral). */
export function directionSign(d: string): -1 | 0 | 1 {
  if (d === 'NEUTRAL') return 0;
  return d.endsWith('LONG') ? 1 : d.endsWith('SHORT') ? -1 : 0;
}

export interface GateInput {
  readonly detDirection: string;
  readonly detConfidence: number;
  readonly judgeDirection: string;
  readonly judgeConfidence: number;
  readonly config: Pick<ScoringConfig, 'overrideGate'>;
}

export interface GateResult {
  readonly action: JudgeAction;
  readonly gap: number;
}

/**
 * §18's rules in order. Short-circuits on the first match.
 *
 *   AGREE if signs equal
 *   FLIP  if det<flipDetConfMax && gap>=flipGap && judge>det
 *   STAND_ASIDE if det>=standAsideDetConfMin && judge<standAsideLlmConfMax && gap>=flipGap
 *   DEFER otherwise
 *
 * NEUTRAL judgment → DEFER (nothing to flip TO); handled by the sign collapse — a NEUTRAL
 * Judge can never satisfy the FLIP direction-flip requirement.
 */
export function decide(input: GateInput): GateResult {
  const { flipDetConfMax, flipGap, standAsideDetConfMin, standAsideLlmConfMax } = input.config.overrideGate;
  // Epsilon guards against float artefacts on boundary cases: |0.6 − 0.4| in IEEE-754 is
  // 0.19999999999999996, which would silently classify a documented gap==threshold as below
  // the threshold. 1e-9 is well below any policy-meaningful precision on these thresholds.
  const EPS = 1e-9;
  const gap = Math.abs(input.detConfidence - input.judgeConfidence);
  const gapCrossed = gap + EPS >= flipGap;

  const detSign = directionSign(input.detDirection);
  const judgeSign = directionSign(input.judgeDirection);
  if (detSign !== 0 && detSign === judgeSign) {
    return { action: 'AGREE', gap };
  }
  // NEUTRAL judge → DEFER (nothing to flip to). A neutral det with a strong judge could FLIP,
  // but §18's example calls this DEFER because a NEUTRAL det never entered a directional trade
  // in the first place.
  if (judgeSign === 0 || detSign === 0) {
    return { action: 'DEFER', gap };
  }
  // Directions differ from here on.
  if (
    input.detConfidence < flipDetConfMax
    && gapCrossed
    && input.judgeConfidence > input.detConfidence
  ) {
    return { action: 'FLIP', gap };
  }
  if (
    input.detConfidence >= standAsideDetConfMin
    && input.judgeConfidence < standAsideLlmConfMax
    && gapCrossed
  ) {
    return { action: 'STAND_ASIDE', gap };
  }
  return { action: 'DEFER', gap };
}
