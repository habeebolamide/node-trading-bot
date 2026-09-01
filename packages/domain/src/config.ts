import { z } from 'zod';
import { FatalError } from './errors.js';

/**
 * The single environment boundary (CLAUDE.md — "Env vars"). Nothing else in the
 * codebase reads `process.env`; everything reads the frozen object returned here.
 *
 * Validation is all-at-once: a bad env throws a FatalError listing *every*
 * problem, not the first one — so a fresh clone with three missing vars is fixed
 * in one pass, not three boot attempts.
 *
 * Provider credentials (Helius, DeepSeek, Telegram) are optional at this layer so
 * the foundation boots without them; the subsystem that needs one asserts its
 * presence at *its* startup (e.g. the Helius adapter requires HELIUS_API_KEY).
 * The always-required trio is the data spine: Postgres (pooled + direct) and Redis.
 */
const boolish = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1')
  .default('false');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  API_PORT: z.coerce.number().int().positive().default(3000),

  // Data spine — always required.
  DATABASE_URL: z.string().url(), // pooled, runtime
  DIRECT_URL: z.string().url(), // non-pooled, migrations
  REDIS_URL: z.string().min(1), // rediss:// (Upstash) or redis://

  // Perp provider (public data needs no keys; keys only for private endpoints).
  BYBIT_API_KEY: z.string().default(''),
  BYBIT_SECRET: z.string().default(''),
  BYBIT_TESTNET: boolish,

  // Memecoin provider — optional here, required by the Helius adapter itself.
  HELIUS_API_KEY: z.string().optional(),
  HELIUS_WEBHOOK_SECRET: z.string().optional(),
  // Public URL of apps/api's /webhooks/helius — required for the watchlist to auto-manage the
  // Helius subscription (m3-watchlist). Optional here so non-M3 workflows still boot.
  HELIUS_WEBHOOK_URL: z.string().url().optional(),

  // LLM (Judge/autopsy, perp-only MVP) — optional; Judge degrades gracefully (§18).
  DEEPSEEK_API_KEY: z.string().optional(),

  // Telegram fast-lane alerts (§11) — optional; a Telegram outage never blocks a fill.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

export type Config = Readonly<z.infer<typeof EnvSchema>>;

/**
 * Validate an env record (defaults to `process.env`) and return a frozen Config.
 * Pure and injectable — pass an explicit record in tests rather than mutating the
 * global environment. Throws FatalError with a full problem list on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new FatalError(
      `Invalid environment — fix all of the following and restart:\n${problems}`,
      { issueCount: parsed.error.issues.length },
    );
  }
  return Object.freeze(parsed.data);
}

let cached: Config | undefined;

/**
 * Memoized accessor over `process.env`, validated on first call. Apps call this
 * once at boot so a misconfigured process dies immediately and loudly.
 */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test-only: clear the memoized config so a later getConfig re-validates. */
export function resetConfigForTests(): void {
  cached = undefined;
}
