/**
 * The wallet-scoring pass (§4). Recomputes every wallet's sub-metrics over the current universe,
 * percentile-normalizes, composites, and appends a `WalletScoreEvent` per rated wallet. Percentile
 * normalization couples wallets, so scoring runs over the whole rated set together — this is the
 * "daily job" path (§4). The per-25-trades incremental trigger reuses this pass for MVP (cheap at
 * ~100 wallets); a true incremental path is a later optimization.
 */
import { eq } from 'drizzle-orm';
import { walletTrade, wallet as walletTable, brainWalletMemory, type Db } from '@tip/database';
import { EVENT_NAMES, QUEUE_NAMES, type EventBus } from '@tip/events';
import { loadActiveWalletScoringConfig } from './config.js';
import { computeWalletEarlyEntry } from './early-entry.js';
import { computeRawMetrics, type RawMetrics, type TradeForMetrics } from './metrics.js';
import { scoreUniverse } from './scoring.js';
import { appendWalletScore } from './score-log.js';

export interface RecomputeOptions {
  bus?: EventBus;
  now?: Date;
  log?: (msg: string) => void;
}

export interface RecomputeResult {
  rated: number;
  unrated: number;
  scored: { walletId: string; score: number }[];
}

/** Score all wallets that have reconstructed trades. Returns rated/unrated counts + scores. */
export async function scoreAllWallets(db: Db, opts: RecomputeOptions = {}): Promise<RecomputeResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const config = await loadActiveWalletScoringConfig(db);

  const walletRows = await db.selectDistinct({ wallet: walletTrade.wallet }).from(walletTrade);
  const wallets = walletRows.map((r) => r.wallet);
  if (wallets.length === 0) return { rated: 0, unrated: 0, scored: [] };

  // Load every wallet's trades once; build the mint→wallets map for corroboration.
  const tradesByWallet = new Map<string, TradeForMetrics[]>();
  const mintsByWallet = new Map<string, Set<string>>();
  const mintToWallets = new Map<string, Set<string>>();
  for (const w of wallets) {
    const rows = await db.select().from(walletTrade).where(eq(walletTrade.wallet, w));
    tradesByWallet.set(
      w,
      rows.map((t) => ({
        status: t.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
        realizedReturnPct: t.realizedReturnPct === null ? null : Number(t.realizedReturnPct),
        won: t.won,
        totalSolIn: Number(t.totalSolIn),
      })),
    );
    const mints = new Set(rows.map((t) => t.mint));
    mintsByWallet.set(w, mints);
    for (const m of mints) {
      if (!mintToWallets.has(m)) mintToWallets.set(m, new Set());
      mintToWallets.get(m)!.add(w);
    }
  }

  const corroborationOf = (w: string): number => {
    const others = new Set<string>();
    for (const m of mintsByWallet.get(w) ?? []) {
      for (const other of mintToWallets.get(m) ?? []) if (other !== w) others.add(other);
    }
    return others.size;
  };

  // Early-entry for every wallet (persists trade_outcome + feeds BrainWalletMemory).
  const rawByWallet = new Map<string, RawMetrics>();
  const ratedWallets: string[] = [];
  const unratedWallets: string[] = [];
  for (const w of wallets) {
    const early = await computeWalletEarlyEntry(db, w);
    await db
      .insert(brainWalletMemory)
      .values({ walletId: w, earlyEntry: early, updatedAt: now })
      .onConflictDoUpdate({ target: brainWalletMemory.walletId, set: { earlyEntry: early, updatedAt: now } });

    const raw = computeRawMetrics(tradesByWallet.get(w)!, early, config.priors, corroborationOf(w));
    if (raw.n >= config.unratedMinTrades) {
      rawByWallet.set(w, raw);
      ratedWallets.push(w);
    } else {
      unratedWallets.push(w);
    }
  }

  const scored = scoreUniverse(rawByWallet, config.weights);

  // Persist rated: append score event + mark profile rated.
  for (const s of scored) {
    await appendWalletScore(db, {
      walletId: s.walletId,
      score: s.score,
      configVersion: config.version,
      inputsUsed: { raw: s.raw, percentiles: s.percentiles },
      at: now,
    });
    await upsertWallet(db, s.walletId, s.raw.n, 'rated', now);
    if (opts.bus) {
      await opts.bus.publish(QUEUE_NAMES.WALLET_ANALYSIS, {
        type: EVENT_NAMES.WALLET_SCORE_UPDATED,
        eventTime: now.toISOString(),
        source: 'wallet-scoring',
        payload: { walletId: s.walletId, score: s.score },
      });
    }
  }
  // Persist unrated profiles (no score event).
  for (const w of unratedWallets) {
    await upsertWallet(db, w, tradesByWallet.get(w)!.filter((t) => t.status === 'CLOSED').length, 'unrated', now);
  }

  log(`scored ${scored.length} rated, ${unratedWallets.length} unrated`);
  return { rated: ratedWallets.length, unrated: unratedWallets.length, scored: scored.map((s) => ({ walletId: s.walletId, score: s.score })) };
}

async function upsertWallet(db: Db, address: string, tradeCount: number, status: 'rated' | 'unrated', now: Date): Promise<void> {
  await db
    .insert(walletTable)
    .values({ address, tradeCount, status, lastScoredAt: now })
    .onConflictDoUpdate({ target: walletTable.address, set: { tradeCount, status, lastScoredAt: now } });
}
