/**
 * Co-buy clustering for the seed-history analysis (Part II §4). ANALYSIS-ONLY — this is a naive
 * same-token, session-gap grouping of seed-wallet buys, NOT the production convergence detector
 * (funder-cluster dedup, §5, is M3). It exists purely to characterize the distributions that settle
 * the four placeholder tunables, and must not be mistaken for the real convergence path.
 *
 * A "co-buy cluster" = a burst of buys on one mint by ≥minWallets distinct roster wallets, where
 * consecutive buys are no more than `sessionGapMs` apart (a gap larger than that starts a new
 * event). The cluster's SPAN (last − first buy) is what feeds the batching-window analysis, so the
 * gap must be generous enough not to pre-truncate real spans.
 */
export interface BuyEvent {
  wallet: string;
  mint: string;
  blockTime: number; // ms epoch
  amountSol: number;
  tokenAmount: number;
}

export interface CoBuyCluster {
  mint: string;
  buys: BuyEvent[];
  wallets: string[]; // distinct
  firstBuy: number;
  lastBuy: number;
  spanMs: number;
}

export interface CoBuyOptions {
  /** Max gap between consecutive buys within one convergence event. Default 1h. */
  sessionGapMs?: number;
  /** Minimum distinct wallets for a burst to count as a co-buy cluster. Default 3. */
  minWallets?: number;
}

export function findCoBuyClusters(buys: readonly BuyEvent[], opts: CoBuyOptions = {}): CoBuyCluster[] {
  const sessionGapMs = opts.sessionGapMs ?? 60 * 60_000;
  const minWallets = opts.minWallets ?? 3;

  const byMint = new Map<string, BuyEvent[]>();
  for (const b of buys) {
    if (!byMint.has(b.mint)) byMint.set(b.mint, []);
    byMint.get(b.mint)!.push(b);
  }

  const clusters: CoBuyCluster[] = [];
  for (const [mint, mintBuys] of byMint) {
    const sorted = [...mintBuys].sort((a, b) => a.blockTime - b.blockTime);
    let session: BuyEvent[] = [];
    const flush = (): void => {
      if (session.length === 0) return;
      const wallets = [...new Set(session.map((b) => b.wallet))];
      if (wallets.length >= minWallets) {
        const first = session[0]!.blockTime;
        const last = session[session.length - 1]!.blockTime;
        clusters.push({ mint, buys: session, wallets, firstBuy: first, lastBuy: last, spanMs: last - first });
      }
      session = [];
    };
    for (const b of sorted) {
      if (session.length > 0 && b.blockTime - session[session.length - 1]!.blockTime > sessionGapMs) flush();
      session.push(b);
    }
    flush();
  }
  return clusters;
}
