/**
 * Watchlist service (§11 manual watchlist). Adding a wallet: backfill its history → score
 * (universe recompute) → mark watched → reconcile Helius subscription. Re-adding a soft-deleted
 * wallet resurrects it (unwatched_at → null). Removal is soft-delete + reconcile.
 *
 * Backfill runs INLINE (design.md decision) so the API caller sees the rating outcome
 * synchronously. Acceptable at MVP scale (a couple minutes worst case per new wallet); a
 * job+status endpoint is a later optimization if the operator seeds a large batch at once.
 */
import { eq, isNull, and } from 'drizzle-orm';
import { ValidationError, type Domain } from '@tip/domain';
import { watchedWallet, wallet as walletTable, type Db } from '@tip/database';
import { HeliusRestClient } from '@tip/ingestion';
import { backfillWallet, scoreAllWallets, liveWalletScore } from '@tip/wallets';
import type { HeliusSubscriptionManager } from './subscription.js';

/** Basic Solana address validation — base58 + length range. A full pubkey check is later. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function isPlausibleAddress(s: string): boolean {
  return BASE58_RE.test(s);
}

export interface WatchlistDeps {
  db: Db;
  rest: HeliusRestClient;
  subscription: HeliusSubscriptionManager;
  log?: (msg: string, meta?: unknown) => void;
}

export interface AddResult {
  address: string;
  status: 'rated' | 'unrated';
  score: number | null;
  tradeCount: number;
  resurrected: boolean; // true if the wallet was previously soft-deleted
  backfillMs: number;
}

export interface WatchedRow {
  address: string;
  note: string | null;
  watchedAt: Date;
  status: string; // wallet.status ('rated' | 'unrated'); 'unknown' if never scored
  score: number | null;
  tradeCount: number;
  lastScoredAt: Date | null;
}

export const WATCHLIST_DOMAIN: Domain = 'memecoin';

export class Watchlist {
  private readonly log: (msg: string, meta?: unknown) => void;

  constructor(private readonly deps: WatchlistDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Add a wallet: backfill history → score → mark watched → reconcile. Idempotent. */
  async add(address: string, note?: string | null): Promise<AddResult> {
    if (!isPlausibleAddress(address)) throw new ValidationError(`invalid wallet address: ${address}`);
    const started = Date.now();

    // Detect resurrection BEFORE upsert (so we can report it).
    const existing = await this.deps.db
      .select({ unwatchedAt: watchedWallet.unwatchedAt })
      .from(watchedWallet)
      .where(eq(watchedWallet.address, address))
      .limit(1);
    const resurrected = !!(existing[0] && existing[0].unwatchedAt !== null);

    // Backfill (reuses M2). This is the slow part.
    await backfillWallet(this.deps.rest, this.deps.db, address, { delayMs: 200 });

    // Recompute the whole universe so THIS wallet's percentiles reflect the current set (§4).
    await scoreAllWallets(this.deps.db);

    // Upsert watched: on conflict clear any prior unwatched_at (resurrection) and update note.
    await this.deps.db
      .insert(watchedWallet)
      .values({ address, note: note ?? null })
      .onConflictDoUpdate({
        target: watchedWallet.address,
        set: { unwatchedAt: null, note: note ?? null, watchedAt: new Date() },
      });

    // Reconcile the Helius subscription — the new wallet must be in the account list.
    await this.deps.subscription.reconcile();

    // Read the score we just wrote.
    const scored = await liveWalletScore(this.deps.db, address);
    const profileRow = await this.deps.db
      .select({ status: walletTable.status, tradeCount: walletTable.tradeCount })
      .from(walletTable)
      .where(eq(walletTable.address, address))
      .limit(1);
    const profile = profileRow[0];
    const status: 'rated' | 'unrated' = scored ? 'rated' : 'unrated';

    const result: AddResult = {
      address,
      status,
      score: scored?.score ?? null,
      tradeCount: profile?.tradeCount ?? 0,
      resurrected,
      backfillMs: Date.now() - started,
    };
    this.log('watchlist add', result);
    return result;
  }

  /** Soft-delete: mark unwatched, then reconcile the Helius subscription. */
  async remove(address: string): Promise<{ removed: boolean }> {
    const res = await this.deps.db
      .update(watchedWallet)
      .set({ unwatchedAt: new Date() })
      .where(and(eq(watchedWallet.address, address), isNull(watchedWallet.unwatchedAt)))
      .returning({ address: watchedWallet.address });
    if (res.length === 0) return { removed: false };
    await this.deps.subscription.reconcile();
    this.log('watchlist remove', { address });
    return { removed: true };
  }

  /** List active watched wallets with their current profile + live score. */
  async list(): Promise<WatchedRow[]> {
    const rows = await this.deps.db
      .select({
        address: watchedWallet.address,
        note: watchedWallet.note,
        watchedAt: watchedWallet.watchedAt,
        walletStatus: walletTable.status,
        tradeCount: walletTable.tradeCount,
        lastScoredAt: walletTable.lastScoredAt,
      })
      .from(watchedWallet)
      .leftJoin(walletTable, eq(walletTable.address, watchedWallet.address))
      .where(isNull(watchedWallet.unwatchedAt));

    const out: WatchedRow[] = [];
    for (const r of rows) {
      const scored = await liveWalletScore(this.deps.db, r.address);
      out.push({
        address: r.address,
        note: r.note,
        watchedAt: r.watchedAt,
        status: r.walletStatus ?? 'unknown',
        score: scored?.score ?? null,
        tradeCount: r.tradeCount ?? 0,
        lastScoredAt: r.lastScoredAt,
      });
    }
    return out;
  }

  /** Whether an address is actively watched right now (unwatched_at is null). */
  async isWatched(address: string): Promise<boolean> {
    const r = await this.deps.db
      .select({ address: watchedWallet.address })
      .from(watchedWallet)
      .where(and(eq(watchedWallet.address, address), isNull(watchedWallet.unwatchedAt)))
      .limit(1);
    return r.length > 0;
  }
}
