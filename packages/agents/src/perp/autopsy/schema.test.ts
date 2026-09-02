import { describe, it, expect } from 'vitest';
import { AutopsyOutput, validateOutcomeFields } from './schema.js';

const baseWin = {
  rootCause: 'momentum confirmed early', successFactor: 'MOMENTUM_CONFIRMED_EARLY',
  explanation: 'the momentum agent lead was corroborated by OI expansion within 15 minutes',
  contributingFactors: ['OI expanding', 'regime aligned'],
  agentFailures: [], lesson: 'trust momentum when OI agrees', recommendation: 'no change',
};
const baseLoss = {
  ...baseWin, successFactor: undefined, failureCategory: 'POSITIONING_MISREAD',
};

describe('AutopsyOutput schema', () => {
  it('accepts a well-formed WIN row', () => {
    expect(AutopsyOutput.safeParse(baseWin).success).toBe(true);
  });
  it('accepts a well-formed LOSS row', () => {
    expect(AutopsyOutput.safeParse(baseLoss).success).toBe(true);
  });
  it('caps runaway text/arrays', () => {
    expect(AutopsyOutput.safeParse({ ...baseWin, explanation: 'x'.repeat(2001) }).success).toBe(false);
    expect(AutopsyOutput.safeParse({ ...baseWin, contributingFactors: Array(11).fill('x') }).success).toBe(false);
  });
  it('validateOutcomeFields — WIN with failureCategory rejected', () => {
    expect(() => validateOutcomeFields({ ...baseWin, failureCategory: 'X' } as never, 'WIN')).toThrow();
  });
  it('validateOutcomeFields — LOSS with successFactor rejected', () => {
    expect(() => validateOutcomeFields({ ...baseLoss, successFactor: 'X' } as never, 'LOSS')).toThrow();
  });
  it('validateOutcomeFields — WIN missing successFactor rejected', () => {
    expect(() => validateOutcomeFields({ ...baseWin, successFactor: undefined } as never, 'WIN')).toThrow();
  });
});
