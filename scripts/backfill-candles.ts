// ─────────────────────────────────────────────
// Backfill historical candles into the DB for backtesting.
//
//   nvm use 22
//   npm run backfill -- BTCUSDT 2025-04-01 2025-04-30 [--with-1m]
//
// Fetches every timeframe the bot uses across the given date range from Bybit
// and bulk-inserts them (idempotent — safe to re-run). 1m is heavy (~130k rows
// per 3 months) and off by default; add --with-1m only when you need it.
// Requires Node 22+ (uses fetch).
// ─────────────────────────────────────────────

import 'dotenv/config'; // load .env so any env-reading imports initialise correctly
import { fetchHistoricalRange, persistCandles } from '../markets/historical.js';
import type { CandleInterval } from '../types/market.types.js';
import { prisma } from '../lib/prisma.js';

async function main() {
  const [pair, startStr, endStr, ...flags] = process.argv.slice(2);

  if (!pair || !startStr || !endStr) {
    console.error('Usage: npm run backfill -- <PAIR> <START yyyy-mm-dd> <END yyyy-mm-dd> [--with-1m]');
    process.exit(1);
  }

  const startMs = Date.parse(startStr);
  const endMs   = Date.parse(endStr);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    console.error(`Invalid date range: ${startStr} → ${endStr}`);
    process.exit(1);
  }

  const with1m = flags.includes('--with-1m');
  const timeframes: CandleInterval[] = with1m
    ? ['D', '240', '60', '15', '5', '1']
    : ['D', '240', '60', '15', '5'];

  console.log(`\nBackfilling ${pair} from ${startStr} to ${endStr}`);
  console.log(`Timeframes: ${timeframes.join(', ')}${with1m ? '' : '  (1m skipped — pass --with-1m to include)'}\n`);

  for (const tf of timeframes) {
    const candles = await fetchHistoricalRange(pair, tf, startMs, endMs);
    if (candles.length === 0) {
      console.log(`  ${tf.padEnd(4)} — no candles returned (check pair/date range)`);
      continue;
    }
    const written = await persistCandles(candles);
    const first = new Date(candles[0]!.openTime).toISOString().slice(0, 16);
    const last  = new Date(candles.at(-1)!.openTime).toISOString().slice(0, 16);
    console.log(
      `  ${tf.padEnd(4)} — fetched ${String(candles.length).padStart(6)}, ` +
      `inserted ${String(written).padStart(6)} new   [${first} → ${last}]`,
    );
  }

  console.log('\nBackfill complete.\n');
}

main()
  .catch(err => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
