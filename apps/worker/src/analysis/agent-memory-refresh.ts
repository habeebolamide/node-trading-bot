/**
 * BrainAgentMemory aggregate refresh (§16 — audit-2 finding: `persistAgentMemory` had zero
 * callers, so `brain_agent_memory` stayed empty forever and /api/brain/agents always returned
 * nothing). Called from the outcome-sweep scheduler after any sweep that fed the Brain: for
 * every (domain, agentKey, agentVersion) with recorded occurrences, recompute and upsert the
 * cached aggregate. The key space is small (one row per analysis agent per version), so a full
 * refresh per feeding sweep is cheap and always consistent.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { persistAgentMemory, type Domain } from '@tip/brain';

export async function refreshAgentMemories(db: Db, asOf = new Date()): Promise<number> {
  const rows = await db.execute(sql`
    SELECT DISTINCT domain, agent_key AS "agentKey", agent_version AS "agentVersion"
      FROM brain_agent_occurrence
  `);
  let refreshed = 0;
  for (const r of rows as unknown as Iterable<{ domain: string; agentKey: string; agentVersion: number }>) {
    const mem = await persistAgentMemory(db, r.domain as Domain, r.agentKey, Number(r.agentVersion), asOf);
    if (mem) refreshed++;
  }
  return refreshed;
}
