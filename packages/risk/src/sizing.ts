import { FinancialDecimal as Decimal } from '../../core/src/decimal.js';
import type { Instrument } from '../../market-data/src/contracts.js';
export const paperPolicy = {
  version: 'paper-risk-v1',
  profiles: {
    CONSERVATIVE: {
      loss: '.005',
      margin: '.10',
      leverage: 5,
      daily: '.02',
      drawdown: '.05',
    },
    MODERATE: {
      loss: '.01',
      margin: '.15',
      leverage: 10,
      daily: '.03',
      drawdown: '.08',
    },
    AGGRESSIVE: {
      loss: '.015',
      margin: '.20',
      leverage: 15,
      daily: '.05',
      drawdown: '.12',
    },
  },
  accountMargin: '.40',
  accountNotional: '1',
  accountStop: '.02',
  accountDaily: '.03',
  accountDrawdown: '.10',
  // Round-trip fee + adverse slippage budget; fills outside approval are rejected.
  costRate: '.003',
  feeRate: '.0006',
  slippageRate: '.0005',
  latencyMs: 100,
  participation: '.10',
} as const;
export type RiskPolicy = {
  version: string;
  profiles: Record<
    'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE',
    {
      loss: string;
      margin: string;
      leverage: number;
      daily: string;
      drawdown: string;
    }
  >;
  accountMargin: string;
  accountNotional: string;
  accountStop: string;
  accountDaily: string;
  accountDrawdown: string;
  costRate: string;
  feeRate: string;
  slippageRate: string;
  latencyMs: number;
  participation: string;
};
export function riskPolicyFromEnv(): RiskPolicy {
  const policy: RiskPolicy = process.env.PAPER_RISK_POLICY_JSON
    ? JSON.parse(process.env.PAPER_RISK_POLICY_JSON)
    : structuredClone(paperPolicy);
  validatePolicy(policy);
  return policy;
}
export function validatePolicy(p: RiskPolicy) {
  if (!p.version || p.version.length > 100)
    throw Error('Risk policy requires version');
  for (const key of [
    'accountMargin',
    'accountNotional',
    'accountStop',
    'accountDaily',
    'accountDrawdown',
    'participation',
  ] as const) {
    const n = new Decimal(p[key]);
    if (!n.isFinite() || n.lte(0) || n.gt(paperPolicy[key]))
      throw Error(`Policy ${key} must tighten the v1 ceiling`);
  }
  for (const profile of ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'] as const) {
    const v = p.profiles[profile],
      max = paperPolicy.profiles[profile];
    for (const key of ['loss', 'margin', 'daily', 'drawdown'] as const) {
      const n = new Decimal(v[key]);
      if (!n.isFinite() || n.lte(0) || n.gt(max[key]))
        throw Error(`Invalid ${profile} ${key}`);
    }
    if (
      !Number.isInteger(v.leverage) ||
      v.leverage < 1 ||
      v.leverage > max.leverage
    )
      throw Error('Invalid leverage ceiling');
  }
  for (const key of ['costRate', 'feeRate', 'slippageRate'] as const) {
    const n = new Decimal(p[key]);
    if (!n.isFinite() || n.lt(0) || n.gte(1))
      throw Error('Invalid execution costs');
  }
  if (
    new Decimal(p.costRate).lt(
      new Decimal(p.feeRate).plus(p.slippageRate).mul(2),
    )
  )
    throw Error('Cost buffer must cover round-trip fees and slippage');
  if (!Number.isInteger(p.latencyMs) || p.latencyMs < 100)
    throw Error('Latency must be >=100 ms');
}

export const money = (n: import('decimal.js').Decimal.Value) => {
  const value = new Decimal(n);
  if (!value.isFinite()) throw Error('NON_FINITE_FINANCIAL_VALUE');
  return value.toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed();
};
export function sizeOrder(
  input: {
    equity: string;
    entry: string;
    stop: string;
    target: string;
    side: 'LONG' | 'SHORT';
    profile: keyof typeof paperPolicy.profiles;
    instrument: Instrument;
    now: number;
  },
  policy: RiskPolicy = paperPolicy,
) {
  validatePolicy(policy);
  const d = (n: import('decimal.js').Decimal.Value) => new Decimal(n),
    p = policy.profiles[input.profile],
    i = input.instrument;
  for (const name of [
    'tickSize',
    'quantityStep',
    'minQuantity',
    'maxLeverage',
  ] as const)
    if (!d(i[name]).isFinite() || d(i[name]).lte(0))
      throw Error('INVALID_INSTRUMENT_CONSTRAINTS');
  if (!d(i.minNotional).isFinite() || d(i.minNotional).lt(0))
    throw Error('INVALID_INSTRUMENT_CONSTRAINTS');
  const equity = d(input.equity),
    entry = d(input.entry),
    stop = d(input.stop),
    target = d(input.target);
  if (i.verifiedAt > input.now || i.expiresAt <= input.now)
    throw Error('INSTRUMENT_STALE');
  if (
    ![equity, entry, stop, target].every((n) => n.isFinite()) ||
    equity.lte(0) ||
    entry.lte(0) ||
    stop.lte(0) ||
    target.lte(0) ||
    (input.side === 'LONG'
      ? !(stop.lt(entry) && target.gt(entry))
      : !(stop.gt(entry) && target.lt(entry)))
  )
    throw Error('INVALID_RISK_LEVELS');
  if (i.market.marketType === 'SPOT' && input.side === 'SHORT')
    throw Error('SPOT_SHORT_UNSUPPORTED');
  for (const price of [entry, stop, target])
    if (!price.mod(i.tickSize).isZero()) throw Error('PRICE_TICK_NOT_MET');
  const cap = Math.min(
    p.leverage,
    i.market.marketType === 'SPOT' ? 1 : d(i.maxLeverage).floor().toNumber(),
  );
  if (cap < 1) throw Error('LEVERAGE_UNAVAILABLE');
  // Include adverse tick rounding as well as proportional execution costs.
  const executionBound = entry.mul(policy.slippageRate).plus(i.tickSize);
  const maxEntry = entry.plus(executionBound);
  const unitCost = entry.mul(policy.costRate).plus(d(i.tickSize).mul(2));
  const unitLoss = entry.minus(stop).abs().plus(unitCost);
  // Leverage never increases stop-risk-sized quantity. Margin may only reduce it.
  const qty = Decimal.min(
    equity.mul(p.loss).div(unitLoss),
    equity.mul(p.margin).mul(cap).div(maxEntry),
  )
    .div(i.quantityStep)
    .floor()
    .mul(i.quantityStep);
  const notional = qty.mul(maxEntry);
  if (qty.lt(i.minQuantity) || qty.mul(entry).lt(i.minNotional) || qty.lte(0))
    throw Error('MIN_ORDER_NOT_MET');
  const leverage = Math.max(
    1,
    notional.div(equity.mul(p.margin)).ceil().toNumber(),
  );
  const margin = notional.div(leverage),
    buffer = qty.mul(unitCost);
  if (margin.plus(buffer).gt(equity)) throw Error('INSUFFICIENT_BOT_CAPITAL');
  return {
    executionModel: 'public-trade-participation-v1' as const,
    version: policy.version,
    policy,
    quantity: money(qty),
    leverage,
    margin: money(margin),
    buffer: money(buffer),
    notional: money(notional),
    stopExposure: money(qty.mul(unitLoss)),
    executionBound: money(executionBound),
    entry: input.entry,
    stop: input.stop,
    side: input.side,
    instrument: i,
    approvedAt: input.now,
  };
}
export type Approval = ReturnType<typeof sizeOrder>;
