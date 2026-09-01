/**
 * Seed run (Part II §4): backfill + reconstruct + score the whole roster, giving the memecoin
 * Brain a populated, scored wallet universe on day one. Batch job — Helius REST + Postgres only,
 * no BullMQ/Redis (scoreAllWallets is called without a bus).
 *
 *   npm run build
 *   npm run seed-wallets --workspace @tip/scripts            # reads scripts/seed/wallets.txt
 *   npm run seed-wallets --workspace @tip/scripts -- --file=path/to/wallets.txt
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnv } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { HeliusRestClient } from '@tip/ingestion';
import { backfillWallet, scoreAllWallets } from '@tip/wallets';

/* eslint-disable no-console */
// Default roster resolves relative to this file (scripts/src/), so it works regardless of cwd
// (npm runs workspace scripts with cwd = scripts/). --file overrides with a caller-relative path.
const DEFAULT_ROSTER = fileURLToPath(new URL('../seed/wallets.txt', import.meta.url));
function rosterFile(): string {
  const hit = process.argv.find((a) => a.startsWith('--file='));
  return hit ? hit.slice('--file='.length) : DEFAULT_ROSTER;
}

function readRoster(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim());
  return [...new Set(lines.filter((l) => l && !l.startsWith('#')))];
}

async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();
  if (!config.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required (set it in .env)');

  const path = rosterFile();
  const roster = readRoster(path);
  if (roster.length === 0) throw new Error(`no addresses in ${path}`);
  console.log(`[seed] ${roster.length} wallets from ${path}`);

  const db = getDb();
  const rest = new HeliusRestClient({ apiKey: config.HELIUS_API_KEY });

  let totalSwaps = 0;
  let totalTrades = 0;
  for (const [i, wallet] of roster.entries()) {
    try {
      const r = await backfillWallet(rest, db, wallet, { delayMs: 200 });
      totalSwaps += r.insertedSwaps;
      totalTrades += r.trades;
      console.log(`[${i + 1}/${roster.length}] ${wallet}: +${r.insertedSwaps} swaps, ${r.trades} trades`);
    } catch (err) {
      console.error(`[${i + 1}/${roster.length}] ${wallet} FAILED:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[seed] backfill done — ${totalSwaps} swaps, ${totalTrades} trades. Scoring…`);

  const scored = await scoreAllWallets(db); // no bus → no Redis
  console.log(`[seed] scored: ${scored.rated} rated, ${scored.unrated} unrated`);
  const top = [...scored.scored].sort((a, b) => b.score - a.score).slice(0, 10);
  console.log('[seed] top 10 by score:');
  for (const s of top) console.log(`  ${s.score.toFixed(1)}  ${s.walletId}`);

  await closeDb(db);
  console.log('[seed] done. Next: npm run seed-analysis');
}

main().catch((err: unknown) => {
  console.error('[seed] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
