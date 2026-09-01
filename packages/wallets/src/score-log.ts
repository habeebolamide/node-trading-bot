/**
 * Append-only wallet-score log + point-in-time reads (§4, rule 21). The ONLY historical accessor
 * takes an explicit `T` — there is no `currentScore()`. `liveWalletScore` is a clearly-named
 * convenience for live/dashboard use ("as of now"); it must NEVER be used in a replay/backtest
 * path, which reads `walletScoreAsOf(T)` instead. (`@tip/evaluation` doesn't depend on this package,
 * so replay code can't reach either accessor by accident.)
 */
import { randomUUID } from 'node:crypto';
import { and, eq, lte, desc } from 'drizzle-orm';
import { walletScoreEvent, type Db } from '@tip/database';

export interface WalletScoreRow {
  score: number;
  timestamp: Date;
  configVersion: number;
  inputsUsed: unknown;
}

export interface AppendScoreInput {
  walletId: string;
  score: number;
  configVersion: number;
  inputsUsed: unknown;
  at: Date;
}

/** Append a recompute result. Never updates in place (rule 8/16). */
export async function appendWalletScore(db: Db, input: AppendScoreInput): Promise<void> {
  await db.insert(walletScoreEvent).values({
    id: randomUUID(),
    walletId: input.walletId,
    timestamp: input.at,
    score: String(input.score),
    configVersion: input.configVersion,
    inputsUsed: input.inputsUsed as object,
  });
}

/** Wallet score AS OF T — the latest event with `timestamp ≤ T`, or null if none (UNRATED at T). */
export async function walletScoreAsOf(db: Db, walletId: string, t: Date): Promise<WalletScoreRow | null> {
  const rows = await db
    .select()
    .from(walletScoreEvent)
    .where(and(eq(walletScoreEvent.walletId, walletId), lte(walletScoreEvent.timestamp, t)))
    .orderBy(desc(walletScoreEvent.timestamp))
    .limit(1);
  const r = rows[0];
  return r ? { score: Number(r.score), timestamp: r.timestamp, configVersion: r.configVersion, inputsUsed: r.inputsUsed } : null;
}

/** LIVE score ("as of now") — dashboards / live path ONLY. Never call from replay/backtest code. */
export function liveWalletScore(db: Db, walletId: string): Promise<WalletScoreRow | null> {
  return walletScoreAsOf(db, walletId, new Date());
}
