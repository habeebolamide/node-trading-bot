import { describe, it, expect } from 'vitest';
import { decide, directionSign } from './gate.js';

const cfg = { overrideGate: { flipDetConfMax: 0.7, flipGap: 0.2, standAsideDetConfMin: 0.7, standAsideLlmConfMax: 0.7 } };

describe('directionSign', () => {
  it('collapses M4 buckets to signed ints', () => {
    for (const d of ['STRONG_LONG', 'LONG', 'WEAK_LONG']) expect(directionSign(d)).toBe(1);
    for (const d of ['STRONG_SHORT', 'SHORT', 'WEAK_SHORT']) expect(directionSign(d)).toBe(-1);
    expect(directionSign('NEUTRAL')).toBe(0);
  });
});

describe('decide — §18 worked examples verbatim', () => {
  it('same-sign directions → AGREE regardless of confidences', () => {
    expect(decide({ detDirection: 'LONG', detConfidence: 0.9, judgeDirection: 'STRONG_LONG', judgeConfidence: 0.4, config: cfg }).action).toBe('AGREE');
    expect(decide({ detDirection: 'SHORT', detConfidence: 0.6, judgeDirection: 'WEAK_SHORT', judgeConfidence: 0.9, config: cfg }).action).toBe('AGREE');
  });

  it('det 0.45 / llm 0.85 → FLIP (§18 first example)', () => {
    const r = decide({ detDirection: 'LONG', detConfidence: 0.45, judgeDirection: 'SHORT', judgeConfidence: 0.85, config: cfg });
    expect(r.action).toBe('FLIP');
    expect(r.gap).toBeCloseTo(0.4, 6);
  });

  it('det 0.90 / llm 0.55 → STAND_ASIDE (§18 second example)', () => {
    const r = decide({ detDirection: 'LONG', detConfidence: 0.9, judgeDirection: 'SHORT', judgeConfidence: 0.55, config: cfg });
    expect(r.action).toBe('STAND_ASIDE');
  });

  it('det 0.90 / llm 0.75 → DEFER — both confident, gap 0.15 < 0.2 anyway', () => {
    expect(decide({ detDirection: 'LONG', detConfidence: 0.9, judgeDirection: 'SHORT', judgeConfidence: 0.75, config: cfg }).action).toBe('DEFER');
  });

  it('det 0.40 / llm 0.25 → DEFER — weaker judge dissent never flips (§18 judgeConf > detConf guard)', () => {
    expect(decide({ detDirection: 'LONG', detConfidence: 0.4, judgeDirection: 'SHORT', judgeConfidence: 0.25, config: cfg }).action).toBe('DEFER');
  });

  it('NEUTRAL judge → DEFER even with confident deterministic (nothing to flip TO)', () => {
    expect(decide({ detDirection: 'LONG', detConfidence: 0.9, judgeDirection: 'NEUTRAL', judgeConfidence: 0.8, config: cfg }).action).toBe('DEFER');
  });

  it('gap exactly = flipGap threshold is INCLUSIVE (documented behaviour)', () => {
    // det 0.4 / llm 0.6 → gap 0.2; det<0.7; judge>det → FLIP.
    expect(decide({ detDirection: 'LONG', detConfidence: 0.4, judgeDirection: 'SHORT', judgeConfidence: 0.6, config: cfg }).action).toBe('FLIP');
  });

  it('config tightening: raise flipGap to 0.5 → the 0.45/0.85 case DEFERS instead', () => {
    const tight = { overrideGate: { ...cfg.overrideGate, flipGap: 0.5 } };
    // 0.45/0.85 gap is 0.4, below the tightened 0.5.
    expect(decide({ detDirection: 'LONG', detConfidence: 0.45, judgeDirection: 'SHORT', judgeConfidence: 0.85, config: tight }).action).toBe('DEFER');
  });
});
