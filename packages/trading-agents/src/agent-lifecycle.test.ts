import { describe, it, expect } from 'vitest';
import { canTransitionAgent, type AgentLifecycleState } from './agent-lifecycle.js';

describe('canTransitionAgent (§37)', () => {
  it('BLOCKED is reachable from every state', () => {
    for (const s of ['IDLE', 'WATCHING', 'PENDING_ENTRY', 'IN_TRADE', 'COOLDOWN'] as AgentLifecycleState[]) {
      expect(canTransitionAgent(s, 'BLOCKED')).toBe(true);
    }
  });
  it('IN_TRADE → COOLDOWN allowed; COOLDOWN → IDLE allowed', () => {
    expect(canTransitionAgent('IN_TRADE', 'COOLDOWN')).toBe(true);
    expect(canTransitionAgent('COOLDOWN', 'IDLE')).toBe(true);
  });
  it('BLOCKED recovers to IDLE / WATCHING / IN_TRADE', () => {
    expect(canTransitionAgent('BLOCKED', 'IDLE')).toBe(true);
    expect(canTransitionAgent('BLOCKED', 'IN_TRADE')).toBe(true);
  });
  it('self-transition is always allowed (idempotent refresh)', () => {
    for (const s of ['IDLE', 'IN_TRADE', 'BLOCKED'] as AgentLifecycleState[]) {
      expect(canTransitionAgent(s, s)).toBe(true);
    }
  });
  it('COOLDOWN cannot jump straight to PENDING_ENTRY (must clear first)', () => {
    expect(canTransitionAgent('COOLDOWN', 'PENDING_ENTRY')).toBe(false);
  });
});
