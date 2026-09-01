import { describe, it, expect } from 'vitest';
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext } from '@tip/trading-agents';
import { memecoinSmartMoneyAgent } from './smart-money.js';
import { memecoinConvergenceAgent } from './convergence.js';
import { memecoinTokenQualityAgent } from './token-quality.js';
import { memecoinTokenRiskAgent, isVetoed } from './token-risk.js';
import { computeEarlyEntry } from './features/early-entry.js';
import { freshness } from './features/freshness.js';

const dummyCtx = {} as unknown as AgentContext;

function event<T>(type: string, payload: T): DomainEvent<T> {
  return {
    id: 'evt', type, version: 1, eventTime: '2026-06-01T00:00:00Z', processingTime: '2026-06-01T00:00:00Z',
    source: 't', payload,
  };
}

describe('memecoin.smart_money (§40.7)', () => {
  it('LONG for a rated buy — score normalized to [0,1]', async () => {
    const out = await memecoinSmartMoneyAgent.analyze(
      event(EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED, {
        wallet: 'W', walletScore: 80, mint: 'M', amountSol: '2', tokenAmount: '1000',
        blockTime: '2026-06-01T00:00:00Z', signature: 'sig',
      }),
      dummyCtx,
    );
    expect(out!.direction).toBe('LONG');
    expect(out!.score).toBeCloseTo(0.8, 6);
    expect(out!.confidence).toBeGreaterThan(0);
  });
  it('null for unrated / zero-score wallet', async () => {
    const out = await memecoinSmartMoneyAgent.analyze(
      event(EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED, { wallet: 'W', walletScore: 0, mint: 'M', amountSol: '1', tokenAmount: '1', blockTime: '', signature: '' }),
      dummyCtx,
    );
    expect(out).toBeNull();
  });
  it('canHandle only matches the right event type', () => {
    expect(memecoinSmartMoneyAgent.canHandle(event('x', {}))).toBe(false);
    expect(memecoinSmartMoneyAgent.canHandle(event(EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED, {}))).toBe(true);
  });
});

describe('memecoin.convergence (§40.8)', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    mint: 'M', batchOpenedAt: '2026-06-01T00:00:00Z', batchClosedAt: '2026-06-01T00:00:05Z',
    batchingWindowMs: 5000, buys: [], perCluster: [], convergenceScore: 100,
    independentClusterCount: 3, timeCompression: 1.0, ...over,
  });
  it('packages the M3 emitter output as a LONG signal', async () => {
    const out = await memecoinConvergenceAgent.analyze(event(EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED, payload()), dummyCtx);
    expect(out!.direction).toBe('LONG');
    expect(out!.score).toBeCloseTo(0.5, 6); // 100 / 200
    expect(out!.confidence).toBeGreaterThan(0.5);
  });
  it('single-cluster confidence is thin (~0.3-0.6)', async () => {
    const out = await memecoinConvergenceAgent.analyze(
      event(EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED, payload({ independentClusterCount: 1, timeCompression: 0.5, convergenceScore: 20 })),
      dummyCtx,
    );
    expect(out!.confidence).toBeGreaterThanOrEqual(0.3);
    expect(out!.confidence).toBeLessThan(0.7);
  });
});

describe('memecoin.token_quality (§40.10)', () => {
  const payload = (over: Record<string, unknown> = {}) => ({ mint: 'M', liquidityUsd: 100_000, ageMinutes: 120, top10HolderPct: 30, ...over });
  it('all three sub-features present → confidence ≈ 0.85', async () => {
    const out = await memecoinTokenQualityAgent.analyze(event(EVENT_NAMES.TOKEN_PROFILE_UPDATED, payload()), dummyCtx);
    expect(out!.confidence).toBeCloseTo(0.85, 2);
    expect(out!.score).toBeGreaterThan(0);
  });
  it('missing sub-feature caps confidence at 0.6', async () => {
    const out = await memecoinTokenQualityAgent.analyze(event(EVENT_NAMES.TOKEN_PROFILE_UPDATED, payload({ top10HolderPct: undefined })), dummyCtx);
    expect(out!.confidence).toBeLessThanOrEqual(0.6);
  });
  it('null when nothing available', async () => {
    const out = await memecoinTokenQualityAgent.analyze(event(EVENT_NAMES.TOKEN_PROFILE_UPDATED, { mint: 'M' }), dummyCtx);
    expect(out).toBeNull();
  });
});

describe('memecoin.token_risk (§40.13 HARD VETO)', () => {
  const base = (over: Record<string, unknown> = {}) => event(EVENT_NAMES.TOKEN_PROFILE_UPDATED, { mint: 'M', metadataAvailable: true, mintAuthorityLive: false, freezeAuthorityPresent: false, lpLocked: true, lpBurned: false, topSingleHolderPct: 20, honeypotPatterns: [], ...over });
  it('clean token → no veto', async () => {
    const out = await memecoinTokenRiskAgent.analyze(base(), dummyCtx);
    expect(isVetoed(out)).toBe(false);
  });
  it('mint authority live → veto', async () => {
    const out = await memecoinTokenRiskAgent.analyze(base({ mintAuthorityLive: true }), dummyCtx);
    expect(isVetoed(out)).toBe(true);
    expect((out!.features as { reasons: string[] }).reasons).toContain('MINT_AUTHORITY_LIVE');
  });
  it('freeze authority present → veto', async () => {
    const out = await memecoinTokenRiskAgent.analyze(base({ freezeAuthorityPresent: true }), dummyCtx);
    expect(isVetoed(out)).toBe(true);
  });
  it('LP unlocked AND not burned → veto', async () => {
    const out = await memecoinTokenRiskAgent.analyze(base({ lpLocked: false, lpBurned: false }), dummyCtx);
    expect(isVetoed(out)).toBe(true);
  });
  it('top single holder > 40% → veto', async () => {
    const out = await memecoinTokenRiskAgent.analyze(base({ topSingleHolderPct: 55 }), dummyCtx);
    expect(isVetoed(out)).toBe(true);
  });
  it('honeypot pattern → veto', async () => {
    const out = await memecoinTokenRiskAgent.analyze(base({ honeypotPatterns: ['HIGH_SELL_TAX'] }), dummyCtx);
    expect(isVetoed(out)).toBe(true);
  });
  it('fail-closed on missing metadata → veto', async () => {
    const out = await memecoinTokenRiskAgent.analyze(base({ metadataAvailable: false }), dummyCtx);
    expect(isVetoed(out)).toBe(true);
    expect((out!.features as { reasons: string[] }).reasons).toContain('METADATA_UNAVAILABLE');
  });
});

describe('features', () => {
  it('freshness τ=15s: 1.0 at t=0, ~1/e at t=15s', () => {
    expect(freshness(0)).toBeCloseTo(1, 6);
    expect(freshness(15_000)).toBeCloseTo(1 / Math.E, 3);
    expect(freshness(30_000)).toBeCloseTo(1 / (Math.E * Math.E), 3);
  });
  it('computeEarlyEntry: null when no BrainWalletMemory rows', async () => {
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as import('@tip/database').Db;
    const out = await computeEarlyEntry(db, [{ wallet: 'W', walletScore: 80, amountSol: 1 }]);
    expect(out).toBeNull();
  });
});
