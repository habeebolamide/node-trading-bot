/**
 * Keeps the Helius webhook's watched-address list in sync with `watched_wallet` (§7 live path).
 * The webhook is registered idempotently by URL (registerOrUpdate) — first call creates, later
 * calls update in place — so `reconcile()` is safe to call after every add/remove.
 *
 * Free-tier cap (§7): 100 addresses per webhook. Splitting across multiple webhooks is a later
 * refinement; at MVP scale we throw with a clear message.
 */
import { isNull } from 'drizzle-orm';
import { FatalError } from '@tip/domain';
import { watchedWallet, type Db } from '@tip/database';
import { HeliusWebhookAdmin, type HeliusWebhookType } from '@tip/ingestion';

const MAX_ADDRESSES_PER_WEBHOOK = 100;

export interface SubscriptionConfig {
  webhookURL: string;
  authHeader: string;
  webhookType?: HeliusWebhookType;
  transactionTypes?: string[];
}

export interface HeliusSubscriptionManagerDeps {
  db: Db;
  admin: HeliusWebhookAdmin;
  config: SubscriptionConfig;
  log?: (msg: string, meta?: unknown) => void;
}

export class HeliusSubscriptionManager {
  private readonly log: (msg: string, meta?: unknown) => void;
  constructor(private readonly deps: HeliusSubscriptionManagerDeps) {
    this.log = deps.log ?? (() => {});
  }

  /** Push the DB's active watched-wallet list to Helius. Safe to call on every add/remove. */
  async reconcile(): Promise<{ addresses: number; action: 'created' | 'updated' }> {
    const rows = await this.deps.db
      .select({ address: watchedWallet.address })
      .from(watchedWallet)
      .where(isNull(watchedWallet.unwatchedAt));
    const active = rows.map((r) => r.address);
    if (active.length > MAX_ADDRESSES_PER_WEBHOOK) {
      throw new FatalError(
        `${active.length} watched wallets exceeds Helius free-tier cap of ${MAX_ADDRESSES_PER_WEBHOOK} per webhook — split across multiple webhooks or upgrade`,
      );
    }
    const { webhook, action } = await this.deps.admin.registerOrUpdate({
      webhookURL: this.deps.config.webhookURL,
      accountAddresses: active,
      transactionTypes: this.deps.config.transactionTypes ?? ['SWAP'],
      webhookType: this.deps.config.webhookType ?? 'enhanced',
      authHeader: this.deps.config.authHeader,
    });
    this.log(`helius subscription ${action}`, {
      webhookID: webhook.webhookID,
      addresses: active.length,
    });
    return { addresses: active.length, action };
  }

  /** Called on worker boot so DB drift (manual admin changes) doesn't outlive a restart. */
  async reconcileAll(): Promise<void> {
    await this.reconcile();
  }
}
