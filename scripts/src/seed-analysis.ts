/**
 * Seed-history analysis (Part II §4). Reads the seeded roster's history from local Postgres and
 * measures the four placeholder tunables, writing docs/research/seed-history-analysis.md. Batch
 * job — Postgres only, no Helius/Redis (run `seed-wallets` first to populate).
 *
 *   npm run build && npm run seed-analysis --workspace @tip/scripts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { and, eq, inArray } from 'drizzle-orm';
import { loadEnv } from '@tip/domain';
import { getDb, closeDb, walletTransaction, walletTrade } from '@tip/database';
import {
  buildSeries, forwardReturns, findCoBuyClusters, median,
  analyzeBatchingWindow, analyzeProfitLadder, analyzeWalletExit, analyzeFreshness,
  type BuyEvent, type PricePoint,
} from '@tip/wallets';

/* eslint-disable no-console */
function readRoster(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim());
  return [...new Set(lines.filter((l) => l && !l.startsWith('#')))];
}

async function main(): Promise<void> {
  loadEnv();
  const path = process.argv.find((a) => a.startsWith('--file='))?.slice('--file='.length) ?? 'scripts/seed/wallets.txt';
  const roster = readRoster(path);
  const db = getDb();

  // Roster BUY events.
  const buyRows = await db
    .select({ wallet: walletTransaction.wallet, mint: walletTransaction.mint, blockTime: walletTransaction.blockTime, amountSol: walletTransaction.amountSol, tokenAmount: walletTransaction.tokenAmount })
    .from(walletTransaction)
    .where(and(inArray(walletTransaction.wallet, roster), eq(walletTransaction.action, 'BUY')));
  const buys: BuyEvent[] = buyRows.map((r) => ({
    wallet: r.wallet, mint: r.mint, blockTime: r.blockTime.getTime(), amountSol: Number(r.amountSol), tokenAmount: Number(r.tokenAmount),
  }));

  const clusters = findCoBuyClusters(buys);
  console.log(`[analysis] ${buys.length} roster buys → ${clusters.length} co-buy clusters`);

  // Per-mint observed-swap series (all wallets' swaps on the mint).
  const seriesByMint = new Map<string, PricePoint[]>();
  for (const mint of new Set(clusters.map((c) => c.mint))) {
    const swaps = await db
      .select({ amountSol: walletTransaction.amountSol, tokenAmount: walletTransaction.tokenAmount, blockTime: walletTransaction.blockTime })
      .from(walletTransaction)
      .where(eq(walletTransaction.mint, mint));
    seriesByMint.set(mint, buildSeries(swaps));
  }

  // 1. batching window
  const batching = analyzeBatchingWindow(clusters.map((c) => c.spanMs));

  // 2. profit ladder
  const ladderEntries = clusters
    .map((c) => {
      const entryPrice = median(c.buys.map((b) => b.amountSol / b.tokenAmount)) ?? 0;
      const series = seriesByMint.get(c.mint) ?? [];
      const after = series.filter((p) => p.time > c.lastBuy).map((p) => p.price);
      const postEntryMaxPrice = after.length ? Math.max(...after) : 0;
      return { entryPrice, postEntryMaxPrice };
    })
    .filter((e) => e.entryPrice > 0 && e.postEntryMaxPrice > 0);
  const ladder = analyzeProfitLadder(ladderEntries);

  // 3. wallet-exit proxy: fraction of each cluster's wallets that fully closed the position
  const exitFractions: number[] = [];
  for (const c of clusters) {
    const trades = await db
      .select({ wallet: walletTrade.wallet, status: walletTrade.status })
      .from(walletTrade)
      .where(and(inArray(walletTrade.wallet, c.wallets), eq(walletTrade.mint, c.mint)));
    if (trades.length === 0) continue;
    const closedWallets = new Set(trades.filter((t) => t.status === 'CLOSED').map((t) => t.wallet)).size;
    exitFractions.push(closedWallets / c.wallets.length);
  }
  const walletExit = analyzeWalletExit(exitFractions);

  // 4. freshness: forward (peak) return vs entry delay within a cluster
  const freshnessSamples = clusters.flatMap((c) => {
    const series = seriesByMint.get(c.mint) ?? [];
    return c.buys
      .map((b) => {
        const price = b.amountSol / b.tokenAmount;
        const fr = forwardReturns(price, b.blockTime, series);
        return fr.peak === null ? null : { delayMs: b.blockTime - c.firstBuy, forwardReturn: fr.peak };
      })
      .filter((s): s is { delayMs: number; forwardReturn: number } => s !== null);
  });
  const freshness = analyzeFreshness(freshnessSamples);

  const doc = renderDoc({ roster: roster.length, buys: buys.length, clusters: clusters.length, batching, ladder, walletExit, freshness });
  mkdirSync('docs/research', { recursive: true });
  writeFileSync('docs/research/seed-history-analysis.md', doc);
  console.log('[analysis] wrote docs/research/seed-history-analysis.md');
  await closeDb(db);
}

function ms(x: number | null): string {
  return x === null ? 'n/a' : `${Math.round(x)}ms (${(x / 1000).toFixed(1)}s)`;
}

function renderDoc(r: {
  roster: number; buys: number; clusters: number;
  batching: ReturnType<typeof analyzeBatchingWindow>;
  ladder: ReturnType<typeof analyzeProfitLadder>;
  walletExit: ReturnType<typeof analyzeWalletExit>;
  freshness: ReturnType<typeof analyzeFreshness>;
}): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  return `# Seed-history analysis (Part II §4)

Generated by \`scripts/seed-analysis.ts\` from local Postgres (reproducible; re-run as the roster
grows). Co-buy clustering here is **analysis-only**, not the production convergence detector (§5, M3).

Roster wallets: ${r.roster} · roster buys: ${r.buys} · co-buy clusters (≥3 wallets): ${r.clusters}

## 1. batchingWindowMs  (placeholder default 5000)
Span (last−first buy) across co-buy clusters — n=${r.batching.n}.
- p50 ${ms(r.batching.p50)} · p80 ${ms(r.batching.p80)} · p90 ${ms(r.batching.p90)}
- **Recommended: ${ms(r.batching.recommendedMs)}** (p90 — captures the bulk without burning the tight TTL).

## 2. profitLadder rungs  (placeholder default 2×/3×/5× @ 50/25/15%)
Of ${r.ladder.n} clusters with a priceable entry + post-entry data:
- reached 2×: ${pct(r.ladder.reached['2x'] ?? 0)} · 3×: ${pct(r.ladder.reached['3x'] ?? 0)} · 5×: ${pct(r.ladder.reached['5x'] ?? 0)} · 10×: ${pct(r.ladder.reached['10x'] ?? 0)}
- **Suggested rungs:** ${r.ladder.suggestedRungs.map((x) => `${x.at}× @ ${pct(x.sellFraction)}`).join(', ') || '(insufficient data)'}

## 3. walletExitThreshold  (placeholder default 0.9) — PRELIMINARY PROXY
${r.walletExit.note}
- clusters measured: ${r.walletExit.n} · mean full-exit fraction: ${r.walletExit.meanFullExitFraction === null ? 'n/a' : pct(r.walletExit.meanFullExitFraction)} · clusters ≥90% dumped: ${pct(r.walletExit.fracClustersMostlyDumped)}

## 4. freshness τ  (placeholder default 15s) — PRELIMINARY
Peak forward return vs entry delay within clusters — n=${r.freshness.n} samples.
${r.freshness.buckets.map((b) => `- ≤${(b.maxDelayMs / 1000).toFixed(0)}s: mean peak ${b.meanReturn === null ? 'n/a' : pct(b.meanReturn)} (${b.count})`).join('\n')}
- **τ estimate (decay to 1/e): ${ms(r.freshness.tauMsEstimate)}**

---
_Values to wire into config at M4+ (ScoringConfig / freshness feature), each with a comment
pointer back to this doc (CLAUDE.md Placeholders rule). Wallet-exit + freshness are best-effort at
MVP — refine with per-wallet-in-cluster sell sequencing after launch._
`;
}

main().catch((err: unknown) => {
  console.error('[analysis] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
