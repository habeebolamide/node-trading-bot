import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Resolve workspace packages to their TypeScript source so `vitest` runs without
// a prior `tsc --build`. Production/runtime resolution still uses the built dist
// via each package.json "exports"; this alias is test-time only.
export default defineConfig({
  resolve: {
    alias: {
      '@tip/domain': pkg('./packages/domain/src/index.ts'),
      '@tip/events': pkg('./packages/events/src/index.ts'),
      '@tip/database': pkg('./packages/database/src/index.ts'),
      '@tip/ingestion': pkg('./packages/ingestion/src/index.ts'),
      '@tip/evaluation': pkg('./packages/evaluation/src/index.ts'),
      '@tip/wallets': pkg('./packages/wallets/src/index.ts'),
      '@tip/watchlist': pkg('./packages/watchlist/src/index.ts'),
      '@tip/trading-agents': pkg('./packages/trading-agents/src/index.ts'),
      '@tip/agents': pkg('./packages/agents/src/index.ts'),
      '@tip/brain': pkg('./packages/brain/src/index.ts'),
      '@tip/planner': pkg('./packages/planner/src/index.ts'),
      '@tip/predictions': pkg('./packages/predictions/src/index.ts'),
      '@tip/paper-engine': pkg('./packages/paper-engine/src/index.ts'),
      '@tip/seeding': pkg('./packages/seeding/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // Integration suites gate themselves on DATABASE_URL / REDIS_URL via skipIf.
    testTimeout: 15_000,
  },
});
