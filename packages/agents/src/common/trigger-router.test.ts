import { describe, it, expect, vi } from 'vitest';
import type { DomainEvent } from '@tip/domain';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { TriggerRouter } from './trigger-router.js';

const ctx = {} as unknown as AgentContext;
const event = (type: string): DomainEvent => ({
  id: 'e', type, version: 1, eventTime: 't', processingTime: 't', source: 's', payload: {},
});

function agent(key: string, type: string, out: Partial<AgentOutput> = {}): AnalysisAgent {
  return {
    key, version: 1, trigger: 'EVENT',
    canHandle: (e) => e.type === type,
    analyze: async () => ({ agent: key, agentVersion: 1, direction: 'LONG', score: 0.5, confidence: 0.5, features: {}, ...out }),
  };
}

describe('TriggerRouter', () => {
  it('routes an event to every matching agent and hands outputs to the sink', async () => {
    const sink = vi.fn(async () => {});
    const r = new TriggerRouter(sink);
    r.register(agent('a', 'x'));
    r.register(agent('b', 'x'));
    r.register(agent('c', 'y'));
    await r.route(event('x'), ctx);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.map((c) => (c[0] as AgentOutput).agent).sort()).toEqual(['a', 'b']);
  });
  it('rejects double-registration of the same (key, version)', () => {
    const r = new TriggerRouter(async () => {});
    r.register(agent('a', 'x'));
    expect(() => r.register(agent('a', 'x'))).toThrow(/already registered/);
  });
  it('skips agents that answer skipped:true', async () => {
    const sink = vi.fn(async () => {});
    const r = new TriggerRouter(sink);
    r.register(agent('a', 'x', { skipped: true }));
    await r.route(event('x'), ctx);
    expect(sink).not.toHaveBeenCalled();
  });
});
