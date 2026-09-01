import { describe, it, expect } from 'vitest';
import { signalFingerprint } from './fingerprint.js';

describe('signalFingerprint', () => {
  it('same-minute same-idea → same fingerprint (dedupes re-arrivals)', () => {
    const a = signalFingerprint({ tradingAgentId: 'ta1', symbol: 'BTCUSDT', direction: 'LONG', primaryTfCloseAt: new Date('2026-06-01T00:00:00Z') });
    const b = signalFingerprint({ tradingAgentId: 'ta1', symbol: 'BTCUSDT', direction: 'LONG', primaryTfCloseAt: new Date('2026-06-01T00:00:59Z') });
    expect(a).toBe(b);
  });

  it('different candle-minute → different fingerprint', () => {
    const a = signalFingerprint({ tradingAgentId: 'ta1', symbol: 'BTCUSDT', direction: 'LONG', primaryTfCloseAt: new Date('2026-06-01T00:00:00Z') });
    const b = signalFingerprint({ tradingAgentId: 'ta1', symbol: 'BTCUSDT', direction: 'LONG', primaryTfCloseAt: new Date('2026-06-01T00:01:00Z') });
    expect(a).not.toBe(b);
  });

  it('different direction or symbol or agent → different fingerprint', () => {
    const base = { tradingAgentId: 'ta1', symbol: 'BTCUSDT', direction: 'LONG', primaryTfCloseAt: new Date('2026-06-01T00:00:00Z') };
    expect(signalFingerprint(base)).not.toBe(signalFingerprint({ ...base, direction: 'SHORT' }));
    expect(signalFingerprint(base)).not.toBe(signalFingerprint({ ...base, symbol: 'ETHUSDT' }));
    expect(signalFingerprint(base)).not.toBe(signalFingerprint({ ...base, tradingAgentId: 'ta2' }));
  });
});
