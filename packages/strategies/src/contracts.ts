import type {
  Candle,
  Timeframe,
  Market,
  IndicatorRequest,
} from '../../market-data/src/contracts.js';
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
export type StrategyRequirements =
  | {
      trigger: 'CANDLE_CLOSE';
      primaryTimeframe: Timeframe;
      confirmationTimeframes: Timeframe[];
      indicators: (IndicatorRequest & { key: string })[];
      minClosedCandlesByTimeframe: Partial<Record<Timeframe, number>>;
    }
  | {
      trigger: 'MARKET_EVENT';
      primaryTimeframe?: never;
      confirmationTimeframes: Timeframe[];
      indicators: (IndicatorRequest & { key: string })[];
      minClosedCandlesByTimeframe: Partial<Record<Timeframe, number>>;
    };
export type StrategyTrigger =
  | {
      type: 'CANDLE_CLOSE';
      timeframe: Timeframe;
      eventTime: number;
      observedAt: number;
    }
  | {
      type: 'MARKET_EVENT';
      eventId: string;
      eventTime: number;
      observedAt: number;
      price: string;
      quantity: string;
      reference: 'LAST';
    };
export type ReasonCode =
  | 'NO_SETUP'
  | 'WEAK_TREND'
  | 'CONFLICTING_SIGNALS'
  | 'MARKET_REGIME_UNSUITABLE'
  | 'VOLATILITY_UNSUITABLE'
  | 'INSUFFICIENT_DATA'
  | 'DATA_GAP'
  | 'STALE_DATA'
  | 'INVALID_DATA'
  | 'MARKET_DATA_UNHEALTHY'
  | 'TREND_CONFIRMED'
  | 'MEAN_REVERSION_EXTREME';
export type EntryDecision =
  | { action: 'NO_TRADE'; reason: ReasonCode }
  | {
      action: 'PROPOSE_ENTRY';
      side: 'LONG' | 'SHORT';
      orderType: 'MARKET' | 'LIMIT';
      entryPrice: string;
      stopLoss: string;
      takeProfit: string;
      expiresAt: number;
      reason: ReasonCode;
    };
export type PendingEntry = {
  id: string;
  marketKey: string;
  side: 'LONG' | 'SHORT';
  createdAt: number;
  expiresAt: number;
  entryPrice: string;
  stopLoss: string;
};
export type PositionSnapshot = {
  id: string;
  marketKey: string;
  side: 'LONG' | 'SHORT';
  openedAt: number;
  quantity: string;
  entryPrice: string;
  initialStop: string;
  confirmedStop: string;
};
export type PendingEntryDecision =
  | { action: 'KEEP_PENDING'; reason: string }
  | { action: 'CANCEL'; reason: string };
export type PositionAssessment =
  | { action: 'HOLD'; reason: string }
  | { action: 'CLOSE_EARLY'; reason: string }
  | { action: 'SUGGEST_STOP'; newStopPrice: string; reason: string };
export type ManagementPolicy = {
  breakEven: { enabled: boolean; triggerR: number; offsetR: number };
  trailingStop: { enabled: boolean; type: 'ATR'; atrMultiplier: number };
  earlyExit: { enabled: boolean; evaluateOnCandleClose: boolean };
  timeExit: { enabled: boolean; maxHoldingCandles: number };
  pendingExpiryCandles: number;
};
export type IndicatorSnapshot = {
  name: IndicatorRequest['name'];
  timeframe: Timeframe;
  inputsThrough: number;
  asOf: number;
  availableAsOf: number;
  latest: Record<string, number>;
  previous: Record<string, number>;
  engine: string;
};
export type StrategyContext = DeepReadonly<{
  market: Market;
  marketKey: string;
  trigger: StrategyTrigger;
  marketCutoff: number;
  decisionTime: number;
  dataQuality: { ready: boolean; reason: ReasonCode | null };
  candles: Partial<Record<Timeframe, Candle[]>>;
  indicators: Record<string, IndicatorSnapshot>;
}>;
export interface StrategyDefinition {
  readonly id: string;
  readonly version: string;
  readonly preset: string;
  readonly parameters: Readonly<Record<string, number>>;
  readonly requirements: DeepReadonly<StrategyRequirements>;
  readonly managementPolicy: DeepReadonly<ManagementPolicy>;
  evaluateEntry(context: StrategyContext): EntryDecision;
  evaluatePendingEntry(
    context: StrategyContext,
    pending: DeepReadonly<PendingEntry>,
  ): PendingEntryDecision;
  evaluatePosition(
    context: StrategyContext,
    position: DeepReadonly<PositionSnapshot>,
  ): PositionAssessment;
}
export type EvaluationInput = {
  botId: string;
  accountId: string;
  configVersion: number;
  strategyVersionId: string;
  codeHash: string;
  market: Market;
  trigger: StrategyTrigger;
  tradingState:
    'IDLE' | 'PENDING_ENTRY' | 'IN_TRADE' | 'CLOSING' | 'UNRESOLVED';
  dataHealthy: boolean;
  candles: Partial<Record<Timeframe, Candle[]>>;
};
export type EvaluationSnapshot = {
  schemaVersion: 1;
  strategy: {
    id: string;
    version: string;
    preset: string;
    codeHash: string;
    parameters: Readonly<Record<string, number>>;
    requirements: DeepReadonly<StrategyRequirements>;
    managementPolicy: DeepReadonly<ManagementPolicy>;
  };
  configVersion: number;
  context: StrategyContext;
  decision: DeepReadonly<EntryDecision>;
};
export type EvaluationRecord = {
  id: string;
  botId: string;
  accountId: string;
  strategyVersionId: string;
  configVersion: number;
  triggerType: StrategyTrigger['type'];
  triggerEventKey: string;
  decision: 'LONG' | 'SHORT' | 'NO_TRADE';
  reasonCode: ReasonCode;
  eventTime: number;
  decisionTime: number;
  snapshot: DeepReadonly<EvaluationSnapshot>;
  correlationId: string;
};
export interface EvaluationRepository {
  find(
    botId: string,
    strategyVersionId: string,
    trigger: StrategyTrigger['type'],
    key: string,
  ): Promise<EvaluationRecord | undefined>;
  insert(record: Omit<EvaluationRecord, 'id'>): Promise<EvaluationRecord>;
}
