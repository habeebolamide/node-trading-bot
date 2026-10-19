import { cpSync } from 'node:fs';
cpSync('packages/database/migrations', 'dist/packages/database/migrations', {
  recursive: true,
});

// Retain exact strategy/indicator sources as code-identity evidence beside compiled JS.
cpSync('packages/strategies/src', 'dist/packages/strategies/src', {
  recursive: true,
  filter: (path) => !path.endsWith('.js'),
});
cpSync(
  'packages/market-data/src/indicators.ts',
  'dist/packages/market-data/src/indicators.ts',
);

// Replay manifests pin the exact runtime, risk, execution, accounting and replay sources.
for (const name of [
  'runtime',
  'risk',
  'replay',
  'database',
  'core',
  'market-data',
]) {
  cpSync(`packages/${name}/src`, `dist/packages/${name}/src`, {
    recursive: true,
    filter: (path) => !path.endsWith('.js'),
  });
}
