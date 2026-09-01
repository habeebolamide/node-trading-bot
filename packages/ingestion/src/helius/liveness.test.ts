import { describe, it, expect, vi } from 'vitest';
import type { FeedMonitor } from '../staleness/monitor.js';
import type { HeliusRestClient } from './rest.js';
import { HeliusLivenessProbe } from './liveness.js';
import { HELIUS_REST_FEED } from '../staleness/thresholds.js';

const tick = () => new Promise((r) => setImmediate(r));

function harness(restBehavior: 'ok' | 'fail') {
  const heartbeat = vi.fn();
  const register = vi.fn();
  const monitor = { heartbeat, register } as unknown as FeedMonitor;
  const getAddressTransactions =
    restBehavior === 'ok' ? vi.fn().mockResolvedValue([]) : vi.fn().mockRejectedValue(new Error('down'));
  const rest = { getAddressTransactions } as unknown as HeliusRestClient;
  const probe = new HeliusLivenessProbe({ rest, monitor, canaryWallet: 'CanaryWallet1111', intervalMs: 60_000 });
  return { probe, heartbeat, register };
}

describe('HeliusLivenessProbe', () => {
  it('registers the helius.rest feed and heartbeats it when REST is reachable', async () => {
    const { probe, heartbeat, register } = harness('ok');
    probe.start();
    await tick();
    probe.stop();
    expect(register).toHaveBeenCalledWith(HELIUS_REST_FEED, expect.any(Number));
    expect(heartbeat).toHaveBeenCalledWith(HELIUS_REST_FEED);
  });

  it('does NOT heartbeat when the REST probe fails', async () => {
    const { probe, heartbeat } = harness('fail');
    probe.start();
    await tick();
    probe.stop();
    expect(heartbeat).not.toHaveBeenCalled();
  });
});
