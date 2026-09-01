/**
 * Perp Historical Edge feature (§40.16). STUB at M4 — the real read of `BrainSetupMemory`
 * lands in M5 (BrainSetupMemory is populated as M6 outcomes resolve). Returns `INSUFFICIENT`
 * with score 0 so the composite treats it as "no historical evidence."
 *
 * When M5 wires the real feature, this file stays as the interface — just the implementation
 * changes. The composite's `historicalEvidence` sub-metric in confidence.ts also stubs at 0.5
 * until then; both come alive together.
 */
export interface HistoricalEdgeResult {
  evidence: 'SUFFICIENT' | 'INSUFFICIENT';
  score: number; // signed [-1, +1]; 0 when INSUFFICIENT
  ciWidth: number | null; // Wilson width when SUFFICIENT
  fingerprint?: string;
}

/** M4 stub — always INSUFFICIENT. Signature matches what the M5 real feature will expose. */
export function historicalEdgeStub(): HistoricalEdgeResult {
  return { evidence: 'INSUFFICIENT', score: 0, ciWidth: null };
}
