import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';
import { FatalError } from './errors.js';

const validEnv = {
  DATABASE_URL: 'postgres://u:p@host:5432/db',
  DIRECT_URL: 'postgres://u:p@host:5432/db',
  REDIS_URL: 'rediss://default:p@host:6379',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('accepts a valid env and applies defaults', () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.BYBIT_TESTNET).toBe(false);
  });

  it('coerces API_PORT and BYBIT_TESTNET from strings', () => {
    const cfg = loadConfig({ ...validEnv, API_PORT: '8080', BYBIT_TESTNET: 'true' });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.BYBIT_TESTNET).toBe(true);
  });

  it('returns a frozen object', () => {
    const cfg = loadConfig(validEnv);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('throws FatalError listing ALL problems at once, not just the first', () => {
    let thrown: unknown;
    try {
      loadConfig({ NODE_ENV: 'staging' }); // bad enum + 3 missing required urls
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FatalError);
    const msg = (thrown as FatalError).message;
    expect(msg).toContain('DATABASE_URL');
    expect(msg).toContain('DIRECT_URL');
    expect(msg).toContain('REDIS_URL');
    expect(msg).toContain('NODE_ENV');
    expect((thrown as FatalError).context.issueCount).toBeGreaterThanOrEqual(4);
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow(FatalError);
  });
});
