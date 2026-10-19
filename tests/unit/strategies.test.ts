import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import golden from '../fixtures/strategy-golden.json' with { type: 'json' };
import {
  strategyInput,
  history,
  closeTime,
  type Scenario,
} from '../fixtures/strategies.js';
import {
  trendFollowing,
  meanReversion,
} from '../../packages/strategies/src/research.js';
import {
  preview,
  StrategyEngine,
} from '../../packages/strategies/src/engine.js';
import { buildContext } from '../../packages/strategies/src/context.js';
import type {
  EvaluationRecord,
  EvaluationRepository,
  StrategyDefinition,
} from '../../packages/strategies/src/contracts.js';
import { fixtureCandle } from '../fixtures/market.js';
class MemoryEvaluations implements EvaluationRepository {
  rows: EvaluationRecord[] = [];
  async find(
    botId: string,
    strategyVersionId: string,
    trigger: EvaluationRecord['triggerType'],
    key: string,
  ) {
    return this.rows.find(
      (r) =>
        r.botId === botId &&
        r.strategyVersionId === strategyVersionId &&
        r.triggerType === trigger &&
        r.triggerEventKey === key,
    );
  }
  async insert(r: Omit<EvaluationRecord, 'id'>) {
    const previous = this.rows.find(
      (x) =>
        x.botId === r.botId &&
        x.strategyVersionId === r.strategyVersionId &&
        x.triggerType === r.triggerType &&
        x.triggerEventKey === r.triggerEventKey,
    );
    if (previous) return previous;
    const row = { ...r, id: '00000000-0000-4000-8000-000000000009' };
    this.rows.push(row);
    return row;
  }
}
afterEach(() => vi.useRealTimers());
describe('research golden histories', () => {
  it.each(Object.entries(golden.scenarios))(
    '%s produces its reviewed deterministic decision',
    (name, expected) => {
      const input = strategyInput(name as Scenario),
        definition = name.startsWith('trend') ? trendFollowing : meanReversion;
      const a = preview(definition, input),
        b = preview(definition, structuredClone(input));
      expect(a).toEqual(b);
      expect(a.snapshot.decision).toMatchObject(expected);
      expect(a.snapshot.context.dataQuality.ready).toBe(true);
    },
  );
  it('has no ambient-clock dependency and returns deeply immutable snapshots without mutating inputs', () => {
    const input = strategyInput('trend-long'),
      before = structuredClone(input);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2000-01-01'));
    const a = preview(trendFollowing, input);
    vi.setSystemTime(new Date('2100-01-01'));
    expect(preview(trendFollowing, input)).toEqual(a);
    expect(input).toEqual(before);
    expect(() => {
      (
        a.snapshot.context.indicators.fast!.latest as Record<string, number>
      ).outReal = 0;
    }).toThrow();
    expect(() => {
      (trendFollowing.parameters as Record<string, number>).adxEntry = 0;
    }).toThrow();
  });
});
describe('timeframe and availability boundaries', () => {
  it('uses only the last closed hourly confirmation and is unchanged by future or unfinished bars', () => {
    const input = strategyInput('trend-long'),
      baseline = preview(trendFollowing, input);
    const hour = Date.UTC(2026, 9, 19, 12);
    expect(baseline.snapshot.context.candles['1h']!.at(-1)!.closeTime).toBe(
      hour,
    );
    input.candles['1h']!.push(
      fixtureCandle(
        hour,
        '1h',
        baseline.snapshot.context.marketKey,
        hour + 3600000,
      ),
    );
    input.candles['15m']!.push({
      ...fixtureCandle(
        closeTime,
        '15m',
        baseline.snapshot.context.marketKey,
        closeTime + 900000,
      ),
      isClosed: false,
    } as never);
    expect(preview(trendFollowing, input)).toEqual(baseline);
  });
  it('permits delayed arrival but never data received after the injected decision time', () => {
    const input = strategyInput('trend-long');
    expect(preview(trendFollowing, input).snapshot.decision.action).toBe(
      'PROPOSE_ENTRY',
    );
    input.candles['15m']!.at(-1)!.availableAt = closeTime + 3000;
    input.candles['15m']!.at(-1)!.observedAt = closeTime + 3000;
    expect(preview(trendFollowing, input).snapshot.decision).toEqual({
      action: 'NO_TRADE',
      reason: 'INSUFFICIENT_DATA',
    });
  });
  it('does not turn a missed old candle into a fresh entry', () => {
    const input = strategyInput('trend-long');
    input.trigger.observedAt = closeTime + 900000;
    expect(preview(trendFollowing, input).snapshot.decision).toEqual({
      action: 'NO_TRADE',
      reason: 'STALE_DATA',
    });
  });
  it('rejects a nonprimary/misaligned trigger before evaluating', () => {
    const input = strategyInput('trend-long');
    expect(() =>
      preview(trendFollowing, {
        ...input,
        trigger: { ...input.trigger, type: 'CANDLE_CLOSE', timeframe: '5m' },
      }),
    ).toThrow(/INELIGIBLE/);
    expect(() =>
      preview(trendFollowing, {
        ...input,
        trigger: {
          type: 'CANDLE_CLOSE',
          timeframe: '15m',
          eventTime: closeTime + 1,
          observedAt: closeTime + 2000,
        },
      }),
    ).toThrow(/INELIGIBLE/);
  });
  it('records explicit reasons for gaps, mixed markets, stale input and unhealthy feeds', () => {
    const original = strategyInput('trend-long');
    const gap = structuredClone(original);
    gap.candles['15m'] = history('15m', 'UP', undefined, 501);
    gap.candles['15m']!.splice(250, 1);
    expect(preview(trendFollowing, gap).snapshot.decision).toEqual({
      action: 'NO_TRADE',
      reason: 'DATA_GAP',
    });
    const mixed = structuredClone(original);
    mixed.candles['1h']![0]!.marketKey = 'bybit:SPOT:ETH/USDT';
    expect(preview(trendFollowing, mixed).snapshot.decision).toEqual({
      action: 'NO_TRADE',
      reason: 'INVALID_DATA',
    });
    expect(
      preview(trendFollowing, { ...original, dataHealthy: false }).snapshot
        .decision,
    ).toEqual({ action: 'NO_TRADE', reason: 'MARKET_DATA_UNHEALTHY' });
    const stale = structuredClone(original);
    stale.candles['15m'] = history('15m', 'UP', undefined, 501).slice(0, -1);
    expect(preview(trendFollowing, stale).snapshot.decision).toEqual({
      action: 'NO_TRADE',
      reason: 'STALE_DATA',
    });
  });
});
describe('entry idempotency and strategy-owned management', () => {
  it('keeps a single evaluation for replayed candle closes and creates no other domain effects', async () => {
    const repo = new MemoryEvaluations(),
      engine = new StrategyEngine(repo),
      input = strategyInput('trend-flat');
    const [a, b] = await Promise.all([
      engine.evaluate(trendFollowing, input, input.botId),
      engine.evaluate(trendFollowing, input, input.botId),
    ]);
    expect(a.id).toBe(b.id);
    expect(repo.rows).toHaveLength(1);
    expect(a.decision).toBe('NO_TRADE');
  });
  it.each(['PENDING_ENTRY', 'IN_TRADE', 'CLOSING', 'UNRESOLVED'] as const)(
    'blocks entry evaluation in %s',
    async (tradingState) => {
      const repo = new MemoryEvaluations(),
        engine = new StrategyEngine(repo),
        input = { ...strategyInput('trend-long'), tradingState };
      await expect(
        engine.evaluate(trendFollowing, input, input.botId),
      ).rejects.toThrow(/ENTRY_BLOCKED/);
      expect(repo.rows).toHaveLength(0);
    },
  );
  it('supports expiry, thesis invalidation, timed exits and stops that only tighten', () => {
    const input = strategyInput('trend-long'),
      ctx = buildContext(trendFollowing, input),
      pending = {
        id: 'p',
        marketKey: ctx.marketKey,
        side: 'LONG' as const,
        createdAt: closeTime - 1000,
        expiresAt: closeTime + 10000,
        entryPrice: '199.8',
        stopLoss: '198.6',
      };
    expect(trendFollowing.evaluatePendingEntry(ctx, pending).action).toBe(
      'KEEP_PENDING',
    );
    expect(
      trendFollowing.evaluatePendingEntry(ctx, {
        ...pending,
        expiresAt: closeTime,
      }).reason,
    ).toBe('ENTRY_EXPIRED');
    const invalid = buildContext(trendFollowing, strategyInput('trend-short'));
    expect(trendFollowing.evaluatePendingEntry(invalid, pending).action).toBe(
      'CANCEL',
    );
    const position = {
      id: 'x',
      marketKey: ctx.marketKey,
      side: 'LONG' as const,
      openedAt: closeTime - 900000,
      quantity: '1',
      entryPrice: '180',
      initialStop: '178',
      confirmedStop: '190',
    };
    expect(trendFollowing.evaluatePosition(ctx, position)).toMatchObject({
      action: 'SUGGEST_STOP',
      newStopPrice: '198.6',
    });
    expect(
      trendFollowing.evaluatePosition(ctx, {
        ...position,
        confirmedStop: '199',
      }).action,
    ).toBe('HOLD');
    expect(
      trendFollowing.evaluatePosition(ctx, {
        ...position,
        openedAt: closeTime - 32 * 900000,
      }),
    ).toEqual({ action: 'CLOSE_EARLY', reason: 'MAX_HOLDING_TIME' });
    expect(trendFollowing.evaluatePosition(invalid, position).action).toBe(
      'CLOSE_EARLY',
    );
  });
  it('supports an event-driven contract without adding arbitrage execution', () => {
    const definition: StrategyDefinition = {
      ...meanReversion,
      id: 'event-contract-fixture',
      requirements: {
        trigger: 'MARKET_EVENT',
        confirmationTimeframes: [],
        indicators: [],
        minClosedCandlesByTimeframe: {},
      },
      evaluateEntry: (ctx) => ({
        action: 'NO_TRADE',
        reason:
          ctx.trigger.type === 'MARKET_EVENT' ? 'NO_SETUP' : 'INVALID_DATA',
      }),
    };
    const input = {
      ...strategyInput('mean-flat'),
      candles: {},
      trigger: {
        type: 'MARKET_EVENT' as const,
        eventId: 'trade-id',
        eventTime: closeTime,
        observedAt: closeTime + 1,
        price: '100',
        quantity: '1',
        reference: 'LAST' as const,
      },
    };
    expect(preview(definition, input).snapshot.decision).toEqual({
      action: 'NO_TRADE',
      reason: 'NO_SETUP',
    });
  });
});
it('keeps pure strategy implementations free of network, database, execution and ambient-clock capabilities', () => {
  const allowed = new Set(['./contracts.js', './helpers.js', 'decimal.js']);
  for (const file of ['research.ts', 'helpers.ts', 'contracts.ts']) {
    const text = readFileSync(
        new URL(`../../packages/strategies/src/${file}`, import.meta.url),
        'utf8',
      ),
      ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
        expect(
          allowed.has((node.moduleSpecifier as ts.StringLiteral).text),
        ).toBe(true);
      if (ts.isIdentifier(node))
        expect(
          [
            'fetch',
            'WebSocket',
            'XMLHttpRequest',
            'process',
            'globalThis',
            'require',
            'eval',
            'Function',
            'Date',
            'setTimeout',
            'setInterval',
          ].includes(node.text),
        ).toBe(false);
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Math'
      )
        expect(node.name.text).not.toBe('random');
      if (node.kind === ts.SyntaxKind.ImportKeyword)
        throw Error('Dynamic imports forbidden in pure strategies');
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});

it('keeps short protective stops from widening', () => {
  const context = buildContext(trendFollowing, strategyInput('trend-short'));
  const position = {
    id: 's',
    marketKey: context.marketKey,
    side: 'SHORT' as const,
    openedAt: closeTime - 900000,
    quantity: '1',
    entryPrice: '120',
    initialStop: '122',
    confirmedStop: '110',
  };
  expect(trendFollowing.evaluatePosition(context, position)).toMatchObject({
    action: 'SUGGEST_STOP',
    newStopPrice: '101.4',
  });
  expect(
    trendFollowing.evaluatePosition(context, {
      ...position,
      confirmedStop: '101',
    }),
  ).toEqual({ action: 'HOLD', reason: 'THESIS_VALID' });
});
it('reassesses mean-reversion pending/open positions using versioned invalidation and time limits', () => {
  const ctx = buildContext(meanReversion, strategyInput('mean-long'));
  const pending = {
    id: 'p',
    marketKey: ctx.marketKey,
    side: 'LONG' as const,
    createdAt: closeTime - 1000,
    expiresAt: closeTime + 10000,
    entryPrice: '88',
    stopLoss: '84',
  };
  expect(meanReversion.evaluatePendingEntry(ctx, pending).action).toBe(
    'KEEP_PENDING',
  );
  const trending = buildContext(meanReversion, strategyInput('mean-trend'));
  expect(meanReversion.evaluatePendingEntry(trending, pending).action).toBe(
    'CANCEL',
  );
  const position = {
    id: 'p',
    marketKey: ctx.marketKey,
    side: 'LONG' as const,
    openedAt: closeTime - 300000,
    quantity: '1',
    entryPrice: '88',
    initialStop: '84',
    confirmedStop: '84',
  };
  expect(meanReversion.evaluatePosition(ctx, position).action).toBe('HOLD');
  expect(meanReversion.evaluatePosition(trending, position)).toEqual({
    action: 'CLOSE_EARLY',
    reason: 'TREND_REGIME_INVALIDATION',
  });
  expect(
    meanReversion.evaluatePosition(
      buildContext(meanReversion, strategyInput('mean-flat')),
      position,
    ),
  ).toEqual({ action: 'CLOSE_EARLY', reason: 'MEAN_REVERSION_COMPLETED' });
  expect(
    meanReversion.evaluatePosition(ctx, {
      ...position,
      openedAt: closeTime - 12 * 300000,
    }),
  ).toEqual({ action: 'CLOSE_EARLY', reason: 'MAX_HOLDING_TIME' });
});
