/**
 * Recompute funder clusters over all rated wallets (Part II §5). Fetches any missing funder rows
 * from Helius, then clusters within a sliding window (default 48h). Idempotent per-wallet — the
 * funder fetch caches, so re-runs only fetch for newly-rated wallets.
 *
 *   npm run recompute-clusters --workspace @tip/scripts
 *   npm run recompute-clusters --workspace @tip/scripts -- --window-hours=72
 */
import { getConfig, loadEnv, configureLogger, createLogger } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { HeliusRestClient } from '@tip/ingestion';
import { recomputeClusters } from '@tip/watchlist';

/* eslint-disable no-console */
function arg(name: string, fallback = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();
  if (!config.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required (needed to fetch missing funders)');

  configureLogger({ level: config.LOG_LEVEL, file: 'logs/app.log' });
  const log = createLogger('cluster');

  const windowHours = Number(arg('window-hours', '48'));
  const db = getDb();
  const rest = new HeliusRestClient({ apiKey: config.HELIUS_API_KEY });

  const result = await recomputeClusters(db, {
    rest,
    windowHours,
    fetch: { delayMs: 200 },
    log: (msg, meta) => log.info(msg, meta),
  });

  console.log(`[cluster] run ${result.runId}`);
  console.log(`  rated wallets:      ${result.walletCount}`);
  console.log(`  funders fetched:    ${result.fundersFetched}`);
  console.log(`  clusters:           ${result.clusterCount}`);
  console.log(`  members in clusters:${result.membersInClusters}`);
  await closeDb(db);
}

main().catch((err: unknown) => {
  console.error('[cluster] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
