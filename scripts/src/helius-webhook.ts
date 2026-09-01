/**
 * Register / list / delete the Helius webhook that pushes wallet activity to our api
 * `/webhooks/helius` endpoint (Part II §7). Idempotent register (matches by URL → updates).
 *
 *   npm run helius-webhook --workspace @tip/scripts -- register \
 *     --url=https://<your-tunnel-or-domain>/webhooks/helius --addresses=Wallet1,Wallet2
 *   npm run helius-webhook --workspace @tip/scripts -- list
 *   npm run helius-webhook --workspace @tip/scripts -- delete --id=<webhookID>
 *
 * The webhook's authHeader is set to HELIUS_WEBHOOK_SECRET, which the api checks on every POST.
 * Reminder: the URL must be publicly reachable — Helius cannot POST to localhost. Use a tunnel
 * (ngrok / cloudflared) in dev, or a deployed api URL.
 *
 * register flags:  --url=… (required)  --addresses=CSV (default: canary wallet)
 *                  --types=CSV (default SWAP; use Any for all)  --devnet
 */
import { getConfig, loadEnv } from '@tip/domain';
import { HeliusWebhookAdmin, HELIUS_CANARY_WALLET, type HeliusWebhookType } from '@tip/ingestion';

/* eslint-disable no-console */
function arg(name: string, fallback = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (flag: string): boolean => process.argv.includes(`--${flag}`);

async function main(): Promise<void> {
  loadEnv();
  const config = getConfig();
  if (!config.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required (set it in .env)');
  const admin = new HeliusWebhookAdmin({ apiKey: config.HELIUS_API_KEY });
  const command = process.argv[2];

  switch (command) {
    case 'register': {
      const url = arg('url');
      if (!url) throw new Error('register requires --url=https://…/webhooks/helius');
      if (!config.HELIUS_WEBHOOK_SECRET) throw new Error('HELIUS_WEBHOOK_SECRET is required to register (auth header)');
      const addresses = arg('addresses', HELIUS_CANARY_WALLET).split(',').map((a) => a.trim()).filter(Boolean);
      const transactionTypes = arg('types', 'SWAP').split(',').map((t) => t.trim());
      const webhookType: HeliusWebhookType = has('devnet') ? 'enhancedDevnet' : 'enhanced';

      const { webhook, action } = await admin.registerOrUpdate({
        webhookURL: url,
        accountAddresses: addresses,
        transactionTypes,
        webhookType,
        authHeader: config.HELIUS_WEBHOOK_SECRET,
      });
      console.log(`[helius-webhook] ${action}: id=${webhook.webhookID}`);
      console.log(`  url:       ${webhook.webhookURL}`);
      console.log(`  type:      ${webhook.webhookType}  txTypes: ${transactionTypes.join(',')}`);
      console.log(`  addresses: ${addresses.length} (${addresses.slice(0, 3).join(', ')}${addresses.length > 3 ? ', …' : ''})`);
      break;
    }
    case 'list': {
      const hooks = await admin.list();
      if (hooks.length === 0) {
        console.log('[helius-webhook] no webhooks registered');
        break;
      }
      for (const w of hooks) {
        console.log(`- id=${w.webhookID}  ${w.webhookURL}  [${w.webhookType}]  ${w.accountAddresses?.length ?? 0} addr`);
      }
      break;
    }
    case 'delete': {
      const id = arg('id');
      if (!id) throw new Error('delete requires --id=<webhookID>');
      await admin.delete(id);
      console.log(`[helius-webhook] deleted ${id}`);
      break;
    }
    default:
      console.error('usage: helius-webhook <register|list|delete> [flags] — see file header');
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[helius-webhook] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
