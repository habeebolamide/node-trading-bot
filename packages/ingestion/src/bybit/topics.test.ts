import { describe, it, expect } from 'vitest';
import { marketSymbol, type Timeframe } from '@tip/domain';
import {
  toBybitInterval,
  fromBybitInterval,
  timeframeMs,
  klineTopic,
  tickerTopic,
  liquidationTopic,
  parseKlineTopic,
  topicKind,
} from './topics.js';

const SYM = marketSymbol('ETHUSDT');

describe('interval mapping', () => {
  it('round-trips every timeframe', () => {
    const tfs: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
    for (const tf of tfs) expect(fromBybitInterval(toBybitInterval(tf))).toBe(tf);
  });
  it('maps the known tokens', () => {
    expect(toBybitInterval('1h')).toBe('60');
    expect(toBybitInterval('1d')).toBe('D');
    expect(fromBybitInterval('240')).toBe('4h');
  });
  it('throws on an unknown interval', () => {
    expect(() => fromBybitInterval('7')).toThrow();
  });
  it('timeframeMs is correct', () => {
    expect(timeframeMs('1m')).toBe(60_000);
    expect(timeframeMs('4h')).toBe(14_400_000);
  });
});

describe('topic builders', () => {
  it('build and parse kline topics', () => {
    const t = klineTopic('15m', SYM);
    expect(t).toBe('kline.15.ETHUSDT');
    expect(parseKlineTopic(t)).toEqual({ timeframe: '15m', symbol: 'ETHUSDT' });
  });
  it('ticker/liquidation topics + kind', () => {
    expect(tickerTopic(SYM)).toBe('tickers.ETHUSDT');
    expect(liquidationTopic(SYM)).toBe('liquidation.ETHUSDT');
    expect(topicKind('kline.15.ETHUSDT')).toBe('kline');
    expect(topicKind('tickers.ETHUSDT')).toBe('tickers');
  });
});
