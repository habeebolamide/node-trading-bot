import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

/**
 * Load the repo-root `.env` into `process.env`, searching upward from `startDir` (workspace
 * scripts run with cwd = the workspace dir, so the root `.env` is a few levels up). A no-op in
 * production, where the platform injects real env and no `.env` exists — the search simply
 * finds nothing and returns, leaving `process.env` as the source of truth for config.ts.
 *
 * Call this once at the very top of an app's main(), before getConfig().
 */
export function loadEnv(startDir: string = process.cwd()): void {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
}
