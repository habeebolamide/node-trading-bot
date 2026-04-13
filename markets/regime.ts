import { Candle, Indicators, MarketRegime, RegimeAnalysis } from '../types/market.types';
import { calculateIndicators, calculateEMASlope } from './indicators';

// ─────────────────────────────────────────────
// Thresholds — tune these after backtesting
// ─────────────────────────────────────────────

const THRESHOLDS = {
  adx: {
    noTrend:    20,   // below this = ranging / no trend
    weakTrend:  25,   // 20-25 = trend forming
    strongTrend: 35,  // above this = strong trend
  },
  bollinger: {
    tight:  0.02,     // below this = consolidating
    wide:   0.06,     // above this = volatile / explosive
  },
  emaSlope: {
    flat:    0.05,    // % — below this = no direction
    strong:  0.20,    // % — above this = strong trend
  },
  volume: {
    spike:   2.0,     // ratio above this = unusual activity
  },
  rsi: {
    oversold:    35,
    overbought:  65,
  },
};

// ─────────────────────────────────────────────
// Main export — call with candle buffer
// Returns regime + supporting data for Claude
// ─────────────────────────────────────────────

export function detectRegime(candles: Candle[]): RegimeAnalysis | null {
  if (candles.length < 50) return null;

  const indicators = calculateIndicators(candles);
  if (!indicators) return null;

  const emaSlope = calculateEMASlope(candles);
  const regime   = classifyRegime(indicators, emaSlope);

  return {
    regime,
    confidence:  calculateConfidence(indicators, emaSlope, regime),
    adx:         indicators.adx,
    bbWidth:     indicators.bollinger.width,
    emaSlope,
    volumeTrend: indicators.volume.trend,
  };
}

// ─────────────────────────────────────────────
// Core classification logic
// Code gives Claude a starting point —
// Claude can override with reasoning
// ─────────────────────────────────────────────

function classifyRegime(indicators: Indicators, emaSlope: number): MarketRegime {
  const { adx, bollinger, volume, rsi } = indicators;
  const bbWidth    = bollinger.width;
  const volRatio   = volume.ratio;
  const absSlope   = Math.abs(emaSlope);

  // ── Volatile first — highest priority ──
  // Wide BBands + volume spike = something explosive happening
  if (bbWidth > THRESHOLDS.bollinger.wide && volRatio > THRESHOLDS.volume.spike) {
    return 'VOLATILE';
  }

  // ── Trending bull ──
  // Strong ADX + positive slope + price structure
  if (
    adx > THRESHOLDS.adx.weakTrend &&
    emaSlope > THRESHOLDS.emaSlope.flat &&
    rsi > THRESHOLDS.rsi.oversold
  ) {
    return 'TRENDING_BULL';
  }

  // ── Trending bear ──
  // Strong ADX + negative slope
  if (
    adx > THRESHOLDS.adx.weakTrend &&
    emaSlope < -THRESHOLDS.emaSlope.flat &&
    rsi < THRESHOLDS.rsi.overbought
  ) {
    return 'TRENDING_BEAR';
  }

  // ── Ranging ──
  // Weak ADX + tight BBands + flat slope
  if (
    adx < THRESHOLDS.adx.noTrend &&
    bbWidth < THRESHOLDS.bollinger.tight &&
    absSlope < THRESHOLDS.emaSlope.flat
  ) {
    return 'RANGING';
  }

  // ── Volatile without volume confirmation ──
  // Wide BBands alone = elevated volatility
  if (bbWidth > THRESHOLDS.bollinger.wide) {
    return 'VOLATILE';
  }

  // ── Default ──
  return 'NEUTRAL';
}

// ─────────────────────────────────────────────
// Confidence score 0-1
// How certain is the code about this regime?
// Claude sees this — low confidence = more likely to override
// ─────────────────────────────────────────────

function calculateConfidence(
  indicators: Indicators,
  emaSlope:   number,
  regime:     MarketRegime
): number {
  const { adx, bollinger, volume } = indicators;
  let score = 0;
  let checks = 0;

  switch (regime) {
    case 'TRENDING_BULL':
    case 'TRENDING_BEAR': {
      // Strong ADX confirms trend
      if (adx > THRESHOLDS.adx.strongTrend) score++;
      checks++;

      // Slope confirms direction
      if (Math.abs(emaSlope) > THRESHOLDS.emaSlope.strong) score++;
      checks++;

      // Volume confirms participation
      if (volume.trend === 'increasing') score++;
      checks++;

      // BBands not too wide (not chaotic)
      if (bollinger.width < THRESHOLDS.bollinger.wide) score++;
      checks++;
      break;
    }

    case 'RANGING': {
      // Very weak ADX = clearly ranging
      if (adx < THRESHOLDS.adx.noTrend - 5) score++;
      checks++;

      // Tight BBands
      if (bollinger.width < THRESHOLDS.bollinger.tight * 0.8) score++;
      checks++;

      // Flat volume
      if (volume.trend === 'flat') score++;
      checks++;
      break;
    }

    case 'VOLATILE': {
      // Wide BBands
      if (bollinger.width > THRESHOLDS.bollinger.wide * 1.2) score++;
      checks++;

      // Volume spike
      if (volume.ratio > THRESHOLDS.volume.spike * 1.2) score++;
      checks++;
      break;
    }

    default: {
      // NEUTRAL — inherently uncertain
      return 0.4;
    }
  }

  return checks > 0 ? Math.round((score / checks) * 100) / 100 : 0.5;
}

// ─────────────────────────────────────────────
// Significance checker
// Returns true if something meaningful happened
// this candle — used to decide whether to call Claude
// ─────────────────────────────────────────────

export function isSignificantCandle(
  candles:     Candle[],
  newsAlert:   boolean = false
): boolean {
  if (candles.length < 3) return false;

  const current  = candles.at(-1)!;
  const previous = candles.at(-2)!;

  // Price moved more than 0.5%
  const priceMove = Math.abs(current.close - previous.close) / previous.close;
  if (priceMove > 0.005) return true;

  // Volume spike — 1.5x average
  const recentVolumes = candles.slice(-21, -1).map(c => c.volume);
  const avgVolume     = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  if (current.volume > avgVolume * 1.5) return true;

  // Strong candle body — close near high or low (momentum candle)
  const candleRange = current.high - current.low;
  const bodySize    = Math.abs(current.close - current.open);
  if (candleRange > 0 && bodySize / candleRange > 0.7) return true;

  // News alert from news monitor
  if (newsAlert) return true;

  return false;
}

// ─────────────────────────────────────────────
// Format regime for Claude prompt
// Clean readable summary — not raw numbers
// ─────────────────────────────────────────────

export function formatRegimeForPrompt(analysis: RegimeAnalysis): string {
  const confidenceLabel =
    analysis.confidence >= 0.7 ? 'high confidence' :
    analysis.confidence >= 0.4 ? 'moderate confidence' :
    'low confidence — consider overriding';

  const slopeDirection =
    analysis.emaSlope > 0 ? `+${analysis.emaSlope}%` : `${analysis.emaSlope}%`;

  return `
MARKET REGIME (code detected): ${analysis.regime} (${confidenceLabel})
- ADX: ${analysis.adx} (${adxLabel(analysis.adx)})
- Bollinger width: ${analysis.bbWidth} (${bbLabel(analysis.bbWidth)})
- EMA slope: ${slopeDirection} per 5 candles
- Volume trend: ${analysis.volumeTrend}

Strategy implications:
${getStrategyHint(analysis.regime)}

Confirm this regime or override with reasoning.
`.trim();
}

// ─────────────────────────────────────────────
// Helpers for human-readable prompt labels
// ─────────────────────────────────────────────

function adxLabel(adx: number): string {
  if (adx < 20) return 'no trend';
  if (adx < 25) return 'weak trend forming';
  if (adx < 35) return 'trending';
  return 'strong trend';
}

function bbLabel(width: number): string {
  if (width < 0.02) return 'very tight — consolidating';
  if (width < 0.04) return 'normal';
  if (width < 0.06) return 'widening';
  return 'wide — elevated volatility';
}

function getStrategyHint(regime: MarketRegime): string {
  switch (regime) {
    case 'TRENDING_BULL':
      return '- Favour LONG entries\n- Use wider TP, trail stops\n- Momentum entries on pullbacks to EMA';
    case 'TRENDING_BEAR':
      return '- Favour SHORT entries only\n- Do not take LONG signals\n- Momentum entries on bounces to EMA';
    case 'RANGING':
      return '- Fade the extremes (buy low, sell high of range)\n- Tight TP near midpoint\n- Mean reversion approach';
    case 'VOLATILE':
      return '- Reduce position size by 50%\n- Only A+ confluence setups\n- Widen SL to account for noise';
    case 'NEUTRAL':
      return '- Standard approach\n- Wait for clearer structure before entering\n- Normal position sizing';
  }
}