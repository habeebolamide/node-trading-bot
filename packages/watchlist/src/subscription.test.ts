import { describe, it, expect, vi } from 'vitest';
import { FatalError } from '@tip/domain';
import type { Db } from '@tip/database';
import type { HeliusWebhookAdmin } from '@tip/ingestion';
import { HeliusSubscriptionManager } from './subscription.js';

/** Build a minimal fake Drizzle db.select().from().where() chain returning `rows`. */
function fakeDb(rows: { address: string }[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as unknown as Db;
}

function makeManager(rows: { address: string }[]) {
  const registerOrUpdate = vi.fn(async () => ({
    webhook: { webhookID: 'w1', webhookURL: 'u', accountAddresses: rows.map((r) => r.address), transactionTypes: ['SWAP'], webhookType: 'enhanced', authHeader: 's' },
    action: 'updated' as const,
  }));
  const admin = { registerOrUpdate } as unknown as HeliusWebhookAdmin;
  const mgr = new HeliusSubscriptionManager({
    db: fakeDb(rows),
    admin,
    config: { webhookURL: 'https://api.example/webhooks/helius', authHeader: 'secret' },
  });
  return { mgr, registerOrUpdate };
}

describe('HeliusSubscriptionManager.reconcile', () => {
  it('pushes the active address list to Helius (transactionTypes defaults to [SWAP])', async () => {
    const rows = [{ address: 'W1' }, { address: 'W2' }, { address: 'W3' }];
    const { mgr, registerOrUpdate } = makeManager(rows);
    const result = await mgr.reconcile();
    expect(result.addresses).toBe(3);
    expect(registerOrUpdate).toHaveBeenCalledOnce();
    const arg = registerOrUpdate.mock.calls[0]![0];
    expect(arg.accountAddresses).toEqual(['W1', 'W2', 'W3']);
    expect(arg.transactionTypes).toEqual(['SWAP']);
    expect(arg.webhookURL).toBe('https://api.example/webhooks/helius');
    expect(arg.authHeader).toBe('secret');
  });

  it('handles an empty watchlist', async () => {
    const { mgr, registerOrUpdate } = makeManager([]);
    await mgr.reconcile();
    expect(registerOrUpdate.mock.calls[0]![0].accountAddresses).toEqual([]);
  });

  it('throws FatalError when active list exceeds the free-tier cap of 100', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ address: `W${i}` }));
    const { mgr, registerOrUpdate } = makeManager(many);
    await expect(mgr.reconcile()).rejects.toBeInstanceOf(FatalError);
    expect(registerOrUpdate).not.toHaveBeenCalled();
  });
});
