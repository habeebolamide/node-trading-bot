import { z } from 'zod';
import { marketKey, marketSchema } from '../../core/src/index.js';
import {
  candleSchema,
  durations,
  decimalString,
  epoch,
  timeframeSchema,
  type Candle,
  type Timeframe,
} from '../../market-data/src/contracts.js';
import {
  calculateIndicator,
  requiredHistory,
} from '../../market-data/src/indicators.js';
import type {
  StrategyDefinition,
  StrategyTrigger,
  EvaluationInput,
  StrategyContext,
  IndicatorSnapshot,
  ReasonCode,
} from './contracts.js';
import { freeze } from './helpers.js';
const triggerSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('CANDLE_CLOSE'),
        timeframe: timeframeSchema,
        eventTime: epoch,
        observedAt: epoch,
      })
      .strict(),
    z
      .object({
        type: z.literal('MARKET_EVENT'),
        eventId: z.string().min(1).max(200),
        eventTime: epoch,
        observedAt: epoch,
        price: decimalString.refine(
          (v) => Number(v) > 0,
          'Positive event price required',
        ),
        quantity: decimalString.refine(
          (v) => Number(v) > 0,
          'Positive event quantity required',
        ),
        reference: z.literal('LAST'),
      })
      .strict(),
  ])
  .refine(
    (e) => e.observedAt >= e.eventTime,
    'Observation cannot predate source event',
  );
export function triggerKey(
  definition: StrategyDefinition,
  market: EvaluationInput['market'],
  input: StrategyTrigger,
) {
  const trigger = triggerSchema.parse(input),
    key = marketKey(marketSchema.parse(market));
  if (trigger.type !== definition.requirements.trigger)
    throw Error('INELIGIBLE_TRIGGER: strategy trigger mismatch');
  if (
    trigger.type === 'CANDLE_CLOSE' &&
    (trigger.timeframe !== definition.requirements.primaryTimeframe ||
      trigger.eventTime % durations[trigger.timeframe] !== 0)
  )
    throw Error('INELIGIBLE_TRIGGER: primary candle close required');
  return trigger.type === 'CANDLE_CLOSE'
    ? `${key}:${trigger.timeframe}:${trigger.eventTime}`
    : `${key}:${trigger.eventId}`;
}
export function buildContext(
  definition: StrategyDefinition,
  input: Pick<
    EvaluationInput,
    'market' | 'trigger' | 'candles' | 'dataHealthy'
  >,
): StrategyContext {
  triggerKey(definition, input.market, input.trigger);
  const market = marketSchema.parse(input.market),
    key = marketKey(market),
    trigger = triggerSchema.parse(input.trigger),
    cutoff = trigger.eventTime,
    decisionTime = trigger.observedAt;
  const candles: Partial<Record<Timeframe, Candle[]>> = {},
    indicators: Record<string, IndicatorSnapshot> = {};
  let reason: ReasonCode | null = input.dataHealthy
    ? null
    : 'MARKET_DATA_UNHEALTHY';
  if (
    trigger.type === 'CANDLE_CLOSE' &&
    decisionTime >= cutoff + durations[trigger.timeframe]
  )
    reason ??= 'STALE_DATA';
  const needs = definition.requirements;
  const counts =
    Object.keys(needs.minClosedCandlesByTimeframe).length ||
    needs.indicators.length
      ? requiredHistory({
          minClosedCandlesByTimeframe: { ...needs.minClosedCandlesByTimeframe },
          indicators: needs.indicators.map((i) => ({
            ...i,
            parameters: { ...i.parameters },
          })),
        })
      : {};
  try {
    if (
      needs.trigger === 'CANDLE_CLOSE' &&
      (!counts[needs.primaryTimeframe] ||
        needs.confirmationTimeframes.some((f) => !counts[f]))
    )
      throw Error(
        'INVALID_DATA: declared timeframe lacks a history requirement',
      );
    for (const [frame, count] of Object.entries(counts) as [
      Timeframe,
      number,
    ][]) {
      const selected = (input.candles[frame] ?? [])
        .filter(
          (c) =>
            c.isClosed === true &&
            c.closeTime <= cutoff &&
            c.availableAt <= decisionTime &&
            c.observedAt <= decisionTime,
        )
        .map((c) => candleSchema.parse(c))
        .sort((a, b) => a.openTime - b.openTime);
      if (selected.some((c) => c.marketKey !== key || c.timeframe !== frame))
        throw Error('INVALID_DATA: mixed market or timeframe');
      if (new Set(selected.map((c) => c.openTime)).size !== selected.length)
        throw Error('INVALID_DATA: duplicate candle identity');
      candles[frame] = selected.slice(-count);
      const used = candles[frame]!;
      if (used.length < count) {
        reason ??= 'INSUFFICIENT_DATA';
        continue;
      }
      if (
        used.at(-1)!.closeTime !==
        Math.floor(cutoff / durations[frame]) * durations[frame]
      ) {
        reason ??= 'STALE_DATA';
        continue;
      }
      if (used.some((c, i) => i > 0 && c.openTime !== used[i - 1]!.closeTime)) {
        reason ??= 'DATA_GAP';
        continue;
      }
    }
    if (!reason) {
      const keys = new Set<string>();
      for (const request of needs.indicators) {
        if (keys.has(request.key))
          throw Error('INVALID_DATA: duplicate indicator key');
        keys.add(request.key);
        const result = calculateIndicator(
          candles[request.timeframe] ?? [],
          { ...request, parameters: { ...request.parameters } },
          cutoff,
          decisionTime,
        );
        indicators[request.key] = {
          name: request.name,
          timeframe: request.timeframe,
          inputsThrough: result.inputsThrough,
          asOf: cutoff,
          availableAsOf: decisionTime,
          latest: result.latest,
          previous: Object.fromEntries(
            Object.entries(result.outputs)
              .filter(([, series]) => series.length >= 2)
              .map(([key, series]) => [key, series.at(-2)!]),
          ),
          engine: result.engine,
        };
      }
    }
  } catch {
    reason ??= 'INVALID_DATA';
  }
  return freeze({
    market,
    marketKey: key,
    trigger,
    marketCutoff: cutoff,
    decisionTime,
    dataQuality: { ready: reason === null, reason },
    candles,
    indicators,
  });
}
