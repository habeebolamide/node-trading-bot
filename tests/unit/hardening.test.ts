import { it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { Decimal } from 'decimal.js';
import { sizeOrder } from '../../packages/risk/src/sizing.js';
import { fixtureInstrument } from '../fixtures/market.js';
import {
  configFromEnv,
  paperEntriesEnabled,
  createLogger,
} from '../../packages/core/src/index.js';
it('property: randomized decimal risk-sized quantities never exceed loss, margin or profile leverage caps', () => {
  const now = Date.UTC(2026, 9, 19, 12, 17);
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1000000 }),
      fc.integer({ min: 1, max: 9900 }),
      fc.constantFrom('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'),
      (cents, stopCents, profile) => {
        const equity = new Decimal(cents).div(100).toString(),
          stop = new Decimal(stopCents).div(100).toString();
        try {
          const approval = sizeOrder({
            equity,
            entry: '100',
            stop,
            target: '110',
            side: 'LONG',
            profile,
            instrument: {
              ...fixtureInstrument(undefined, now),
              minNotional: '.00000001',
              minQuantity: '.00000001',
              quantityStep: '.00000001',
            },
            now,
          });
          const p = approval.policy.profiles[profile];
          expect(
            new Decimal(approval.stopExposure).lte(
              new Decimal(equity).mul(p.loss),
            ),
          ).toBe(true);
          expect(
            new Decimal(approval.margin).lte(new Decimal(equity).mul(p.margin)),
          ).toBe(true);
          expect(approval.leverage).toBeLessThanOrEqual(p.leverage);
          expect(
            new Decimal(approval.quantity)
              .mod(approval.instrument.quantityStep)
              .isZero(),
          ).toBe(true);
        } catch (e) {
          if (
            !(e instanceof Error) ||
            !['MIN_ORDER_NOT_MET', 'LEVERAGE_OR_MARGIN_LIMIT'].includes(
              e.message,
            )
          )
            throw e;
        }
      },
    ),
    { seed: 22082026, numRuns: 1000 },
  );
});
it('production defaults to Protect & Freeze, rejects LIVE and non-loopback API binding', () => {
  expect(paperEntriesEnabled({ NODE_ENV: 'production' })).toBe(false);
  expect(
    paperEntriesEnabled({
      NODE_ENV: 'production',
      PAPER_ENTRIES_ENABLED: 'true',
    }),
  ).toBe(true);
  expect(() => paperEntriesEnabled({ PAPER_ENTRIES_ENABLED: 'yes' })).toThrow();
  expect(() =>
    configFromEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      EXECUTION_MODE: 'LIVE',
    }),
  ).toThrow();
  expect(() =>
    configFromEnv({
      DATABASE_URL: 'postgresql://localhost/test',
      NODE_ENV: 'production',
      API_HOST: '0.0.0.0',
    }),
  ).toThrow();
});
it('redacts bearer, Telegram and nested API credentials from structured logs', () => {
  const output: string[] = [];
  const log = createLogger('redaction', 'info', {
    write: (s) => {
      output.push(s);
    },
  });
  log.info(
    {
      TELEGRAM_BOT_TOKEN: 'telegram-private-marker',
      req: { headers: { authorization: 'bearer-private-marker' } },
      adapter: { apiKey: 'exchange-private-marker' },
    },
    'fixture',
  );
  const line = output.join('');
  for (const marker of [
    'telegram-private-marker',
    'bearer-private-marker',
    'exchange-private-marker',
  ])
    expect(line).not.toContain(marker);
  expect(line).toContain('[Redacted]');
  expect(line).toContain('fixture');
});
it('native backup connections sanitize inherited libpq overrides and require verified TLS remotely', async () => {
  const { pgEnvironment } =
    await import('../../packages/operations/src/backup.js');
  vi.stubEnv('PGHOSTADDR', 'untrusted-host');
  vi.stubEnv('PGOPTIONS', '-c role=unexpected');
  let env: ReturnType<typeof pgEnvironment>;
  try {
    env = pgEnvironment(
      'postgresql://operator:p%40ss@127.0.0.1:55432/paper_test',
    );
  } finally {
    vi.unstubAllEnvs();
  }
  expect(env.PGHOST).toBe('127.0.0.1');
  expect(env.PGPASSWORD).toBe('p@ss');
  expect(env.PGDATABASE).toBe('paper_test');
  expect('PGHOSTADDR' in env).toBe(false);
  expect('PGOPTIONS' in env).toBe(false);
  expect(() =>
    pgEnvironment('postgresql://operator@example.invalid/paper'),
  ).toThrow('verify-full');
  expect(
    pgEnvironment(
      'postgresql://operator@example.invalid/paper?sslmode=verify-full',
    ).PGSSLMODE,
  ).toBe('verify-full');
  expect(() =>
    pgEnvironment('postgresql://localhost/name%3Dconnection'),
  ).toThrow('database name');
  expect(() =>
    pgEnvironment('postgresql://localhost/paper?options=unsafe'),
  ).toThrow();
});
