import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, closeDb, wallet as walletTable, walletFunder, clusterRun, walletCluster, type Db } from '@tip/database';
import type { HeliusRestClient } from '@tip/ingestion';
import { recomputeClusters, activeClusterMap } from './recompute.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('recomputeClusters (integration, Postgres)', () => {
  let db: Db;
  const funder = `F${randomUUID().slice(0, 8)}`;
  const wA = `WA${randomUUID().slice(0, 6)}`;
  const wB = `WB${randomUUID().slice(0, 6)}`;
  const wC = `WC${randomUUID().slice(0, 6)}`;
  const wallets = [wA, wB, wC];
  // A fake Helius client — recompute should NOT call it because funders are pre-seeded.
  const rest = { getAddressTransactionsPage: vi.fn(async () => ({ swaps: [], lastSignature: null, rawCount: 0, raw: [] })) } as unknown as HeliusRestClient;

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    // Mark the 3 wallets as rated so recompute picks them up.
    await db.insert(walletTable).values(
      wallets.map((address) => ({ address, tradeCount: 20, status: 'rated' as const, lastScoredAt: new Date() })),
    );
    // Seed funder rows so no live fetch is needed — all 3 share one funder within 48h.
    await db.insert(walletFunder).values(
      wallets.map((walletId, i) => ({
        walletId, funderAddress: funder, fundedAt: new Date(Date.UTC(2026, 0, 1, i * 6)),
        fundedSol: '0.1', inferredAtCap: false,
      })),
    );
  });

  afterAll(async () => {
    if (db) {
      await db.delete(walletCluster).where(inArray(walletCluster.walletId, wallets));
      await db.delete(walletFunder).where(inArray(walletFunder.walletId, wallets));
      // Clean cluster_runs created by this test.
      // (We can't easily target only our runs; deleting by whether their members belong to us is fine.)
      await db.delete(walletTable).where(inArray(walletTable.address, wallets));
      await closeDb(db);
    }
  });

  it('creates one cluster of 3 and marks the run active', async () => {
    const r1 = await recomputeClusters(db, { rest });
    expect(r1.walletCount).toBeGreaterThanOrEqual(3);
    expect(r1.clusterCount).toBeGreaterThanOrEqual(1);
    // Note: `rest.getAddressTransactionsPage` may be called for OTHER rated wallets in a shared
    // DB that don't have a funder row; the fake safely returns empty → findFirstFunder → null.

    // The 3 wallets should map to the same cluster in the active run.
    const map = await activeClusterMap(db);
    const ids = wallets.map((w) => map.get(w));
    expect(ids.every((id) => id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(1);

    // Only one active run.
    const active = await db.select().from(clusterRun).where(eq(clusterRun.status, 'active'));
    expect(active).toHaveLength(1);
    expect(active[0]!.runId).toBe(r1.runId);
  });

  it('a second recompute supersedes the first — active run flips atomically', async () => {
    const r1 = await recomputeClusters(db, { rest });
    const r2 = await recomputeClusters(db, { rest });
    expect(r2.runId).not.toBe(r1.runId);

    const active = await db.select().from(clusterRun).where(eq(clusterRun.status, 'active'));
    expect(active).toHaveLength(1);
    expect(active[0]!.runId).toBe(r2.runId);

    // The prior r1 run must now be superseded.
    const r1Row = await db.select().from(clusterRun).where(eq(clusterRun.runId, r1.runId));
    expect(r1Row[0]!.status).toBe('superseded');

    // activeClusterMap still returns the same-cluster grouping (from r2).
    const map = await activeClusterMap(db);
    expect(new Set(wallets.map((w) => map.get(w))).size).toBe(1);
  });
});
