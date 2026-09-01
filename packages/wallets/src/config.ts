/**
 * WalletScoringConfig loader (§4/Task-1). Domain-level, append-only, versioned — distinct from the
 * per-TradingAgent ScoringConfig. Weights are the §4 defaults; changing them writes a new version
 * (never mutate), and each WalletScoreEvent pins the version that produced it.
 */
import { desc, eq } from 'drizzle-orm';
import { walletScoringConfig, type Db } from '@tip/database';
import type { Weights } from './scoring.js';

export interface WalletScoringConfigResolved {
  version: number;
  weights: Weights;
  priors: { alpha: number; beta: number };
  unratedMinTrades: number;
  recomputeEveryNTrades: number;
}

/** §4 default weights (sum to 1.0). */
export const DEFAULT_WEIGHTS: Weights = {
  profitability: 0.2,
  winRate: 0.15,
  earlyEntry: 0.25,
  consistency: 0.15,
  specialization: 0.1,
  tradeQuality: 0.1,
  corroboration: 0.05,
};

/** Prior ~40% base win rate with a pseudocount of 10 (α₀=4, β₀=6). Tunable via a new config row. */
const DEFAULT_PRIOR_ALPHA = 4;
const DEFAULT_PRIOR_BETA = 6;

/** Load the active config; seed version 1 (the §4 defaults) if the table is empty. */
export async function loadActiveWalletScoringConfig(db: Db): Promise<WalletScoringConfigResolved> {
  const rows = await db
    .select()
    .from(walletScoringConfig)
    .where(eq(walletScoringConfig.active, true))
    .orderBy(desc(walletScoringConfig.version))
    .limit(1);

  let row = rows[0];
  if (!row) {
    await db
      .insert(walletScoringConfig)
      .values({
        version: 1,
        weights: DEFAULT_WEIGHTS,
        priorAlpha: String(DEFAULT_PRIOR_ALPHA),
        priorBeta: String(DEFAULT_PRIOR_BETA),
      })
      .onConflictDoNothing();
    row = (
      await db.select().from(walletScoringConfig).where(eq(walletScoringConfig.version, 1)).limit(1)
    )[0]!;
  }

  return {
    version: row.version,
    weights: row.weights as Weights,
    priors: { alpha: Number(row.priorAlpha), beta: Number(row.priorBeta) },
    unratedMinTrades: row.unratedMinTrades,
    recomputeEveryNTrades: row.recomputeEveryNTrades,
  };
}
