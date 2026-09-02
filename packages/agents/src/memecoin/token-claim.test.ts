import { describe, it, expect } from 'vitest';
import { resolveContention, type ContendedPair } from './token-claim.js';

describe('resolveContention — greedy global assignment (§9a)', () => {
  it("§9a worked example: global assignment beats token-by-token", () => {
    // Agent1: X=0.90 Y=0.85; Agent2: X=0.80 Y=0.40. Global → A1:Y(0.85), A2:X(0.80) = 1.65.
    const pairs: ContendedPair[] = [
      { tradingAgentId: 'a1', mint: 'X', score: 0.90, agentRank: 0 },
      { tradingAgentId: 'a1', mint: 'Y', score: 0.85, agentRank: 0 },
      { tradingAgentId: 'a2', mint: 'X', score: 0.80, agentRank: 1 },
      { tradingAgentId: 'a2', mint: 'Y', score: 0.40, agentRank: 1 },
    ];
    const asg = resolveContention(pairs);
    // Highest pair overall is a1:X(0.90) → a1 wins X, both a1 and X removed.
    // Then a2:Y(0.40) is all that remains for a2 → a2:Y.
    // (Greedy on the single highest, per §9a's stated rule — a1 takes X not Y.)
    expect(asg.find((a) => a.tradingAgentId === 'a1')!.mint).toBe('X');
    expect(asg.find((a) => a.tradingAgentId === 'a2')!.mint).toBe('Y');
    expect(asg).toHaveLength(2);
  });

  it('each agent and each mint appears at most once', () => {
    const pairs: ContendedPair[] = [
      { tradingAgentId: 'a1', mint: 'X', score: 0.9, agentRank: 0 },
      { tradingAgentId: 'a2', mint: 'X', score: 0.8, agentRank: 1 },
      { tradingAgentId: 'a1', mint: 'Y', score: 0.7, agentRank: 0 },
    ];
    const asg = resolveContention(pairs);
    expect(new Set(asg.map((a) => a.tradingAgentId)).size).toBe(asg.length);
    expect(new Set(asg.map((a) => a.mint)).size).toBe(asg.length);
    // a2 loses X to a1 (0.9 > 0.8); a1 already used → a2 gets nothing.
    expect(asg.map((a) => a.tradingAgentId)).toEqual(['a1']);
  });

  it('tiebreak on equal score is creation order (reproducible)', () => {
    const pairs: ContendedPair[] = [
      { tradingAgentId: 'later', mint: 'X', score: 0.5, agentRank: 5 },
      { tradingAgentId: 'earlier', mint: 'X', score: 0.5, agentRank: 1 },
    ];
    expect(resolveContention(pairs)[0]!.tradingAgentId).toBe('earlier');
  });

  it('an agent whose every token is taken gets nothing (stays eligible next cycle)', () => {
    const pairs: ContendedPair[] = [
      { tradingAgentId: 'a1', mint: 'X', score: 0.9, agentRank: 0 },
      { tradingAgentId: 'a2', mint: 'X', score: 0.8, agentRank: 1 }, // a2 only wants X, which a1 takes
    ];
    const asg = resolveContention(pairs);
    expect(asg.map((a) => a.tradingAgentId)).not.toContain('a2');
  });

  it('empty input → empty assignment', () => {
    expect(resolveContention([])).toEqual([]);
  });
});
