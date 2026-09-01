import { describe, it, expect, vi } from 'vitest';
import { FatalError } from '@tip/domain';
import { HeliusWebhookAdmin, type HeliusWebhookConfig } from './webhooks.js';

const cfg: HeliusWebhookConfig = {
  webhookURL: 'https://tunnel.example/webhooks/helius',
  accountAddresses: ['Wallet1'],
  transactionTypes: ['SWAP'],
  webhookType: 'enhanced',
  authHeader: 'secret',
};

/** Route a fake fetch by HTTP method, capturing calls. */
function router(list: unknown[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    const json =
      method === 'GET' ? list : method === 'POST' ? { webhookID: 'new', ...cfg } : { webhookID: 'existing', ...cfg };
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  });
  return { fetchImpl, calls };
}

describe('HeliusWebhookAdmin.registerOrUpdate', () => {
  it('creates when no webhook targets the URL', async () => {
    const { fetchImpl, calls } = router([]); // no existing webhooks
    const admin = new HeliusWebhookAdmin({ apiKey: 'k', fetchImpl });
    const { action, webhook } = await admin.registerOrUpdate(cfg);
    expect(action).toBe('created');
    expect(webhook.webhookID).toBe('new');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1]!.body).toMatchObject({ webhookURL: cfg.webhookURL, authHeader: 'secret' });
  });

  it('updates the existing webhook with the same URL', async () => {
    const { fetchImpl, calls } = router([{ webhookID: 'existing', ...cfg }]);
    const admin = new HeliusWebhookAdmin({ apiKey: 'k', fetchImpl });
    const { action, webhook } = await admin.registerOrUpdate({ ...cfg, accountAddresses: ['Wallet1', 'Wallet2'] });
    expect(action).toBe('updated');
    expect(webhook.webhookID).toBe('existing');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]!.url).toContain('/v0/webhooks/existing');
  });

  it('throws without an api key and on a 4xx', async () => {
    expect(() => new HeliusWebhookAdmin({ apiKey: '' })).toThrow(FatalError);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response);
    await expect(new HeliusWebhookAdmin({ apiKey: 'k', fetchImpl }).list()).rejects.toBeInstanceOf(FatalError);
  });
});
