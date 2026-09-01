/**
 * Standalone wallet-scoring pass (§4). Recomputes every wallet that has reconstructed trades and
 * appends a WalletScoreEvent per rated wallet. Postgres-only, no Helius/Redis (no bus). Run after
 * a backfill to (re)score without re-fetching history.
 *
 *   npm run score --workspace @tip/scripts
 */
import { loadEnv } from '@tip/domain';
import { getDb, closeDb } from '@tip/database';
import { scoreAllWallets } from '@tip/wallets';

/* eslint-disable no-console */
async function main(): Promise<void> {
  loadEnv();
  const db = getDb();
  const r = await scoreAllWallets(db, { log: (m) => console.log(`[score] ${m}`) });
  console.log(`[score] ${r.rated} rated, ${r.unrated} unrated`);
  for (const s of [...r.scored].sort((a, b) => b.score - a.score)) {
    console.log(`  ${s.score.toFixed(1).padStart(5)}  ${s.walletId}`);
  }
  await closeDb(db);
  console.log('[score] done — scores written to wallet_score_event; profiles to wallet');
}

main().catch((err: unknown) => {
  console.error('[score] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
