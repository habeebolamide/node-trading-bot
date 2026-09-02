import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createDb, closeDb, marketCandle, paperPortfolio, paperPosition, paperPositionFill,
  prediction, signal, signalNoTrade, scoringConfig, tradingAgent, type Db,
} from '@tip/database';
import { EVENT_NAMES, type EventBus } from '@tip/events';
import type { DomainEvent } from '@tip/domain';
import { createTradingAgent } from '@tip/trading-agents';
import { createEntryOrchestrator, expireStaleSignals } from './entry-orchestrator.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SYM = `ORCH${randomUUID().slice(0, 4).toUpperCase()}USDT`;

const CFG = {
  riskPercent: 0.01, minRR: 1.5, maxConcurrentPositions: 1, leverageMax: 10,
  agentWeights: { 'perp.momentum': 1 },
  confidenceWeights: { signalStrength: 0.3, agentAgreement: 0.3, historicalEvidence: 0.25, dataQuality: 0.15 },
  signalThresholds: { strongLong: 0.7, long: 0.45, weakLong: 0.2, weakShort: -0.2, short: -0.45, strongShort: -0.7 },
};

describe.skipIf(!DATABASE_URL)('entry orchestrator (audit-2 #1 — signal → prediction → paper open)', () => {
  let db: Db;
  let agentId: string;
  const publish = vi.fn(async () => ({ id: 'e' }));
  const bus = { publish } as unknown as EventBus;
  const created = { agents: [] as string[], signals: [] as string[], predictions: [] as string[], positions: [] as string[], portfolios: [] as string[] };

  function sigEvent(signalId: string): DomainEvent {
    return {
      id: `e-${randomUUID().slice(0, 8)}`, type: EVENT_NAMES.SIGNAL_CREATED, version: 1,
      eventTime: new Date().toISOString(), processingTime: new Date().toISOString(), source: 'test',
      payload: { signalId, tradingAgentId: agentId, symbol: SYM, domain: 'perp', direction: 'LONG', compositeScore: 0.6, confidence: 0.7, configVersion: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
  }

  async function seedSignal(over: { expiresAt?: Date; symbol?: string } = {}): Promise<string> {
    const id = randomUUID();
    created.signals.push(id);
    await db.insert(signal).values({
      id, tradingAgentId: agentId, symbol: over.symbol ?? SYM, domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'ACTIVE',
      createdAt: new Date(), expiresAt: over.expiresAt ?? new Date(Date.now() + 120_000),
      configVersion: 1, fingerprint: `orch-${randomUUID().slice(0, 8)}`,
      evidence: { contributions: [{ agent: 'perp.momentum', agentVersion: 1, weight: 1, contribution: 0.6 }] },
    });
    return id;
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    const a = await createTradingAgent(db, {
      name: `ORCH-${randomUUID().slice(0, 6)}`, domain: 'perp', universe: [SYM], tradingStyle: 'day', config: CFG,
    });
    agentId = a.id; created.agents.push(agentId);

    // The planner's trending tape (see planner/perp.test.ts): last close ≈ 100, support pivot
    // ~98, resistance ~104 → clean LONG TRADE. 60 hourly bars ending one minute ago.
    const end = Date.now() - 60_000;
    const rows = [];
    for (let i = 0; i < 60; i++) {
      const mid = 99.7 + i * 0.005;
      let h = mid + 0.15;
      let l = mid - 0.15;
      if (i === 40) l = 98.0;
      if (i === 50) h = 104.0;
      const openTime = new Date(end - (60 - i) * 3600_000);
      rows.push({
        symbol: SYM, timeframe: '1h', openTime,
        closeTime: new Date(openTime.getTime() + 3600_000 - 1),
        open: String(mid), high: String(h), low: String(l), close: String(mid), volume: '1', turnover: null,
      });
    }
    await db.insert(marketCandle).values(rows).onConflictDoNothing();
  });

  afterAll(async () => {
    if (db) {
      const preds = await db.select({ id: prediction.id }).from(prediction).where(eq(prediction.tradingAgentId, agentId));
      const predIds = preds.map((p) => p.id);
      if (predIds.length) {
        await db.delete(paperPositionFill).where(inArray(paperPositionFill.positionId,
          (await db.select({ id: paperPosition.id }).from(paperPosition).where(inArray(paperPosition.predictionId, predIds))).map((r) => r.id)));
        await db.delete(paperPosition).where(inArray(paperPosition.predictionId, predIds));
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
      await db.delete(marketCandle).where(eq(marketCandle.symbol, SYM));
      await closeDb(db);
    }
  });

  it('judge-disabled: signal.created → prediction + OPEN position + auto-created portfolio', async () => {
    const handler = createEntryOrchestrator({ db, bus, judgeEnabled: false });
    const signalId = await seedSignal();
    await handler(sigEvent(signalId));

    const sig = (await db.select().from(signal).where(eq(signal.id, signalId)))[0]!;
    expect(sig.state).toBe('CONSUMED');

    const pred = (await db.select().from(prediction).where(eq(prediction.signalId, signalId)))[0];
    expect(pred).toBeDefined();
    expect(pred!.direction).toBe('LONG');
    expect(pred!.configVersion).toBe(1);
    created.predictions.push(pred!.id);

    const pos = (await db.select().from(paperPosition).where(eq(paperPosition.predictionId, pred!.id)))[0];
    expect(pos).toBeDefined();
    expect(pos!.state).toBe('OPEN');
    // MARKET fill: entry ≈ lastClose + 5.5bps (LONG pays up).
    expect(Number(pos!.entryPrice)).toBeGreaterThan(99.9);
    created.positions.push(pos!.id);

    const port = (await db.select().from(paperPortfolio).where(eq(paperPortfolio.tradingAgentId, agentId)))[0];
    expect(port).toBeDefined(); // §14 — auto-created on first entry
    expect(Number(port!.startingCash)).toBe(10_000);

    const types = publish.mock.calls.map((c) => (c as unknown as [string, { type: string }])[1].type);
    expect(types).toContain(EVENT_NAMES.PREDICTION_CREATED);
    expect(types).toContain(EVENT_NAMES.PAPER_TRADE_OPENED);
  });

  it('capacity gate (§37): a second signal is refused while one position is OPEN', async () => {
    const handler = createEntryOrchestrator({ db, bus, judgeEnabled: false });
    const signalId = await seedSignal();
    await handler(sigEvent(signalId));

    const pred = (await db.select().from(prediction).where(eq(prediction.signalId, signalId)))[0];
    expect(pred).toBeUndefined(); // refused — maxConcurrentPositions=1 and one OPEN exists
    const sig = (await db.select().from(signal).where(eq(signal.id, signalId)))[0]!;
    expect(sig.state).toBe('ACTIVE'); // stays consumable until TTL
  });

  it('TTL (§36): an expired signal is transitioned EXPIRED, never traded', async () => {
    const handler = createEntryOrchestrator({ db, bus, judgeEnabled: false });
    const signalId = await seedSignal({ expiresAt: new Date(Date.now() - 1_000) });
    await handler(sigEvent(signalId));
    const sig = (await db.select().from(signal).where(eq(signal.id, signalId)))[0]!;
    expect(sig.state).toBe('EXPIRED');
    expect((await db.select().from(prediction).where(eq(prediction.signalId, signalId)))).toHaveLength(0);
  });

  it('NO_TRADE (§19): a symbol without candles records the veto on the signal', async () => {
    // Close the open position first so capacity doesn't mask the planner path.
    await db.update(paperPosition).set({ state: 'CLOSED', closeReason: 'HORIZON_EXPIRY', closedAt: new Date() })
      .where(inArray(paperPosition.id, created.positions));
    const bare = `BARE${randomUUID().slice(0, 4).toUpperCase()}USDT`;
    // Signal for a symbol with no candle history at all → STALE_OR_MISSING_DATA.
    const signalId = randomUUID();
    created.signals.push(signalId);
    await db.insert(signal).values({
      id: signalId, tradingAgentId: agentId, symbol: bare, domain: 'perp', direction: 'LONG',
      compositeScore: '0.6', confidence: '0.7', state: 'ACTIVE',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000),
      configVersion: 1, fingerprint: `orch-${randomUUID().slice(0, 8)}`, evidence: { contributions: [] },
    });
    const handler = createEntryOrchestrator({ db, bus, judgeEnabled: false });
    await handler({ ...sigEvent(signalId), payload: { ...(sigEvent(signalId).payload as object), signalId, symbol: bare } } as DomainEvent);

    const veto = (await db.select().from(signalNoTrade).where(eq(signalNoTrade.signalId, signalId)))[0];
    expect(veto).toBeDefined();
    expect(veto!.reason).toBe('STALE_OR_MISSING_DATA');
    const sig = (await db.select().from(signal).where(eq(signal.id, signalId)))[0]!;
    expect(sig.state).toBe('INVALIDATED');
  });

  it('expireStaleSignals sweeps every past-TTL ACTIVE signal', async () => {
    const a = await seedSignal({ expiresAt: new Date(Date.now() - 5_000) });
    const b = await seedSignal({ expiresAt: new Date(Date.now() - 5_000) });
    const n = await expireStaleSignals(db);
    expect(n).toBeGreaterThanOrEqual(2);
    const rows = await db.select().from(signal).where(inArray(signal.id, [a, b]));
    expect(rows.every((r) => r.state === 'EXPIRED')).toBe(true);
  });
});
