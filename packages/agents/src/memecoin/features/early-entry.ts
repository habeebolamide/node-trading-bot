/**
 * Memecoin Early-Entry Edge feature (§40.17). Aggregator-only — NOT an Agent (no trigger, no
 * version, no performance record; §7). Weighted 15% of the memecoin composite (Part II §9).
 *
 * Reads `BrainWalletMemory.earlyEntry` (populated by M2 change 2's wallet scoring). Peak
 * forward-return per triggering wallet is the headline signal (§40.17). Coverage-aware
 * down-weighting keeps thin stats from over-influencing.
 */
import { eq, inArray } from 'drizzle-orm';
import { brainWalletMemory, type Db } from '@tip/database';

export interface EarlyEntryInput {
  wallet: string;
  walletScore: number;
  amountSol: number;
}

export interface EarlyEntryOutput {
  score: number; // 0..1, weighted by wallet score × amountSol × coverage × peakForwardReturn
  coverage: number; // mean coverage across triggering wallets — feeds dataQuality
  peakMedian: number | null; // headline peak fwd return across contributing wallets
  perWallet: { wallet: string; peakMedian: number | null; coverage: number }[];
}

/**
 * Aggregate the early-entry edge across the triggering wallets. Returns null if no wallet has
 * a BrainWalletMemory row yet.
 */
export async function computeEarlyEntry(db: Db, buyers: readonly EarlyEntryInput[]): Promise<EarlyEntryOutput | null> {
  if (buyers.length === 0) return null;
  const wallets = [...new Set(buyers.map((b) => b.wallet))];
  const rows = await db
    .select({ walletId: brainWalletMemory.walletId, earlyEntry: brainWalletMemory.earlyEntry })
    .from(brainWalletMemory)
    .where(inArray(brainWalletMemory.walletId, wallets));
  if (rows.length === 0) return null;

  const perWallet: EarlyEntryOutput['perWallet'] = [];
  const peaks: number[] = [];
  const coverages: number[] = [];
  let numerator = 0;
  let denominator = 0;

  const rowsByWallet = new Map(rows.map((r) => [r.walletId, r.earlyEntry as { peakMedian: number | null; coverage: number } | null]));
  for (const buyer of buyers) {
    const row = rowsByWallet.get(buyer.wallet);
    const peak = row?.peakMedian ?? null;
    const cov = row?.coverage ?? 0;
    perWallet.push({ wallet: buyer.wallet, peakMedian: peak, coverage: cov });
    if (peak !== null) peaks.push(peak);
    coverages.push(cov);

    if (peak !== null) {
      const w = Math.max(0, buyer.walletScore) * Math.max(0, buyer.amountSol);
      numerator += w * peak * cov;
      denominator += w;
    }
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };
  const meanCoverage = coverages.reduce((a, b) => a + b, 0) / coverages.length;

  const rawScore = denominator > 0 ? numerator / denominator : 0;
  // Squash: peak returns can be > 1 (say +2 = 200%). Clamp for the composite.
  const score = Math.max(0, Math.min(1, rawScore));

  return {
    score,
    coverage: meanCoverage,
    peakMedian: median(peaks),
    perWallet,
  };
}
