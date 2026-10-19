// Composition-layer registry. Pure strategy implementations never import this module.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { researchStrategies } from './research.js';
import { freeze } from './helpers.js';
const sources = [
  'contracts.ts',
  'context.ts',
  'helpers.ts',
  'research.ts',
  'engine.ts',
];
export function strategyCodeHash() {
  const hash = createHash('sha256');
  for (const source of sources)
    hash
      .update(source)
      .update('\0')
      .update(readFileSync(new URL(source, import.meta.url)))
      .update('\0');
  hash
    .update('indicator-adapter\0')
    .update(
      readFileSync(
        new URL('../../market-data/src/indicators.ts', import.meta.url),
      ),
    );
  return hash.digest('hex');
}
export function researchCatalog() {
  const codeHash = strategyCodeHash();
  return freeze(
    researchStrategies.map((definition) => ({ definition, codeHash })),
  );
}
