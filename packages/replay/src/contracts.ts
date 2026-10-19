import { FinancialDecimal as D } from '../../core/src/decimal.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { marketSchema, type Clock } from '../../core/src/index.js';
import {
  candleSchema,
  decimalString,
  epoch,
} from '../../market-data/src/contracts.js';
import {
  paperPolicy,
  validatePolicy,
  type RiskPolicy,
} from '../../risk/src/sizing.js';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const digest = (v: unknown) =>
  createHash('sha256').update(canonical(v)).digest('hex');
export class VirtualClock implements Clock {
  constructor(
    public time: number,
    private base?: Clock,
  ) {}
  now() {
    return Number.isFinite(this.time) ? new Date(this.time) : this.base!.now();
  }
}
const price = z
  .object({
    kind: z.literal('PRICE'),
    marketKey: z.string(),
    tradeId: z.string().min(1).max(150),
    eventTime: epoch,
    sequence: epoch.optional(),
    observedAt: epoch,
    price: decimalString,
    quantity: decimalString,
    reference: z.literal('LAST'),
    side: z.enum(['BUY', 'SELL']),
    late: z.literal(false).default(false),
  })
  .strict();
export const replayEventSchema = z.discriminatedUnion('kind', [
  price,
  z.object({ kind: z.literal('CANDLE'), candle: candleSchema }).strict(),
  z.object({ kind: z.literal('TIMER'), observedAt: epoch }).strict(),
  z
    .object({
      kind: z.literal('FUNDING'),
      marketKey: z.string(),
      period: epoch,
      observedAt: epoch,
      rate: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/),
      price: decimalString,
    })
    .strict(),
  z
    .object({
      kind: z.literal('GAP_START'),
      marketKey: z.string(),
      id: z.string().min(1),
      observedAt: epoch,
    })
    .strict(),
  z
    .object({
      kind: z.literal('GAP_END'),
      marketKey: z.string(),
      id: z.string().min(1),
      observedAt: epoch,
      complete: z.boolean(),
      evidenceHash: z.string().length(64).optional(),
    })
    .strict(),
]);
export type ReplayEvent = z.infer<typeof replayEventSchema>;
export const eventTime = (e: ReplayEvent) =>
  e.kind === 'CANDLE' ? e.candle.observedAt : e.observedAt;
const spec = z
  .object({
    market: marketSchema,
    marketKey: z.string(),
    symbol: z.string(),
    specVersion: z.string().min(1),
    verifiedAt: epoch,
    expiresAt: epoch,
    tickSize: decimalString,
    quantityStep: decimalString,
    minQuantity: decimalString,
    minNotional: decimalString,
    maxLeverage: decimalString,
    raw: z.record(z.string(), z.unknown()),
  })
  .strict();
const bot = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
    market: marketSchema,
    strategy: z.enum(['trend-following', 'mean-reversion']),
    allocationTargetPercent: decimalString,
    riskProfile: z.enum(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']),
    management: z
      .object({
        breakEven: z
          .object({
            enabled: z.boolean(),
            triggerR: z.number().positive(),
            offsetR: z.number().nonnegative(),
          })
          .optional(),
        trailingStop: z
          .object({
            enabled: z.boolean(),
            type: z.literal('ATR'),
            atrMultiplier: z.number().positive(),
          })
          .optional(),
        earlyExit: z
          .object({ enabled: z.boolean(), evaluateOnCandleClose: z.boolean() })
          .optional(),
        timeExit: z
          .object({
            enabled: z.boolean(),
            maxHoldingCandles: z.number().int().positive(),
          })
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const replayInputSchema = z
  .object({
    version: z.literal('replay-v1'),
    dataset: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        instrumentHistory: z.enum(['HISTORICAL', 'CURRENT_ASSUMPTION']),
        fundingCoverage: z.enum(['COMPLETE', 'OMITTED']),
        tradeCoverage: z
          .enum(['COMPLETE_ORDERED', 'PARTIAL', 'NONE'])
          .default('PARTIAL'),
        candles: z.array(candleSchema).max(100000),
        instruments: z.array(spec).min(1).max(50),
        events: z.array(replayEventSchema).max(100000),
      })
      .strict(),
    seed: z.number().int().min(0).max(4294967295),
    start: epoch,
    end: epoch,
    equityBaseline: decimalString,
    bots: z.array(bot).min(1).max(20),
    policy: z.custom<RiskPolicy>().default(() => structuredClone(paperPolicy)),
    liquidity: z
      .object({
        model: z.enum(['FIXED_PARTICIPATION', 'SEEDED_PARTICIPATION']),
        minimumFactor: z.number().min(0).max(1),
      })
      .strict()
      .default({ model: 'FIXED_PARTICIPATION', minimumFactor: 1 }),
  })
  .strict();
export type ReplayInput = z.infer<typeof replayInputSchema>;
export function parseInput(input: unknown): ReplayInput {
  const p = replayInputSchema.parse(input);
  validatePolicy(p.policy);
  if (new D(p.equityBaseline).lte(0))
    throw Error('Positive replay baseline required');
  if (
    p.bots
      .reduce((sum, b) => sum.plus(b.allocationTargetPercent), new D(0))
      .gt(80)
  )
    throw Error('Replay allocation target exceeds 80 percent');
  if (new Set(p.bots.map((b) => b.market.baseAsset)).size !== p.bots.length)
    throw Error('Exclusive coin ownership applies within a replay portfolio');
  if (p.start >= p.end) throw Error('Invalid measured window');
  const keys = new Set(p.bots.map((b) => b.key));
  if (keys.size !== p.bots.length) throw Error('Duplicate bot key');
  let last = -1;
  const ids = new Set<string>();
  const sourceTimes = new Map<string, number>();
  const sequences = new Map<string, number | undefined>();
  for (const e of p.dataset.events) {
    const t = eventTime(e);
    if (t < last) throw Error('Events must be in observation/sequence order');
    last = t;
    if (e.kind === 'PRICE') {
      if (e.eventTime > e.observedAt) throw Error('Future observation');
      const id = e.marketKey + ':' + e.tradeId;
      if (ids.has(id)) throw Error('Duplicate dataset trade ID');
      ids.add(id);

      if (e.eventTime < (sourceTimes.get(e.marketKey) ?? 0))
        throw Error('Source trades must be ordered');
      if (
        e.eventTime === sourceTimes.get(e.marketKey) &&
        (e.sequence === undefined ||
          sequences.get(e.marketKey) === undefined ||
          e.sequence <= sequences.get(e.marketKey)!)
      )
        throw Error('Equal-time source trades require exchange sequence');
      sourceTimes.set(e.marketKey, e.eventTime);
      sequences.set(e.marketKey, e.sequence);
    }
    if (e.kind === 'FUNDING' && e.period > e.observedAt)
      throw Error('Future funding observation');
  }
  const candleIds = new Set<string>();
  for (const c of p.dataset.candles) {
    const key = `${c.marketKey}:${c.timeframe}:${c.openTime}`;
    if (candleIds.has(key)) throw Error('Duplicate seed candle');
    candleIds.add(key);
  }
  return JSON.parse(JSON.stringify(p)) as ReplayInput;
}
export function seededFraction(seed: number, key: string): number {
  return parseInt(digest([seed, key]).slice(0, 8), 16) / 4294967296;
}
