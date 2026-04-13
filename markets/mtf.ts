// src/market/mtf.ts

import { getCandleBuffer }     from './websocket';
import { calculateIndicators } from './indicators';
import { detectRegime }        from './regime';
import { CandleInterval, MultiTimeframeData, TimeframeSnapshot } from '../types/market.types';
;

export function buildMtfData(pair: string): MultiTimeframeData | null {
  const build = (tf: CandleInterval): TimeframeSnapshot | null => {
    const candles = getCandleBuffer(pair, tf);
    if (candles.length < 50) return null;

    const indicators = calculateIndicators(candles);
    const regime     = detectRegime(candles);

    return {
      interval:   tf,
      candles,
      indicators: indicators ?? {} as any,
      regime:     regime     ?? {} as any,
    };
  };

  const tf4h  = build('240');
  const tf1h  = build('60');
  const tf15m = build('15');
  const tf5m  = build('5');

  // 1h and 4h are mandatory — others can be empty early on
  if (!tf1h || !tf4h) return null;

  return {
    pair,
    tf4h,
    tf1h,
    tf15m: tf15m ?? tf1h,  // fallback to 1h if 15m buffer not full yet
    tf5m:  tf5m  ?? tf1h,  // fallback to 1h if 5m buffer not full yet
  };
}