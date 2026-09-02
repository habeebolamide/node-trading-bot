/**
 * Pre-launch gate report (§30 / §32 bootstrap-window discipline). REPORTED, not asserted — §32
 * asks for "an explicit minimum-maturity bar per domain" and deliberately leaves the number to
 * judgement. The report is what the human uses to decide; the code refuses to make the call.
 *
 * A prominent WARNING flag fires when the seeded win rate is implausibly high, because the
 * temptation to celebrate a 78% seeded win rate is exactly how a look-ahead bug survives
 * review. §25 mentions this failure mode explicitly.
 */
import { and, count, eq } from 'drizzle-orm';
import {
  brainSetupMemory, brainSetupOccurrence, prediction, predictionOutcome, type Db,
} from '@tip/database';
import type { SeedStats } from './seed.js';

export interface GateReport {
  readonly range: { from: Date; to: Date };
  readonly symbols: readonly string[];
  readonly configVersion: number;
  readonly totals: {
    stepsWalked: number; signalsCreated: number; predictionsCreated: number;
    outcomesResolved: number; noTrades: number; skippedNeutral: number; errors: number;
  };
  readonly fingerprintsEncountered: number;
  readonly fingerprintsAtTrust: number;
  readonly trustFraction: number;
  readonly seededWinRate: number | null;
  readonly winRateByRegime: Record<'LOW' | 'MED' | 'HIGH', number | null>;
  readonly warnings: readonly string[];
}

const PLAUSIBLE_MAX_WIN_RATE = 0.72;  // above this on a seeded set almost always means look-ahead

export async function buildGateReport(
  db: Db,
  input: { range: { from: Date; to: Date }; symbols: readonly string[]; configVersion: number; perSymbol: readonly SeedStats[] },
): Promise<GateReport> {
  const totals = input.perSymbol.reduce((acc, s) => ({
    stepsWalked: acc.stepsWalked + s.stepsWalked,
    signalsCreated: acc.signalsCreated + s.signalsCreated,
    predictionsCreated: acc.predictionsCreated + s.predictionsCreated,
    outcomesResolved: acc.outcomesResolved + s.outcomesResolved,
    noTrades: acc.noTrades + s.noTrades,
    skippedNeutral: acc.skippedNeutral + s.skippedNeutral,
    errors: acc.errors + s.errors,
  }), { stepsWalked: 0, signalsCreated: 0, predictionsCreated: 0, outcomesResolved: 0, noTrades: 0, skippedNeutral: 0, errors: 0 });

  const memRows = await db.select().from(brainSetupMemory).where(eq(brainSetupMemory.domain, 'perp'));
  const fingerprintsEncountered = memRows.length;
  const fingerprintsAtTrust = memRows.filter((r) => r.evidence === 'SUFFICIENT').length;
  const trustFraction = fingerprintsEncountered > 0 ? fingerprintsAtTrust / fingerprintsEncountered : 0;

  const outcomes = await db.select({
    won: predictionOutcome.won,
  }).from(predictionOutcome)
    .innerJoin(prediction, eq(prediction.id, predictionOutcome.predictionId))
    .where(and(eq(prediction.configVersion, input.configVersion), eq(predictionOutcome.outcomeResolution, 'CANDLE_1M_CONSERVATIVE')));
  const seededN = outcomes.length;
  const seededWins = outcomes.filter((o) => o.won).length;
  const seededWinRate = seededN > 0 ? seededWins / seededN : null;

  // Regime breakdown is best-effort — reading from occurrences already indexed by setupId.
  // For MVP we leave the exact regime bucketing to change 5's `market()` (memecoin) and defer
  // a perp equivalent that would slice by the fingerprint's regime dimension; the gate report
  // exposes the field so future runs can populate it without a shape change.
  const winRateByRegime = { LOW: null, MED: null, HIGH: null } as Record<'LOW' | 'MED' | 'HIGH', number | null>;
  void brainSetupOccurrence; void count;

  const warnings: string[] = [];
  if (seededWinRate !== null && seededWinRate > PLAUSIBLE_MAX_WIN_RATE) {
    warnings.push(
      `WARNING: seeded win rate ${(seededWinRate * 100).toFixed(1)}% is implausibly high. §25 flags this` +
      ` pattern as a red flag for LOOK-AHEAD, not edge. Investigate the resolver + agent view before treating this run as a valid seed.`,
    );
  }
  if (totals.errors > 0) {
    warnings.push(`WARNING: ${totals.errors} step errors during seeding — check logs and consider re-running the affected range.`);
  }
  if (fingerprintsEncountered === 0) {
    warnings.push('WARNING: no perp fingerprints encountered — did the backfill actually load bars for the requested range?');
  }

  return {
    range: input.range, symbols: input.symbols, configVersion: input.configVersion,
    totals, fingerprintsEncountered, fingerprintsAtTrust, trustFraction,
    seededWinRate, winRateByRegime, warnings,
  };
}

export function formatGateReport(r: GateReport): string {
  const lines: string[] = [];
  lines.push('=== Brain Seeding Gate Report ===');
  lines.push(`Range: ${r.range.from.toISOString()} → ${r.range.to.toISOString()}`);
  lines.push(`Symbols: ${r.symbols.join(', ')}`);
  lines.push(`ConfigVersion: ${r.configVersion}`);
  lines.push('');
  lines.push(`Steps walked           : ${r.totals.stepsWalked}`);
  lines.push(`Signals created        : ${r.totals.signalsCreated}`);
  lines.push(`Predictions created    : ${r.totals.predictionsCreated}`);
  lines.push(`Outcomes resolved      : ${r.totals.outcomesResolved}`);
  lines.push(`NO_TRADE vetoes        : ${r.totals.noTrades}`);
  lines.push(`Skipped (NEUTRAL)      : ${r.totals.skippedNeutral}`);
  lines.push(`Errors                 : ${r.totals.errors}`);
  lines.push('');
  lines.push(`Fingerprints encountered : ${r.fingerprintsEncountered}`);
  lines.push(`Fingerprints at trust    : ${r.fingerprintsAtTrust}  (${(r.trustFraction * 100).toFixed(1)}%)`);
  lines.push(`Seeded win rate          : ${r.seededWinRate === null ? 'n/a' : (r.seededWinRate * 100).toFixed(1) + '%'}`);
  lines.push('');
  if (r.warnings.length === 0) {
    lines.push('No warnings.');
  } else {
    lines.push('WARNINGS:');
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
