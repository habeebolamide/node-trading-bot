import { describe, it, expect } from 'vitest';
import { formatGateReport, type GateReport } from './gate.js';

const baseReport: GateReport = {
  range: { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z') },
  symbols: ['BTCUSDT', 'ETHUSDT'],
  configVersion: 1,
  totals: { stepsWalked: 4300, signalsCreated: 240, predictionsCreated: 210, outcomesResolved: 210, noTrades: 30, skippedNeutral: 4050, errors: 0 },
  fingerprintsEncountered: 780, fingerprintsAtTrust: 210, trustFraction: 210 / 780,
  seededWinRate: 0.58,
  winRateByRegime: { LOW: null, MED: null, HIGH: null },
  warnings: [],
};

describe('formatGateReport', () => {
  it('includes every headline field a human needs to decide "launch or not"', () => {
    const out = formatGateReport(baseReport);
    expect(out).toContain('Brain Seeding Gate Report');
    expect(out).toContain('Steps walked           : 4300');
    expect(out).toContain('Predictions created    : 210');
    expect(out).toContain('Fingerprints encountered : 780');
    expect(out).toContain('Fingerprints at trust    : 210');
    expect(out).toContain('Seeded win rate          : 58.0%');
    expect(out).toContain('No warnings.');
  });

  it('surfaces WARNINGS prominently when they exist — this is the whole point', () => {
    const out = formatGateReport({ ...baseReport, warnings: ['bad thing 1', 'bad thing 2'] });
    expect(out).toContain('WARNINGS:');
    expect(out).toContain('bad thing 1');
    expect(out).toContain('bad thing 2');
    expect(out).not.toContain('No warnings.');
  });
});
