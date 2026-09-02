import { describe, it, expect } from 'vitest';
import { agentLean, LONG_ONLY_AGENTS, NON_DIRECTIONAL_AGENTS, type AgentContribution } from './agent-memory.js';

const c = (agent: string, score: number): AgentContribution => ({ agent, agentVersion: 1, score });

describe('agentLean (§16 — direction-for-direction)', () => {
  it('signed agents lean by the sign of their own score', () => {
    expect(agentLean(c('perp.momentum', 0.7))).toBe(1);
    expect(agentLean(c('perp.momentum', -0.7))).toBe(-1);
    expect(agentLean(c('perp.funding', -0.2))).toBe(-1);
  });

  it('a zero score is NO OPINION, not a bearish lean', () => {
    expect(agentLean(c('perp.momentum', 0))).toBeNull();
    expect(agentLean(c('perp.positioning', 0))).toBeNull();
  });

  it('long-only memecoin agents at 0 are silent — scoring that bearish would manufacture a record', () => {
    for (const agent of LONG_ONLY_AGENTS) {
      expect(agentLean(c(agent, 0))).toBeNull();
      expect(agentLean(c(agent, 0.6))).toBe(1);
    }
  });

  it('Token Risk and the Risk Agent are excluded — a veto has no direction', () => {
    for (const agent of NON_DIRECTIONAL_AGENTS) {
      expect(agentLean(c(agent, 0.9))).toBeNull();
      expect(agentLean(c(agent, -0.9))).toBeNull();
    }
  });

  it('Market Regime is scored on its BIAS, which is its score (§7 — the bias, not the enum)', () => {
    expect(agentLean(c('perp.market_regime', 0.5))).toBe(1);
    expect(agentLean(c('memecoin.market_regime', -0.5))).toBe(-1);
    expect(NON_DIRECTIONAL_AGENTS).not.toContain('perp.market_regime');
  });

  it('the tiniest non-zero score still counts as a lean', () => {
    expect(agentLean(c('perp.momentum', 1e-9))).toBe(1);
    expect(agentLean(c('perp.momentum', -1e-9))).toBe(-1);
  });
});
