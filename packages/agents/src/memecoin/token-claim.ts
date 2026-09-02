/**
 * Token claim + contention resolution (Part II §9a — audit #7).
 *
 * PRODUCT RULE: no two TradingAgents hold the same mint at once. The claim is platform-wide,
 * token-keyed, and atomic via the `active_token_claim` PRIMARY KEY on mint (§29 — the unique
 * constraint IS the concurrency guard, never a check-then-write). A claim lives only while the
 * position is held; `releaseToken` runs on any exit (§10).
 */
import { and, eq } from 'drizzle-orm';
import { activeTokenClaim, type Db } from '@tip/database';

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; heldBy: string };

/**
 * Atomically claim `mint` for `agentId`. Succeeds only if unclaimed — the PK on mint makes a
 * second concurrent claim a DB-level conflict, not a race. Returns who holds it on failure.
 */
export async function claimToken(db: Db, input: { mint: string; tradingAgentId: string; positionId?: string }): Promise<ClaimResult> {
  const inserted = await db.insert(activeTokenClaim)
    .values({ mint: input.mint, tradingAgentId: input.tradingAgentId, positionId: input.positionId ?? null })
    .onConflictDoNothing()
    .returning({ mint: activeTokenClaim.mint });
  if (inserted.length > 0) return { claimed: true };
  const held = (await db.select({ agent: activeTokenClaim.tradingAgentId }).from(activeTokenClaim).where(eq(activeTokenClaim.mint, input.mint)).limit(1))[0];
  return { claimed: false, heldBy: held?.agent ?? 'unknown' };
}

/** Release the claim on a mint (on any position exit, §10). Idempotent. */
export async function releaseToken(db: Db, mint: string): Promise<void> {
  await db.delete(activeTokenClaim).where(eq(activeTokenClaim.mint, mint));
}

/** Release the claim held by a specific position (used when the position id is known at close). */
export async function releaseTokenByPosition(db: Db, positionId: string): Promise<void> {
  await db.delete(activeTokenClaim).where(eq(activeTokenClaim.positionId, positionId));
}

/** True if the mint is currently claimed by anyone — the §9a claimed-token pre-filter. */
export async function isTokenClaimed(db: Db, mint: string): Promise<boolean> {
  const r = await db.select({ mint: activeTokenClaim.mint }).from(activeTokenClaim).where(eq(activeTokenClaim.mint, mint)).limit(1);
  return r.length > 0;
}

/** Pre-filter a candidate set against live claims — drops any mint already held (§9a). */
export async function filterUnclaimed(db: Db, mints: readonly string[]): Promise<Set<string>> {
  if (mints.length === 0) return new Set();
  const rows = await db.select({ mint: activeTokenClaim.mint }).from(activeTokenClaim);
  const claimed = new Set(rows.map((r) => r.mint));
  return new Set(mints.filter((m) => !claimed.has(m)));
}

export interface ContendedPair {
  tradingAgentId: string;
  mint: string;
  score: number;
  /** Creation order — the deterministic tiebreak on equal scores (§9a). Lower = earlier. */
  agentRank: number;
}

export interface Assignment { tradingAgentId: string; mint: string; score: number }

/**
 * Deterministic greedy GLOBAL assignment (§9a). Repeatedly take the single highest available
 * (agent, mint, score) pair, assign it, and remove BOTH that agent and that mint from the pool.
 * This beats token-by-token resolution, which strands agents (§9a's worked example: global 1.65
 * vs greedy-per-token 1.30). Tiebreak: lower `agentRank` (creation order) → fully reproducible.
 *
 * Pure — no I/O. The caller filters claimed mints first (`filterUnclaimed`), then persists the
 * winners via `claimToken`.
 */
export function resolveContention(pairs: readonly ContendedPair[]): Assignment[] {
  const pool = [...pairs].sort((a, b) =>
    b.score - a.score || a.agentRank - b.agentRank || a.mint.localeCompare(b.mint));
  const usedAgents = new Set<string>();
  const usedMints = new Set<string>();
  const out: Assignment[] = [];
  for (const p of pool) {
    if (usedAgents.has(p.tradingAgentId) || usedMints.has(p.mint)) continue;
    out.push({ tradingAgentId: p.tradingAgentId, mint: p.mint, score: p.score });
    usedAgents.add(p.tradingAgentId);
    usedMints.add(p.mint);
  }
  return out;
}
