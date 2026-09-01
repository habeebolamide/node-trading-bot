/**
 * Find a wallet's first-hop SOL funder (Part II §5 interim heuristic). Pages Helius history
 * BACKWARDS until we hit the oldest page (or the safety cap), then scans it forward for the first
 * inbound native transfer ≥ threshold. Cheap per wallet, cached in `wallet_funder` — a wallet's
 * original funder never changes.
 *
 * Design.md cap: `MAX_PAGES` = 20 (~2000 txns). Beyond that, take the oldest transfer we saw and
 * flag `inferredAtCap` — imprecision here doesn't cost clustering quality because a wallet with
 * >2000 txns is almost never in the same 48h window as a fresh wallet.
 */
import { walletAddress } from '@tip/domain';
import type { HeliusRestClient } from '@tip/ingestion';

const MAX_PAGES = 20;
const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_MIN_SOL = 0.05; // skip dust / airdrops

interface RawNativeTransfer { fromUserAccount?: string; toUserAccount?: string; amount?: number | string }
interface RawEnhancedTx { signature?: string; timestamp?: number; nativeTransfers?: RawNativeTransfer[] }

export interface FunderInfo {
  wallet: string;
  funder: string;
  fundedAt: Date;
  fundedSol: number;
  inferredAtCap: boolean;
}

export interface FindFunderOptions {
  /** Minimum inbound SOL to consider a "real" funding. Default 0.05. */
  minSol?: number;
  /** Max history pages to walk. Default 20 (≈2000 txns). */
  maxPages?: number;
  /** Injectable delay between pages (ms) to be polite. Default 0. */
  delayMs?: number;
}

const num = (v: number | string | undefined): number => (v === undefined ? 0 : Number(v));
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Returns the first significant inbound SOL transfer's sender, or null if none found. */
export async function findFirstFunder(
  rest: HeliusRestClient,
  wallet: string,
  opts: FindFunderOptions = {},
): Promise<FunderInfo | null> {
  const minLamports = (opts.minSol ?? DEFAULT_MIN_SOL) * LAMPORTS_PER_SOL;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const addr = walletAddress(wallet);

  // Walk backwards accumulating pages so we can scan the *oldest* one forward.
  const pages: RawEnhancedTx[][] = [];
  let before: string | undefined;
  let hitCap = false;

  for (let p = 0; p < maxPages; p++) {
    const page = await rest.getAddressTransactionsPage(addr, before === undefined ? { limit: 100 } : { before, limit: 100 });
    if (page.rawCount === 0) break;
    pages.push(page.raw as RawEnhancedTx[]);
    if (page.rawCount < 100 || !page.lastSignature) break;
    before = page.lastSignature;
    if (p === maxPages - 1) hitCap = true;
    await sleep(opts.delayMs ?? 0);
  }

  if (pages.length === 0) return null;

  // Scan the oldest page first, then work forward.
  for (let i = pages.length - 1; i >= 0; i--) {
    const chronological = [...pages[i]!].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    for (const tx of chronological) {
      for (const n of tx.nativeTransfers ?? []) {
        const amount = num(n.amount);
        if (n.toUserAccount === wallet && amount >= minLamports && n.fromUserAccount) {
          return {
            wallet,
            funder: n.fromUserAccount,
            fundedAt: new Date((tx.timestamp ?? 0) * 1000),
            fundedSol: amount / LAMPORTS_PER_SOL,
            inferredAtCap: hitCap,
          };
        }
      }
    }
  }
  return null;
}
