/**
 * Helius webhook admin (Part II §7) — create/list/update/delete the webhook subscription that
 * pushes wallet activity to our api `/webhooks/helius` endpoint. Operational tooling, kept behind
 * the ingestion/helius seam because it speaks the Helius API (rule 17). Driven by the
 * `scripts/helius-webhook.ts` CLI.
 *
 * `registerOrUpdate` is idempotent: it matches an existing webhook by URL and PUTs an update, or
 * POSTs a new one — so re-running with the same URL never creates duplicates.
 */
import { RetryableError, FatalError } from '@tip/domain';

const BASE = 'https://api.helius.xyz';

/** Helius enhanced webhook type = decoded/parsed transactions (what parse.ts expects). */
export type HeliusWebhookType = 'enhanced' | 'enhancedDevnet';

export interface HeliusWebhookConfig {
  webhookURL: string;
  accountAddresses: string[];
  /** Helius transaction-type enums, or ['Any']. Default ['SWAP'] for memecoin. */
  transactionTypes: string[];
  webhookType: HeliusWebhookType;
  /** Sent by Helius as the Authorization header; must equal HELIUS_WEBHOOK_SECRET. */
  authHeader: string;
}

export interface HeliusWebhook extends HeliusWebhookConfig {
  webhookID: string;
}

export interface HeliusWebhookAdminOptions {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HeliusWebhookAdmin {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HeliusWebhookAdminOptions) {
    if (!opts.apiKey) throw new FatalError('HeliusWebhookAdmin requires an apiKey (HELIUS_API_KEY)');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    url.searchParams.set('api-key', this.apiKey);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        signal: ac.signal,
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
    } catch (err) {
      throw new RetryableError(`helius webhook ${method} ${path} failed`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const Err = res.status >= 500 ? RetryableError : FatalError;
      throw new Err(`helius webhook ${method} ${path} HTTP ${res.status}`);
    }
    // DELETE returns an empty/confirmation body; callers ignore it.
    return (await res.json().catch(() => ({}))) as T;
  }

  list(): Promise<HeliusWebhook[]> {
    return this.request<HeliusWebhook[]>('GET', '/v0/webhooks');
  }

  create(cfg: HeliusWebhookConfig): Promise<HeliusWebhook> {
    return this.request<HeliusWebhook>('POST', '/v0/webhooks', cfg);
  }

  update(webhookID: string, cfg: HeliusWebhookConfig): Promise<HeliusWebhook> {
    return this.request<HeliusWebhook>('PUT', `/v0/webhooks/${webhookID}`, cfg);
  }

  delete(webhookID: string): Promise<void> {
    return this.request<void>('DELETE', `/v0/webhooks/${webhookID}`);
  }

  /** Create the webhook, or update the existing one that already targets the same URL. */
  async registerOrUpdate(cfg: HeliusWebhookConfig): Promise<{ webhook: HeliusWebhook; action: 'created' | 'updated' }> {
    const existing = (await this.list()).find((w) => w.webhookURL === cfg.webhookURL);
    if (existing) {
      return { webhook: await this.update(existing.webhookID, cfg), action: 'updated' };
    }
    return { webhook: await this.create(cfg), action: 'created' };
  }
}
