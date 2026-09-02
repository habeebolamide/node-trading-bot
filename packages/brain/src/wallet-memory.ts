/**
 * Wallet Memory (Part II §8, §16) — the BEHAVIORAL PROFILE alongside the score.
 *
 * M2 already owns the score: `wallet_score_event` is append-only and read via
 * `walletScoreAsOf(T)` (rule 21). This module is deliberately NOT a second scoring path — it
 * answers "what does this wallet actually do?", which is what explains a score and what the
 * Judge's evidence package (M7) needs. No `currentWalletScore()` is added or re-exported here.
 *
 * Recency: 60d half-life (Task 6 wallet metric — distinct from the 30d/90d SETUP half-lives).
 * Everything is effective-n (rule 23); raw trade counts appear nowhere in the output.
 */
import { and, eq, lte } from 'drizzle-orm';
import { brainWalletMemory, walletCluster, walletTrade, type Db } from '@tip/database';
import { recencyWeight, weightedMedian, type WeightedItem } from './stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Task 6: wallet metrics decay on a 60-day half-life. */
export const WALLET_HALFLIFE_DAYS = 60;

/** Task 6: below 10 trades a wallet is "unrated" and excluded from convergence weighting. */
export const WALLET_RATING_MIN_EFFECTIVE_N = 10;

export interface WalletBehavior {
  readonly medianHoldMinutes: number | null;
  readonly avgPositionSol: number | null;
  readonly tradesPerDay: number | null;
  /** Fraction of (weighted) trades per token category. Empty when nothing is categorized. */
  readonly specialization: Readonly<Record<string, number>>;
  readonly clusterAffiliations: readonly string[];
  readonly effectiveN: number;
  /**
   * False below effective-n 10. When unrated the aggregates above are still returned for
   * inspection, but callers must not weight them — §8's explicit-state discipline applied to
   * wallets: thin aggregates are reported as thin, never dressed up.
   */
  readonly rated: boolean;
}

export interface WalletMemory {
  readonly walletId: string;
  readonly behavior: WalletBehavior;
  readonly asOf: Date;
}

/** Token category for specialization. MVP: the mint itself is the category until token
 *  classification lands — recorded as a field so the shape does not change when it does. */
function categoryOf(mint: string): string {
  return mint;
}

/**
 * Recompute a wallet's behavioral profile from its CLOSED round-trips as of `asOf`.
 *
 * Only closed trades contribute: an open position has no holding period and no realized return,
 * and counting it would let a wallet look disciplined simply by never selling.
 */
export async function computeWalletBehavior(db: Db, walletId: string, asOf: Date): Promise<WalletBehavior> {
  const trades = await db
    .select({
      openedAt: walletTrade.openedAt,
      closedAt: walletTrade.closedAt,
      totalSolIn: walletTrade.totalSolIn,
      holdingPeriodSec: walletTrade.holdingPeriodSec,
      mint: walletTrade.mint,
    })
    .from(walletTrade)
    .where(and(
      eq(walletTrade.wallet, walletId),
      eq(walletTrade.status, 'CLOSED'),
      lte(walletTrade.closedAt, asOf),
    ));

  let effectiveN = 0;
  let weightedSolIn = 0;
  const holds: WeightedItem[] = [];
  const byCategory = new Map<string, number>();
  let earliest: Date | null = null;

  for (const t of trades) {
    if (!t.closedAt) continue; // defensive: status CLOSED implies closedAt, but never trust it
    const weight = recencyWeight((asOf.getTime() - t.closedAt.getTime()) / DAY_MS, WALLET_HALFLIFE_DAYS);
    effectiveN += weight;
    weightedSolIn += Number(t.totalSolIn) * weight;
    if (t.holdingPeriodSec !== null) holds.push({ value: t.holdingPeriodSec / 60, weight });

    const cat = categoryOf(t.mint);
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + weight);

    if (!earliest || t.openedAt < earliest) earliest = t.openedAt;
  }

  const specialization: Record<string, number> = {};
  if (effectiveN > 0) {
    for (const [cat, w] of byCategory) specialization[cat] = w / effectiveN;
  }

  // Activity rate uses RAW span and RAW count — "trades per day" is a description of observed
  // cadence, not a decayed estimate, and decaying it would make an inactive wallet look busy.
  const spanDays = earliest ? Math.max(1, (asOf.getTime() - earliest.getTime()) / DAY_MS) : null;

  const clusters = await db
    .selectDistinct({ clusterId: walletCluster.clusterId })
    .from(walletCluster)
    .where(and(eq(walletCluster.walletId, walletId), lte(walletCluster.clusteredAt, asOf)));

  return {
    medianHoldMinutes: weightedMedian(holds),
    avgPositionSol: effectiveN > 0 ? weightedSolIn / effectiveN : null,
    tradesPerDay: spanDays ? trades.length / spanDays : null,
    specialization,
    clusterAffiliations: clusters.map((c) => c.clusterId).sort(),
    effectiveN,
    rated: effectiveN >= WALLET_RATING_MIN_EFFECTIVE_N,
  };
}

/**
 * Point-in-time read. `asOf` is REQUIRED — there is no `currentWalletMemory()` for replay code
 * to reach for (rules 21/22), the same structural enforcement `AsOfMarketData` applies to
 * candles.
 *
 * The profile is recomputed rather than read from the cached `brain_wallet_memory.behavior`
 * column for exactly the reason the Historical Edge read recomputes: the cached row reflects
 * whenever it was last written, so serving it for a historical `asOf` would leak later trades.
 * The cached column is a live/dashboard convenience, refreshed by `persistWalletBehavior`.
 */
export async function walletMemoryAsOf(db: Db, walletId: string, asOf: Date): Promise<WalletMemory> {
  return { walletId, behavior: await computeWalletBehavior(db, walletId, asOf), asOf };
}

/** Refresh the cached profile column. Live path only — never called from a replay. */
export async function persistWalletBehavior(db: Db, walletId: string, asOf: Date): Promise<WalletBehavior> {
  const behavior = await computeWalletBehavior(db, walletId, asOf);
  await db
    .insert(brainWalletMemory)
    .values({ walletId, behavior, updatedAt: asOf })
    .onConflictDoUpdate({ target: brainWalletMemory.walletId, set: { behavior, updatedAt: asOf } });
  return behavior;
}
