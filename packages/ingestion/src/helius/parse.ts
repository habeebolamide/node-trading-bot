/**
 * Pure parser: Helius "enhanced" transactions → NormalizedWalletTx[] (§12). No I/O; the only
 * time input is the injected `processingTime`, so it's fully fixture-testable. Reused by both
 * the webhook consumer and the REST address-history lookup (one parser, one behaviour).
 *
 * M1 scope: SWAP transactions with a SOL-paired leg (the memecoin norm). Non-swaps and
 * token↔token swaps with no SOL leg are skipped rather than guessed at (rule 14 — never invent).
 */
import { mint as toMint, walletAddress, type Mint, type WalletAddress } from '@tip/domain';
import type { NormalizedWalletTx } from '../provider.js';

/** Wrapped SOL mint — the quote leg, never the "target token". */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

interface RawTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number | string;
}
interface RawNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number | string; // lamports
}
export interface RawEnhancedTx {
  type?: string;
  feePayer?: string;
  signature?: string;
  slot?: number;
  timestamp?: number; // seconds
  tokenTransfers?: RawTokenTransfer[];
  nativeTransfers?: RawNativeTransfer[];
}

const num = (v: number | string | undefined): number => (v === undefined ? 0 : Number(v));

/** Parse one enhanced tx into a normalized wallet swap, or null if it isn't a parseable SOL swap. */
export function parseEnhancedTx(tx: RawEnhancedTx, processingTime: string): NormalizedWalletTx | null {
  if (tx.type !== 'SWAP') return null;
  const wallet = tx.feePayer;
  const signature = tx.signature;
  if (!wallet || !signature) return null;

  // Target token = the wallet-involved, non-wSOL transfer with the largest magnitude
  // (routing hops leave dust transfers; the real leg is the biggest).
  const candidates = (tx.tokenTransfers ?? []).filter(
    (t) => t.mint && t.mint !== WSOL_MINT && (t.fromUserAccount === wallet || t.toUserAccount === wallet),
  );
  if (candidates.length === 0) return null;
  const target = candidates.reduce((best, t) =>
    Math.abs(num(t.tokenAmount)) > Math.abs(num(best.tokenAmount)) ? t : best,
  );

  const action: 'BUY' | 'SELL' = target.toUserAccount === wallet ? 'BUY' : 'SELL';

  // SOL leg: native transfers to/from the wallet in the matching direction.
  const natives = tx.nativeTransfers ?? [];
  const lamports = natives
    .filter((n) => (action === 'BUY' ? n.fromUserAccount === wallet : n.toUserAccount === wallet))
    .reduce((sum, n) => sum + num(n.amount), 0);
  let amountSol = lamports / LAMPORTS_PER_SOL;

  // Fallback for wrapped-SOL swaps that carry no native transfers: use the wSOL token leg.
  if (amountSol === 0) {
    const wsol = (tx.tokenTransfers ?? []).filter(
      (t) => t.mint === WSOL_MINT && (t.fromUserAccount === wallet || t.toUserAccount === wallet),
    );
    amountSol = wsol.reduce((sum, t) => sum + Math.abs(num(t.tokenAmount)), 0);
  }

  const blockTime = new Date((tx.timestamp ?? 0) * 1000);
  return {
    signature,
    wallet: walletAddress(wallet) as WalletAddress,
    action,
    mint: toMint(target.mint!) as Mint,
    tokenAmount: String(Math.abs(num(target.tokenAmount))),
    amountSol: String(amountSol),
    blockTime,
    slot: tx.slot ?? null,
    eventTime: blockTime.toISOString(),
    processingTime,
  };
}

/** Parse a Helius webhook body (an array of enhanced txs) into normalized swaps. */
export function parseHeliusWebhook(payload: unknown, processingTime: string): NormalizedWalletTx[] {
  if (!Array.isArray(payload)) return [];
  const out: NormalizedWalletTx[] = [];
  for (const raw of payload) {
    const parsed = parseEnhancedTx(raw as RawEnhancedTx, processingTime);
    if (parsed) out.push(parsed);
  }
  return out;
}
