import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, paperPortfolio, paperPosition, paperPositionFill,
  paperPositionOriginatingWallet, walletSellObservation,
  prediction, signal, tradingAgent, scoringConfig, type Db,
} from '@tip/database';
import { createTradingAgent } from '@tip/trading-agents';
import { createPortfolio } from './portfolio.js';
import { openPosition } from './position.js';
import { processWalletSell, recordOriginatingWallets } from './wallet-exit.js';

const DATABASE_URL = process.env.DATABASE_URL;
const T = new Date('2026-06-01T00:00:00Z');
const MINT = `MintWE${randomUUID().slice(0, 8)}`;
const WALLET_A = `WalA${randomUUID().slice(0, 8)}`;
const WALLET_B = `WalB${randomUUID().slice(0, 8)}`;

const memecoinConfig = {
  riskPercent: 0.02, minRR: 0, maxConcurrentPositions: 1,
  agentWeights: { 'memecoin.smart_money': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
  stopPct: 0.3,
  walletExitThreshold: 0.9,
};

describe.skipIf(!DATABASE_URL)('wallet-exit live wiring (Part II §10 Design 1, integration)', () => {
  let db: Db;
  let agentId: string;
  let portfolioId: string;
  let positionId: string;
  const created = { agents: [] as string[], portfolios: [] as string[], positions: [] as string[], signals: [] as string[], predictions: [] as string[] };

  function sell(over: Partial<Parameters<typeof processWalletSell>[1]> = {}) {
    return {
      wallet: WALLET_A, mint: MINT, signature: `sig-${randomUUID().slice(0, 12)}`,
      tokenAmount: 400, amountSol: 0.36, // implied price 0.0009 — the wallet's observed execution
      blockTime: new Date(T.getTime() + 60_000), processingAt: new Date(T.getTime() + 62_500),
      ...over,
    };
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `WE-${randomUUID().slice(0, 6)}`, domain: 'memecoin', universe: ['solana'], tradingStyle: 'scalp', config: memecoinConfig,
    });
    agentId = a.id; created.agents.push(agentId);
    const p = await createPortfolio(db, { tradingAgentId: agentId, startingCash: 10_000 });
    portfolioId = p.id; created.portfolios.push(portfolioId);

    // Position: 10,000 tokens at 0.001, plus its signal/prediction chain.
    const sigId = randomUUID();
    created.signals.push(sigId);
    await db.insert(signal).values({
      id: sigId, tradingAgentId: agentId, symbol: MINT, domain: 'memecoin', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'CONSUMED',
      createdAt: T, expiresAt: new Date(T.getTime() + 60_000), configVersion: 1,
      fingerprint: `we-${randomUUID().slice(0, 8)}`, evidence: {},
    });
    const predId = randomUUID();
    created.predictions.push(predId);
    await db.insert(prediction).values({
      id: predId, tradingAgentId: agentId, signalId: sigId, domain: 'memecoin', symbol: MINT,
      direction: 'LONG', score: '0.6', confidence: '0.7', horizon: '4h',
      entry: '0.001', stopLoss: '0.0007', takeProfit: null,
      positionSize: '10000', notional: '10', leverage: '1', requiredMargin: '10',
      riskReward: '2', features: [], configVersion: 1,
    });
    const pos = await openPosition(db, {
      portfolioId, predictionId: predId, symbol: MINT, domain: 'memecoin', direction: 'LONG',
      entryPrice: 0.001, size: 10_000, currentStop: 0.0007, takeProfit: null, ladder: null,
      openedAtEvent: T, openedAtProcessing: new Date(T.getTime() + 2_000),
    });
    positionId = pos.id; created.positions.push(positionId);

    // Two originating wallets: A carries 60% of the cluster weight, B 40%.
    await recordOriginatingWallets(db, [
      { positionId, walletId: WALLET_A, entryUsd: 6, entryWeight: 0.6, entryTokenAmount: 1_000 },
      { positionId, walletId: WALLET_B, entryUsd: 4, entryWeight: 0.4, entryTokenAmount: 500 },
    ]);
  });

  afterAll(async () => {
    if (db) {
      await db.delete(walletSellObservation).where(inArray(walletSellObservation.positionId, created.positions));
      await db.delete(paperPositionOriginatingWallet).where(inArray(paperPositionOriginatingWallet.positionId, created.positions));
      await db.delete(paperPositionFill).where(inArray(paperPositionFill.positionId, created.positions));
      await db.delete(paperPosition).where(inArray(paperPosition.id, created.positions));
      await db.delete(paperPortfolio).where(inArray(paperPortfolio.id, created.portfolios));
      await db.execute(sql`DROP TRIGGER IF EXISTS prediction_no_delete ON prediction`);
      await db.delete(prediction).where(inArray(prediction.id, created.predictions));
      await db.execute(sql`CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation()`);
      await db.delete(signal).where(inArray(signal.id, created.signals));
      for (const id of created.agents) {
        await db.delete(scoringConfig).where(eq(scoringConfig.tradingAgentId, id));
        await db.delete(tradingAgent).where(eq(tradingAgent.id, id));
      }
      await closeDb(db);
    }
  });

  it('recordOriginatingWallets is idempotent — re-insert never resets held fraction', async () => {
    await recordOriginatingWallets(db, [
      { positionId, walletId: WALLET_A, entryUsd: 6, entryWeight: 0.6, entryTokenAmount: 1_000 },
    ]);
    const rows = await db.select().from(paperPositionOriginatingWallet)
      .where(eq(paperPositionOriginatingWallet.positionId, positionId));
    expect(rows).toHaveLength(2);
  });

  it('sell from a non-originating wallet touches nothing', async () => {
    const outcomes = await processWalletSell(db, sell({ wallet: `Stranger${randomUUID().slice(0, 6)}` }));
    expect(outcomes).toEqual([]);
  });

  it('partial sell below threshold: decrements held fraction, logs observation, position stays OPEN', async () => {
    // A sells 400 of its 1,000 entry tokens → 40% of entry → exited weight 0.6×0.4 = 0.24.
    const s = sell();
    const outcomes = await processWalletSell(db, s);
    expect(outcomes).toHaveLength(1);
    const o = outcomes[0]!;
    expect(o.crossed).toBe(false);
    expect(o.closed).toBe(false);
    expect(o.accumulator).toBeCloseTo(0.24, 9);

    const row = (await db.select().from(paperPositionOriginatingWallet).where(and(
      eq(paperPositionOriginatingWallet.positionId, positionId),
      eq(paperPositionOriginatingWallet.walletId, WALLET_A),
    )))[0]!;
    expect(Number(row.currentHeldFraction)).toBeCloseTo(0.6, 9);

    const obs = await db.select().from(walletSellObservation).where(eq(walletSellObservation.positionId, positionId));
    expect(obs).toHaveLength(1);
    expect(obs[0]!.crossedThreshold).toBe(false);

    const pos = (await db.select().from(paperPosition).where(eq(paperPosition.id, positionId)))[0]!;
    expect(pos.state).toBe('OPEN');

    // §29 idempotency: the SAME signature redelivered decrements nothing.
    const dup = await processWalletSell(db, s);
    expect(dup[0]!.duplicate).toBe(true);
    const after = (await db.select().from(paperPositionOriginatingWallet).where(and(
      eq(paperPositionOriginatingWallet.positionId, positionId),
      eq(paperPositionOriginatingWallet.walletId, WALLET_A),
    )))[0]!;
    expect(Number(after.currentHeldFraction)).toBeCloseTo(0.6, 9);
  });

  it('crossing walletExitThreshold: binary full close, WALLET_EXIT, priced at the wallet\'s own sell', async () => {
    // A dumps its remaining 600 → A fully exited (0.6). Accumulator 0.6 < 0.9 → still open.
    const mid = await processWalletSell(db, sell({ tokenAmount: 600, amountSol: 0.48 }));
    expect(mid[0]!.crossed).toBe(false);
    expect(mid[0]!.accumulator).toBeCloseTo(0.6, 9);

    // B dumps all 500 → accumulator 1.0 ≥ 0.9 → close at B's observed price 0.4/500 = 0.0008.
    const fin = await processWalletSell(db, sell({ wallet: WALLET_B, tokenAmount: 500, amountSol: 0.4 }));
    expect(fin[0]!.crossed).toBe(true);
    expect(fin[0]!.closed).toBe(true);
    expect(fin[0]!.closePrice).toBeCloseTo(0.0008, 12);

    const pos = (await db.select().from(paperPosition).where(eq(paperPosition.id, positionId)))[0]!;
    expect(pos.state).toBe('CLOSED');
    expect(pos.closeReason).toBe('WALLET_EXIT');
    // LONG from 0.001 closed at 0.0008 on 10,000 tokens → realized P&L = -2.
    expect(Number(pos.realizedPnl)).toBeCloseTo(-2, 6);

    const obs = await db.select().from(walletSellObservation).where(eq(walletSellObservation.positionId, positionId));
    expect(obs).toHaveLength(3); // every sell logged, including the crossing one
    expect(obs.filter((r) => r.crossedThreshold)).toHaveLength(1);
  });

  it('sells after the close touch nothing (position no longer OPEN)', async () => {
    const outcomes = await processWalletSell(db, sell({ wallet: WALLET_B, tokenAmount: 1 }));
    expect(outcomes).toEqual([]);
  });
});
