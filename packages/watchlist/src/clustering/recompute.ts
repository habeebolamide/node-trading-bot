/**
 * Cluster recompute (Part II §5, Task 6). Full pass:
 *   1. Load all RATED wallets (§4 — unrated wallets carry no convergence weight)
 *   2. For each without a wallet_funder row, findFirstFunder (cached forever after)
 *   3. cluster() the funder rows within the window (default 48h)
 *   4. Insert a new cluster_run + wallet_cluster rows; flip prior active runs to 'superseded'.
 *      Whole write is one transaction so readers joining `status='active'` never see partial data.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { wallet as walletTable, walletFunder, clusterRun, walletCluster, type Db } from '@tip/database';
import type { HeliusRestClient } from '@tip/ingestion';
import { cluster, type Cluster, type FunderTaggedWallet } from './cluster.js';
import { findFirstFunder, type FindFunderOptions } from './funder-fetch.js';

export interface RecomputeOptions {
  rest: HeliusRestClient;
  windowHours?: number;
  fetch?: FindFunderOptions;
  log?: (msg: string, meta?: unknown) => void;
}

export interface RecomputeResult {
  runId: string;
  walletCount: number; // rated wallets considered
  fundersFetched: number; // new funder rows this run
  clusterCount: number;
  membersInClusters: number;
}

export async function recomputeClusters(db: Db, opts: RecomputeOptions): Promise<RecomputeResult> {
  const log = opts.log ?? (() => {});
  const windowHours = opts.windowHours ?? 48;

  // 1. Rated wallets.
  const rated = (
    await db.select({ address: walletTable.address }).from(walletTable).where(eq(walletTable.status, 'rated'))
  ).map((r) => r.address);
  log('clustering: rated wallets', { count: rated.length });
  if (rated.length === 0) {
    return finalizeEmpty(db, windowHours);
  }

  // 2. Fetch missing funders.
  const existing = new Set(
    (await db.select({ walletId: walletFunder.walletId }).from(walletFunder).where(inArray(walletFunder.walletId, rated)))
      .map((r) => r.walletId),
  );
  const missing = rated.filter((w) => !existing.has(w));
  let fundersFetched = 0;
  for (const wallet of missing) {
    try {
      const info = await findFirstFunder(opts.rest, wallet, opts.fetch ?? {});
      if (info) {
        await db.insert(walletFunder).values({
          walletId: info.wallet,
          funderAddress: info.funder,
          fundedAt: info.fundedAt,
          fundedSol: String(info.fundedSol),
          inferredAtCap: info.inferredAtCap,
        }).onConflictDoNothing();
        fundersFetched += 1;
      }
    } catch (err) {
      log('funder-fetch failed', { wallet, err: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3. Load funder rows + cluster them.
  const funderRows = await db
    .select({ walletId: walletFunder.walletId, funder: walletFunder.funderAddress, fundedAt: walletFunder.fundedAt })
    .from(walletFunder)
    .where(inArray(walletFunder.walletId, rated));
  const clusters = cluster(funderRows as FunderTaggedWallet[], { windowHours });
  const membersInClusters = clusters.reduce((n, c) => n + c.members.length, 0);
  log('clustering: computed', { clusters: clusters.length, membersInClusters });

  // 4. Insert new run + members, supersede any prior active runs — one transaction.
  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx
      .update(clusterRun)
      .set({ status: 'superseded' })
      .where(eq(clusterRun.status, 'active'));
    await tx.insert(clusterRun).values({
      runId,
      windowHours,
      walletCount: rated.length,
      clusterCount: clusters.length,
      status: 'active',
    });
    if (clusters.length > 0) {
      await tx.insert(walletCluster).values(
        clusters.flatMap((c) =>
          c.members.map((m) => ({
            id: randomUUID(),
            clusterId: c.clusterId,
            walletId: m.walletId,
            clusterRunId: runId,
          })),
        ),
      );
    }
  });

  return { runId, walletCount: rated.length, fundersFetched, clusterCount: clusters.length, membersInClusters };
}

async function finalizeEmpty(db: Db, windowHours: number): Promise<RecomputeResult> {
  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.update(clusterRun).set({ status: 'superseded' }).where(eq(clusterRun.status, 'active'));
    await tx.insert(clusterRun).values({ runId, windowHours, walletCount: 0, clusterCount: 0, status: 'active' });
  });
  return { runId, walletCount: 0, fundersFetched: 0, clusterCount: 0, membersInClusters: 0 };
}

/** Read-side helper: the active cluster membership map { walletId → clusterId }. Used by change 3. */
export async function activeClusterMap(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ walletId: walletCluster.walletId, clusterId: walletCluster.clusterId })
    .from(walletCluster)
    .innerJoin(clusterRun, eq(clusterRun.runId, walletCluster.clusterRunId))
    .where(eq(clusterRun.status, 'active'));
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.walletId, r.clusterId);
  return map;
}

