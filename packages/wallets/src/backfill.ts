/**
 * Per-wallet history backfill (§4 "backfill on add"). Pages a wallet's full parsed swap history
 * from Helius, upserts into `wallet_transaction` (tx_hash idempotent, §29), then reconstructs its
 * trades. A newly-added wallet is populated from its real history, not left blank. Idempotent and
 * resumable: re-running re-upserts the same swaps (no-ops) and deterministically recomputes trades.
 */
import { randomUUID } from 'node:crypto';
import { walletTransaction, type Db } from '@tip/database';
import { type HeliusRestClient, type RawEnhancedTx } from '@tip/ingestion';
import { walletAddress } from '@tip/domain';
import { reconstructWallet } from './persist.js';

/** Per-page debug info surfaced to callers (the CLI --debug logger uses this). */
export interface BackfillPageInfo {
  page: number;
  rawCount: number; // raw txns Helius returned this page
  parsedSwaps: number; // swaps the parser recognized (any trader)
  ownSwaps: number; // swaps kept (feePayer === this wallet)
  raw: RawEnhancedTx[]; // full raw Helius objects, for dumping/inspection
}

export interface WalletBackfillOptions {
  /** Raw txs per page (Helius max 100). */
  pageLimit?: number;
  /** Safety cap on pages (avoids unbounded loops on very active addresses). */
  maxPages?: number;
  /** ms delay between pages (be polite to the API). */
  delayMs?: number;
  log?: (msg: string) => void;
  /** Called once per fetched page — used by the --debug logger to inspect the Helius response. */
  onPage?: (info: BackfillPageInfo) => void;
}

export interface WalletBackfillResult {
  fetchedSwaps: number;
  insertedSwaps: number;
  mints: number;
  trades: number;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Backfill one wallet's swaps into wallet_transaction, then reconstruct its trades. */
export async function backfillWallet(
  rest: HeliusRestClient,
  db: Db,
  wallet: string,
  opts: WalletBackfillOptions = {},
): Promise<WalletBackfillResult> {
  const pageLimit = opts.pageLimit ?? 100;
  const maxPages = opts.maxPages ?? 100;
  const log = opts.log ?? (() => {});
  const addr = walletAddress(wallet);

  let before: string | undefined;
  let fetchedSwaps = 0;
  let insertedSwaps = 0;

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const query = before === undefined ? { limit: pageLimit } : { before, limit: pageLimit };
    const page = await rest.getAddressTransactionsPage(addr, query);
    // Helius returns every tx the address APPEARS in, incl. ones where it was only a counterparty.
    // Keep only swaps this wallet actually made (it paid the fee) — otherwise we'd record other
    // people's trades under their addresses. This is the seeded wallet's OWN history (§4).
    const own = page.swaps.filter((s) => s.wallet === wallet);
    fetchedSwaps += own.length;

    opts.onPage?.({ page: pageNum, rawCount: page.rawCount, parsedSwaps: page.swaps.length, ownSwaps: own.length, raw: page.raw });

    if (own.length > 0) {
      const inserted = await db
        .insert(walletTransaction)
        .values(
          own.map((s) => ({
            id: randomUUID(),
            wallet: s.wallet,
            action: s.action,
            mint: s.mint,
            amountSol: s.amountSol,
            tokenAmount: s.tokenAmount,
            amountUsd: null, // M2-later enrichment
            blockTime: s.blockTime,
            txHash: s.signature,
            slot: s.slot ?? null,
          })),
        )
        .onConflictDoNothing({ target: walletTransaction.txHash })
        .returning({ txHash: walletTransaction.txHash });
      insertedSwaps += inserted.length;
    }

    // Terminate on the RAW page (not the swap count): a short raw page = end of history.
    if (page.rawCount < pageLimit || !page.lastSignature) break;
    before = page.lastSignature;
    await sleep(opts.delayMs ?? 0);
  }

  log(`backfilled ${wallet}: ${insertedSwaps} new swaps (of ${fetchedSwaps} fetched)`);
  const { mints, trades } = await reconstructWallet(db, wallet);
  log(`reconstructed ${wallet}: ${trades} trades across ${mints} mints`);
  return { fetchedSwaps, insertedSwaps, mints, trades };
}
