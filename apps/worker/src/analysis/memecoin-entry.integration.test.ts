import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  activeTokenClaim, createDb, closeDb, paperPortfolio, paperPosition, paperPositionFill,
  paperPositionOriginatingWallet, prediction, signal, signalNoTrade, scoringConfig, tradingAgent, type Db,
} from '@tip/database';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import type { DomainEvent } from '@tip/domain';
import { createTradingAgent } from '@tip/trading-agents';
import { createMemecoinEntryOrchestrator } from './memecoin-entry.js';

const DATABASE_URL = process.env.DATABASE_URL;
const MINT = `M${randomUUID().slice(0, 10)}`;

const MEME_CFG = {
  riskPercent: 0.02, minRR: 0, maxConcurrentPositions: 1,
  agentWeights: { 'memecoin.smart_money': 0.5, 'memecoin.convergence': 0.5 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
  stopPct: 0.3,
  takeProfitPct: 1.0, // required alongside stopPct — memecoin.ts guards against neither being set
  walletExitThreshold: 0.9,
  maxPoolShare: 0.01,
};

describe.skipIf(!DATABASE_URL)('memecoin entry orchestrator (Batch D)', () => {
  let db: Db;
  let agentId: string;
  const publish = vi.fn(async () => ({ id: 'e' }));
  const bus = { publish } as unknown as EventBus;
  const created = { agents: [] as string[], signals: [] as string[], positions: [] as string[], predictions: [] as string[], portfolios: [] as string[] };

  function sigEvent(signalId: string): DomainEvent {
    return {
      id: `e-${randomUUID().slice(0, 8)}`, type: EVENT_NAMES.SIGNAL_CREATED, version: 1,
      eventTime: new Date().toISOString(), processingTime: new Date().toISOString(), source: 'test',
      payload: { signalId, tradingAgentId: agentId, symbol: MINT, domain: 'memecoin', direction: 'LONG', compositeScore: 0.6, confidence: 0.7, configVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
  }

  async function seedSignal(over: { evidence?: unknown } = {}): Promise<string> {
    const id = randomUUID();
    created.signals.push(id);
    await db.insert(signal).values({
      id, tradingAgentId: agentId, symbol: MINT, domain: 'memecoin', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'ACTIVE',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000),
      configVersion: 1, fingerprint: `me-${randomUUID().slice(0, 8)}`,
      evidence: over.evidence ?? {
        contributions: [
          { agent: 'memecoin.convergence', agentVersion: 1, weight: 0.5, contribution: 0.3, features: { convergenceScore: 60 } },
          { agent: 'memecoin.smart_money', agentVersion: 1, weight: 0.5, contribution: 0.3,
            features: { wallet: 'W1', walletScore: 82, amountSol: '2.5', tokenAmount: '25000', signature: 'sig-1' } },
        ],
      },
    });
    return id;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `ME-${randomUUID().slice(0, 6)}`, domain: 'memecoin', universe: ['solana'], tradingStyle: 'scalp', config: MEME_CFG,
    });
    agentId = a.id; created.agents.push(agentId);
  });

  afterAll(async () => {
    if (db) {
      await db.delete(activeTokenClaim).where(eq(activeTokenClaim.mint, MINT));
      const preds = await db.select({ id: prediction.id }).from(prediction).where(eq(prediction.tradingAgentId, agentId));
      const predIds = preds.map((p) => p.id);
      if (predIds.length) {
        const posIds = (await db.select({ id: paperPosition.id }).from(paperPosition).where(inArray(paperPosition.predictionId, predIds))).map((r) => r.id);
        if (posIds.length) {
          await db.delete(paperPositionFill).where(inArray(paperPositionFill.positionId, posIds));
          await db.delete(paperPositionOriginatingWallet).where(inArray(paperPositionOriginatingWallet.positionId, posIds));
          await db.delete(paperPosition).where(inArray(paperPosition.id, posIds));
        }
        await db.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
        await db.delete(prediction).where(inArray(prediction.id, predIds));
        await db.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      }
      await db.delete(paperPortfolio).where(eq(paperPortfolio.tradingAgentId, agentId));
      await db.delete(signalNoTrade).where(inArray(signalNoTrade.signalId, created.signals));
      await db.delete(signal).where(inArray(signal.id, created.signals));
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('with no reserves resolver: claims → NO_FILL(RESERVES_UNAVAILABLE) → releases the claim (rule 25)', async () => {
    const handler = createMemecoinEntryOrchestrator({ db, bus });
    const signalId = await seedSignal();
    await handler(sigEvent(signalId));

    // Signal is now INVALIDATED (recordNoTrade transitions it).
    const sig = (await db.select().from(signal).where(eq(signal.id, signalId)))[0]!;
    expect(sig.state).toBe('INVALIDATED');
    const veto = (await db.select().from(signalNoTrade).where(eq(signalNoTrade.signalId, signalId)))[0]!;
    expect(veto.reason).toBe('STALE_OR_MISSING_DATA');
    expect(veto.detail).toContain('RESERVES_UNAVAILABLE');
    // Claim released.
    expect(await db.select().from(activeTokenClaim).where(eq(activeTokenClaim.mint, MINT))).toHaveLength(0);
    // No prediction / position.
    expect(await db.select().from(prediction).where(eq(prediction.signalId, signalId))).toHaveLength(0);
  });

  it('with a live reserves resolver: FILL → prediction + OPEN position + originating-wallet rows + FAST publishes', async () => {
    const resolveReserves = vi.fn(async () => ({ xToken: 1_000_000, ySol: 100, fee: 0.0025 }));
    const handler = createMemecoinEntryOrchestrator({ db, bus, resolveReserves });
    const signalId = await seedSignal();
    await handler(sigEvent(signalId));

    const sig = (await db.select().from(signal).where(eq(signal.id, signalId)))[0]!;
    expect(sig.state).toBe('CONSUMED');
    const pred = (await db.select().from(prediction).where(eq(prediction.signalId, signalId)))[0]!;
    expect(pred).toBeDefined();
    created.predictions.push(pred.id);
    const pos = (await db.select().from(paperPosition).where(eq(paperPosition.predictionId, pred.id)))[0]!;
    expect(pos.state).toBe('OPEN');
    expect(pos.direction).toBe('LONG');
    expect(pos.domain).toBe('memecoin');
    created.positions.push(pos.id);
    // Claim re-keyed to the position id.
    const claim = (await db.select().from(activeTokenClaim).where(eq(activeTokenClaim.mint, MINT)))[0]!;
    expect(claim.tradingAgentId).toBe(agentId);
    expect(claim.positionId).toBe(pos.id);
    // Originating-wallet row from the smart-money features.
    const originators = await db.select().from(paperPositionOriginatingWallet).where(eq(paperPositionOriginatingWallet.positionId, pos.id));
    expect(originators.length).toBeGreaterThanOrEqual(1);
    expect(originators[0]!.walletId).toBe('W1');
    // FAST publishes.
    const types = publish.mock.calls.map((c) => (c as unknown as [string, { type: string }])[1].type);
    expect(types).toContain(EVENT_NAMES.PREDICTION_CREATED);
    expect(types).toContain(EVENT_NAMES.PAPER_TRADE_OPENED);
  });

  it('token-claim contention: a second signal for the same mint is refused with CANNOT_SIZE_SAFELY', async () => {
    // First path succeeded above; claim now held. A second signal → refused, claim untouched.
    const handler = createMemecoinEntryOrchestrator({ db, bus });
    const signalId = await seedSignal();
    await handler(sigEvent(signalId));

    const veto = (await db.select().from(signalNoTrade).where(eq(signalNoTrade.signalId, signalId)))[0]!;
    expect(veto.reason).toBe('CANNOT_SIZE_SAFELY');
    expect(veto.detail).toContain('already claimed');
    const claim = (await db.select().from(activeTokenClaim).where(eq(activeTokenClaim.mint, MINT)))[0]!;
    // Claim still belongs to the same agent + position from test 2.
    expect(claim.tradingAgentId).toBe(agentId);
  });

  it('no observable buy price on the signal → NO_TRADE(STALE_OR_MISSING_DATA), claim released', async () => {
    // Reset from test 2: close the open position + drop the claim so this test can reach the
    // observedPrice gate rather than short-circuiting on capacity.
    if (created.positions.length > 0) {
      await db.update(paperPosition)
        .set({ state: 'CLOSED', closeReason: 'HORIZON_EXPIRY', closedAt: new Date() })
        .where(inArray(paperPosition.id, created.positions));
    }
    await db.delete(activeTokenClaim).where(eq(activeTokenClaim.mint, MINT));
    const handler = createMemecoinEntryOrchestrator({ db, bus });
    const signalId = await seedSignal({
      evidence: { contributions: [
        { agent: 'memecoin.convergence', agentVersion: 1, weight: 1, contribution: 0.5, features: {} },
      ] }, // no smart-money features → no buy price
    });
    await handler(sigEvent(signalId));

    const veto = (await db.select().from(signalNoTrade).where(eq(signalNoTrade.signalId, signalId)))[0]!;
    expect(veto.reason).toBe('STALE_OR_MISSING_DATA');
    expect(await db.select().from(activeTokenClaim).where(eq(activeTokenClaim.mint, MINT))).toHaveLength(0);
  });

  it('perp signals are ignored (routing gate)', async () => {
    const handler = createMemecoinEntryOrchestrator({ db, bus });
    const perpEvent = { ...sigEvent(randomUUID()), payload: { ...sigEvent(randomUUID()).payload, domain: 'perp' } } as DomainEvent;
    await expect(handler(perpEvent)).resolves.toBeUndefined();
  });
});
