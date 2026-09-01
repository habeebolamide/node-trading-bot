import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Db } from '@tip/database';
import type { EventBus } from '@tip/events';
import { register, registeredProcessors, clearRegistryForTests, type Processor } from './registry.js';
import { startWorkers } from './runner.js';

beforeEach(() => clearRegistryForTests());

describe('registry', () => {
  it('records processors and rejects double registration', () => {
    const p: Processor = async () => {};
    register('agent-analysis', p);
    expect(registeredProcessors().map(([q]) => q)).toEqual(['agent-analysis']);
    expect(() => register('agent-analysis', p)).toThrow(/already registered/);
  });
});

describe('startWorkers', () => {
  it('creates one worker per registered processor', () => {
    register('signal-processing', async () => {});
    register('brain-processing', async () => {});
    const createWorker = vi.fn();
    const bus = { createWorker } as unknown as EventBus;
    const db = {} as Db;

    startWorkers(bus, db);

    expect(createWorker).toHaveBeenCalledTimes(2);
    const queues = createWorker.mock.calls.map((c) => c[0]);
    expect(queues).toEqual(expect.arrayContaining(['signal-processing', 'brain-processing']));
  });
});
