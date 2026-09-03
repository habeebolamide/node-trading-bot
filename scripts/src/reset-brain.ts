/**
 * Wipes ALL seeded Brain state so a re-seed starts clean. Deletes, in FK order:
 *   brain_setup_occurrence, brain_agent_occurrence, brain_setup_memory,
 *   brain_agent_memory (dropping and re-creating the immutable-prediction trigger around
 *   the prediction deletes), prediction_outcome, prediction, signal, plus the seeding
 *   checkpoint markers in domain_event. Preserves market_candle + funding + open_interest
 *   + trading_agent + scoring_config — the backfill and your agents stay intact.
 *
 * SAFETY: this script deletes append-only "facts" (rule 8) — DO NOT run against a shared or
 * production DB. Reads DATABASE_URL from .env same as the other scripts. Refuses when the URL
 * host is not localhost / 127.0.0.1 unless FORCE=1 is set.
 *
 *   npm run reset-brain --workspace @tip/scripts
 *   FORCE=1 npm run reset-brain --workspace @tip/scripts   # override the localhost guard
 */
import { sql } from 'drizzle-orm';
import { getConfig, loadEnv } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';

/* eslint-disable no-console */
async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();

  const url = new URL(config.DATABASE_URL);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!isLocal && process.env.FORCE !== '1') {
    console.error(`[reset-brain] REFUSED — DATABASE_URL host "${url.hostname}" is not localhost.`);
    console.error('               Set FORCE=1 to override, but read the header comment first.');
    process.exit(1);
  }

  const db = getDb();
  console.log(`[reset-brain] target: ${url.hostname}${url.pathname}`);
  try {
    // Wrap in one transaction so a mid-run failure doesn't leave partial state.
    await db.transaction(async (tx) => {
      const drop = async (table: string, extra = ''): Promise<void> => {
        const r = await tx.execute(sql.raw(`DELETE FROM ${table} ${extra}`));
        console.log(`[reset-brain] cleared ${table}: ${r.count ?? '(n/a)'} rows`);
      };
      await drop('brain_setup_occurrence');
      await drop('brain_agent_occurrence');
      await drop('brain_setup_memory');
      await drop('brain_agent_memory');
      await drop('prediction_outcome');
      // prediction has a DELETE-blocking trigger (rule 10) — drop, wipe, re-create.
      await tx.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
      await drop('prediction');
      await tx.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      await drop('signal_no_trade');
      await drop('signal_feature');
      await drop('signal_risk');
      await drop('signal');
      // Seeder checkpoint markers.
      await drop('domain_event', `WHERE type = 'brain-seeding.checkpoint'`);
    });
    console.log('[reset-brain] done — safe to re-run npm run seed-brain');
  } finally {
    await closeDb(db);
  }
}

main().catch((err: unknown) => {
  console.error('[reset-brain] failed:', err);
  process.exit(1);
});
