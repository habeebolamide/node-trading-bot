/**
 * Wallet history backfill CLI (§4). Fetches each wallet's parsed swap history from Helius into
 * `wallet_transaction` and reconstructs its trades. Idempotent — safe to re-run.
 *
 *   npm run build
 *   npm run backfill-wallet --workspace @tip/scripts -- --addresses=Wallet1,Wallet2
 *   npm run backfill-wallet --workspace @tip/scripts -- --file=scripts/seed/wallets.txt
 *
 * Reads addresses from --addresses=CSV and/or --file=path (one address per line, # comments ok).
 */
import { readFileSync } from 'node:fs';
import { getConfig, loadEnv } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { HeliusRestClient } from '@tip/ingestion';
import { backfillWallet } from '@tip/wallets';

/* eslint-disable no-console */
function arg(name: string, fallback = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function collectAddresses(): string[] {
  const out: string[] = [];
  const csv = arg('addresses');
  if (csv) out.push(...csv.split(',').map((a) => a.trim()).filter(Boolean));
  const file = arg('file');
  if (file) {
    const lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim());
    out.push(...lines.filter((l) => l && !l.startsWith('#')));
  }
  return [...new Set(out)]; // dedupe
}

async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();
  if (!config.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required (set it in .env)');

  const addresses = collectAddresses();
  if (addresses.length === 0) throw new Error('no addresses — pass --addresses=CSV or --file=path');

  const db = getDb();
  const rest = new HeliusRestClient({ apiKey: config.HELIUS_API_KEY });
  console.log(`[backfill-wallet] ${addresses.length} wallet(s)`);

  let totalTrades = 0;
  for (const [i, wallet] of addresses.entries()) {
    try {
      const r = await backfillWallet(rest, db, wallet, { delayMs: 200, log: (m) => console.log(`  ${m}`) });
      totalTrades += r.trades;
      console.log(`[${i + 1}/${addresses.length}] ${wallet}: ${r.insertedSwaps} new swaps, ${r.trades} trades`);
    } catch (err) {
      console.error(`[${i + 1}/${addresses.length}] ${wallet} FAILED:`, err instanceof Error ? err.message : err);
    }
  }

  await closeDb(db);
  console.log(`[backfill-wallet] done — ${totalTrades} trades across ${addresses.length} wallet(s)`);
}

main().catch((err: unknown) => {
  console.error('[backfill-wallet] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
