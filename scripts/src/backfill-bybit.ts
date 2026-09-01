/**
 * Bybit historical backfill CLI (§25). Loads klines + funding + OI into the local historical
 * store so the replay engine / Brain Seeding can run against local Postgres. Idempotent — safe to
 * re-run or resume.
 *
 *   npm run build
 *   npm run backfill --workspace @tip/scripts -- \
 *     --symbols=BTCUSDT,ETHUSDT,SOLUSDT --timeframes=1m,5m,15m,1h,4h,1d --months=6 --oi-interval=1h
 *
 * Flags (all optional; defaults are the §30 pre-launch set):
 *   --symbols=CSV        default BTCUSDT,ETHUSDT,SOLUSDT
 *   --timeframes=CSV     default 1m,5m,15m,1h,4h,1d
 *   --months=N           default 6
 *   --oi-interval=TOKEN  default 1h  (5min|15min|30min|1h|4h|1d)
 *   --delay-ms=N         default 150 (between REST calls)
 */
import { getConfig, loadEnv, marketSymbol, type Timeframe } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { BybitRestClient } from '@tip/ingestion';
import { backfillKlines, backfillFunding, backfillOpenInterest } from '@tip/evaluation';

/* eslint-disable no-console */
type OiInterval = '5min' | '15min' | '30min' | '1h' | '4h' | '1d';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();
  const db = getDb();
  const rest = new BybitRestClient({ testnet: config.BYBIT_TESTNET });

  const symbols = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map((s) => marketSymbol(s.trim()));
  const timeframes = arg('timeframes', '1m,5m,15m,1h,4h,1d').split(',').map((s) => s.trim() as Timeframe);
  const months = Number(arg('months', '6'));
  const oiInterval = arg('oi-interval', '1h') as OiInterval;
  const delayMs = Number(arg('delay-ms', '150'));

  const toMs = Date.now();
  const fromMs = toMs - months * 30 * 24 * 60 * 60 * 1000;
  console.log(
    `[backfill] range ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()} ` +
      `(${months}mo) · symbols ${symbols.join(',')} · TFs ${timeframes.join(',')}`,
  );

  for (const symbol of symbols) {
    for (const tf of timeframes) {
      const r = await backfillKlines(rest, db, symbol, tf, fromMs, toMs, { delayMs });
      console.log(`[backfill] ${symbol} ${tf} klines: fetched ${r.fetched}, inserted ${r.inserted}`);
    }
    const f = await backfillFunding(rest, db, symbol, fromMs, toMs, { delayMs });
    console.log(`[backfill] ${symbol} funding: fetched ${f.fetched}, inserted ${f.inserted}`);
    const oi = await backfillOpenInterest(rest, db, symbol, oiInterval, fromMs, toMs, { delayMs });
    console.log(`[backfill] ${symbol} OI(${oiInterval}): fetched ${oi.fetched}, inserted ${oi.inserted}`);
  }

  await closeDb(db);
  console.log('[backfill] done');
}

main().catch((err: unknown) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
