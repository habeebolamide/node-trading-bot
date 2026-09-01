/**
 * Classify wallets as DIRECT_TRADER vs NON_TRADER before wasting a full backfill on them.
 *
 *   npm run classify --workspace @tip/scripts -- --addresses=Wallet1,Wallet2
 *   npm run classify --workspace @tip/scripts -- --file=scripts/seed/wallets.txt
 *
 * Flags:
 *   --pages=N          txn pages of 100 to sample (default 3)
 *   --min-own-swaps=N  own-swaps threshold to count as direct trader (default 3)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnv, configureLogger, createLogger } from '@tip/domain';
import { HeliusRestClient } from '@tip/ingestion';
import { classifyWallet } from '@tip/wallets';

/* eslint-disable no-console */
// npm runs workspace scripts with cwd=scripts/, so a bare "scripts/seed/..." would fail. Resolve
// a relative path from cwd first; if that misses, retry from the repo root.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
function resolvePath(p: string): string {
  const fromCwd = resolve(process.cwd(), p);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = resolve(REPO_ROOT, p);
  return existsSync(fromRoot) ? fromRoot : fromCwd;
}
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
    const lines = readFileSync(resolvePath(file), 'utf8').split('\n').map((l) => l.trim());
    out.push(...lines.filter((l) => l && !l.startsWith('#')));
  }
  return [...new Set(out)];
}

async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();
  if (!config.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required');

  const logFile = fileURLToPath(new URL('../../logs/app.log', import.meta.url));
  configureLogger({ level: config.LOG_LEVEL, file: logFile });
  const log = createLogger('classify');

  const addresses = collectAddresses();
  if (addresses.length === 0) throw new Error('no addresses — pass --addresses=CSV or --file=path');
  const pages = Number(arg('pages', '3'));
  const minOwnSwaps = Number(arg('min-own-swaps', '3'));

  const rest = new HeliusRestClient({ apiKey: config.HELIUS_API_KEY });
  log.info(`classifying ${addresses.length} wallet(s)`, { pages, minOwnSwaps });

  const results: { verdict: string; ownSwaps: number; address: string; reason: string }[] = [];
  for (const [i, wallet] of addresses.entries()) {
    try {
      const c = await classifyWallet(rest, wallet, { pages, minOwnSwaps });
      results.push({ verdict: c.verdict, ownSwaps: c.ownSwaps, address: c.address, reason: c.reason });
      log.info(`[${i + 1}/${addresses.length}] ${c.verdict.padEnd(14)} ${wallet}`, { ownSwaps: c.ownSwaps, sampled: c.sampled, swaps: c.swaps });
    } catch (err) {
      log.error(`[${i + 1}/${addresses.length}] ${wallet} FAILED`, err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const traders = results.filter((r) => r.verdict === 'DIRECT_TRADER');
  const skip = results.filter((r) => r.verdict !== 'DIRECT_TRADER');
  console.log(`\n=== summary: ${traders.length} direct traders, ${skip.length} non-traders ===`);
  if (traders.length) {
    console.log('\nDIRECT_TRADER (worth seeding):');
    for (const r of traders) console.log(`  ${r.address}  — ${r.reason}`);
  }
  if (skip.length) {
    console.log('\nNON_TRADER (skip):');
    for (const r of skip) console.log(`  ${r.address}  — ${r.reason}`);
  }
}

main().catch((err: unknown) => {
  console.error('[classify] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
