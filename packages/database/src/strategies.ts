import { and, eq } from 'drizzle-orm';
import { strategies, strategyVersions, type Database } from './index.js';
import { researchCatalog } from '../../strategies/src/catalog.js';
export async function registerResearchStrategies(db: Database) {
  const registered: {
    id: string;
    slug: string;
    version: string;
    codeHash: string;
  }[] = [];
  for (const { definition, codeHash } of researchCatalog()) {
    const requirementSnapshot = {
      ...definition.requirements,
      implemented: true,
      validationStatus: 'RESEARCH_UNVALIDATED',
      preset: definition.preset,
      parameters: definition.parameters,
      managementPolicy: definition.managementPolicy,
    };
    const row = await db.transaction(async (tx) => {
      const [strategy] = await tx
        .insert(strategies)
        .values({
          slug: definition.id,
          name:
            definition.id === 'trend-following'
              ? 'Trend following'
              : 'Mean reversion',
        })
        .onConflictDoUpdate({
          target: strategies.slug,
          set: { slug: definition.id },
        })
        .returning();
      if (!strategy) throw Error('Strategy registration failed');
      await tx
        .insert(strategyVersions)
        .values({
          strategyId: strategy.id,
          version: definition.version,
          status: 'DRAFT',
          requirements: requirementSnapshot,
          codeHash,
        })
        .onConflictDoNothing();
      const [version] = await tx
        .select()
        .from(strategyVersions)
        .where(
          and(
            eq(strategyVersions.strategyId, strategy.id),
            eq(strategyVersions.version, definition.version),
          ),
        );
      if (
        !version ||
        version.codeHash !== codeHash ||
        canonical(version.requirements) !== canonical(requirementSnapshot)
      )
        throw Error(
          'Immutable strategy version differs from installed code; increment strategy version',
        );
      return version;
    });
    registered.push({
      id: row!.id,
      slug: definition.id,
      version: definition.version,
      codeHash,
    });
  }
  return registered;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
