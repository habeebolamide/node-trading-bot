/**
 * Wallet history backfill CLI (§4). Fetches each wallet's parsed swap history from Helius into
 * `wallet_transaction` and reconstructs its trades. Idempotent — safe to re-run.
 *
 *   npm run build
 *   npm run backfill-wallet --workspace @tip/scripts -- --addresses=Wallet1,Wallet2
 *   npm run backfill-wallet --workspace @tip/scripts -- --file=scripts/seed/wallets.txt
 *
 * Reads addresses from --addresses=CSV and/or --file=path (one address per line, # comments ok).
 *
 * Flags:
 *   --max-pages=N   cap history depth (default: full history, up to 100 pages)
 *   --debug         log the Helius response per page (type breakdown, parsed vs own swaps) and
 *                   dump the raw JSON to scripts/seed/debug/<wallet>.json for inspection
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadEnv, configureLogger, createLogger } from '@tip/domain';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
function resolvePath(p: string): string {
  const fromCwd = resolve(process.cwd(), p);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = resolve(REPO_ROOT, p);
  return existsSync(fromRoot) ? fromRoot : fromCwd;
}
import { getDb, closeDb } from '@tip/database';
import { HeliusRestClient } from '@tip/ingestion';
import { backfillWallet, type BackfillPageInfo } from '@tip/wallets';

/* eslint-disable no-console */
function arg(name: string, fallback = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (flag: string): boolean => process.argv.includes(`--${flag}`);

function collectAddresses(): string[] {
  const out: string[] = [];
  const csv = arg('addresses');
  if (csv) out.push(...csv.split(',').map((a) => a.trim()).filter(Boolean));
  const file = arg('file');
  if (file) {
    const lines = readFileSync(resolvePath(file), 'utf8').split('\n').map((l) => l.trim());
    out.push(...lines.filter((l) => l && !l.startsWith('#')));
  }
  return [...new Set(out)]; // dedupe
}

async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();
  if (!config.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required (set it in .env)');

  // Route all logging through the file logger (logs/app.log at repo root) — the debug flag lifts
  // the level to `debug` so per-page Helius detail is recorded.
  const debug = has('debug');
  const logFile = fileURLToPath(new URL('../../logs/app.log', import.meta.url));
  configureLogger({ level: debug ? 'debug' : config.LOG_LEVEL, file: logFile });
  const log = createLogger('backfill');

  const addresses = collectAddresses();
  if (addresses.length === 0) throw new Error('no addresses — pass --addresses=CSV or --file=path');

  const db = getDb();
  const rest = new HeliusRestClient({ apiKey: config.HELIUS_API_KEY });
  const maxPagesArg = arg('max-pages');
  const maxPages = maxPagesArg ? Number(maxPagesArg) : undefined;
  const debugDir = fileURLToPath(new URL('../seed/debug', import.meta.url));
  log.info(`starting`, { wallets: addresses.length, maxPages: maxPages ?? 'full', debug, logFile });

  let totalTrades = 0;
  for (const [i, wallet] of addresses.entries()) {
    try {
      const rawAccum: unknown[] = [];
      // Log every Helius page (type/source breakdown, parsed vs own swaps) through the logger.
      const onPage = (info: BackfillPageInfo): void => {
        const types: Record<string, number> = {};
        for (const t of info.raw) {
          const key = `${(t as { type?: string }).type ?? 'UNKNOWN'}/${(t as { source?: string }).source ?? '-'}`;
          types[key] = (types[key] ?? 0) + 1;
        }
        log.debug(`helius page ${info.page} for ${wallet}`, {
          rawCount: info.rawCount, parsedSwaps: info.parsedSwaps, ownSwaps: info.ownSwaps, types,
        });
        if (debug) rawAccum.push(...info.raw);
      };

      const opts = { delayMs: 200, log: (m: string) => log.info(m), onPage, ...(maxPages ? { maxPages } : {}) };
      const r = await backfillWallet(rest, db, wallet, opts);
      totalTrades += r.trades;

      if (debug) {
        mkdirSync(debugDir, { recursive: true });
        const outFile = `${debugDir}/${wallet}.json`;
        writeFileSync(outFile, JSON.stringify(rawAccum, null, 2));
        log.info(`dumped raw Helius txns`, { count: rawAccum.length, file: outFile });
      }
      log.info(`[${i + 1}/${addresses.length}] ${wallet}`, { newSwaps: r.insertedSwaps, trades: r.trades });
    } catch (err) {
      log.error(`[${i + 1}/${addresses.length}] ${wallet} FAILED`, err instanceof Error ? err.message : String(err));
    }
  }

  await closeDb(db);
  log.info(`done`, { totalTrades, wallets: addresses.length });
}

main().catch((err: unknown) => {
  console.error('[backfill-wallet] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
