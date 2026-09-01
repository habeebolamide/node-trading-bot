/**
 * Cheap pre-screen: is a wallet a DIRECT TRADER (worth seeding) or a treasury/collection/bot-funded
 * address (whose trades happen elsewhere and can't be reconstructed from its own history)?
 *
 * Samples the wallet's most-recent transactions and counts its OWN swaps — a SWAP the wallet
 * fee-paid and whose target-token balance moved (the parser only keeps those, attributed to the
 * fee-payer). A direct trader shows several in a small sample; CyaE1-style funder/treasury wallets
 * show ~0 (mostly transfers). Two API calls, not a full backfill.
 *
 * Caveat: this reads RECENT activity, so a genuinely good trader who's been idle lately can look
 * inactive. It's a fast triage signal, not a verdict on lifetime skill — widen `pages` to reduce
 * false negatives.
 */
import type { HeliusRestClient } from '@tip/ingestion';

export type WalletVerdict = 'DIRECT_TRADER' | 'NON_TRADER';

export interface WalletClassification {
  address: string;
  sampled: number; // raw txns examined
  swaps: number; // SWAP-type txns in the sample (any trader)
  ownSwaps: number; // swaps this wallet actually made (fee-payer + balance moved)
  transferRatio: number; // share of the sample that are plain transfers
  verdict: WalletVerdict;
  reason: string;
}

export interface ClassifyOptions {
  /** Pages of 100 txns to sample (default 3 → up to 300 recent txns). */
  pages?: number;
  /** Minimum own-swaps in the sample to count as a direct trader (default 3). */
  minOwnSwaps?: number;
}

export async function classifyWallet(
  rest: HeliusRestClient,
  address: string,
  opts: ClassifyOptions = {},
): Promise<WalletClassification> {
  const pages = opts.pages ?? 3;
  const minOwnSwaps = opts.minOwnSwaps ?? 3;

  let sampled = 0;
  let swaps = 0;
  let transfers = 0;
  let ownSwaps = 0;
  let before: string | undefined;

  for (let p = 0; p < pages; p++) {
    const page = await rest.getAddressTransactionsPage(
      address as never,
      before === undefined ? { limit: 100 } : { before, limit: 100 },
    );
    sampled += page.rawCount;
    for (const t of page.raw) {
      const type = (t as { type?: string }).type;
      if (type === 'SWAP') swaps += 1;
      else if (type === 'TRANSFER') transfers += 1;
    }
    ownSwaps += page.swaps.filter((s) => s.wallet === address).length;
    if (page.rawCount < 100 || !page.lastSignature) break;
    before = page.lastSignature;
  }

  const transferRatio = sampled > 0 ? transfers / sampled : 0;
  const verdict: WalletVerdict = ownSwaps >= minOwnSwaps ? 'DIRECT_TRADER' : 'NON_TRADER';
  const reason =
    verdict === 'DIRECT_TRADER'
      ? `${ownSwaps} own swaps in last ${sampled} txns`
      : `only ${ownSwaps} own swaps in last ${sampled} txns (${(transferRatio * 100).toFixed(0)}% transfers) — likely treasury/bot-funded; its trades aren't under this address`;

  return { address, sampled, swaps, ownSwaps, transferRatio, verdict, reason };
}
