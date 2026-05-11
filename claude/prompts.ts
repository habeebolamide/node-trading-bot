import type { Agent } from '../types/agent.types';
import type {
  Candle,
  MultiTimeframeData,
  RegimeAnalysis
} from '../types/market.types';
import type {
  PerformanceMode,
  RelevantLesson
} from '../types/risk.types';
import type {
  ClosedTrade,
  OpenTrade
} from '../types/trade.types';
import { findKeyLevels, formatKeyLevelsForPrompt } from "../markets/keys";

// ─────────────────────────────────────────────
// TEST MODE FLAG
// Set to true to force LONG/SHORT signals
// Remove entirely when going live
// ─────────────────────────────────────────────

const TEST_MODE = true;

// ─────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────

export function buildSystemPrompt(agent: Agent): string {

  const styleGuide = {
    scalp: `
      You trade short-term momentum. Trades last minutes to a few hours.
      You look for quick, high-probability moves with tight stops and clear targets.
      You enter close to current price or at immediate structure levels.
    `.trim(),

    swing: `
      You trade structure and continuation. Trades last hours to days.
      You wait for pullbacks to key levels before entering.
      You hold through noise as long as the thesis is intact.
    `.trim(),

    position: `
      You trade major structural moves. Trades can last days to weeks.
      You focus on macro direction and high-conviction setups only.
      You are patient — you wait for the market to come to you.
    `.trim(),

    auto: `
You adapt to whatever the market is offering.
You decide whether to scalp, swing, or stay out based on current conditions.
You never force a style onto conditions that don't support it.
    `.trim(),
  }[agent.tradingStyle ?? 'auto'] ?? '';

  const learnedMistakes = agent.learnedRules?.length > 0
    ? `
      ━━━━━━━━━━━━━━━━━━━━━━━
      LESSONS FROM YOUR PAST LOSSES — never repeat these:
      ${agent.learnedRules.map((r, i) => `${i + 1}. [${r.patternTag}] ${r.rule}`).join('\n')}
    `.trim()
    : '';

  const testModeBlock = TEST_MODE
    ? `
      ━━━━━━━━━━━━━━━━━━━━━━━
      TEST MODE — ACTIVE:
      You MUST return LONG or SHORT. NO_TRADE is not allowed.
      If the market is unclear choose the most reasonable directional bias.
      Do not invent fake levels. Keep entries logical relative to current price.
      Reflect uncertainty through lower confidence score.
      ━━━━━━━━━━━━━━━━━━━━━━━
    `.trim()
    : '';

  return `
    You are an autonomous cryptocurrency trading agent.
    You study the market independently, identify genuine opportunities,
    and execute with precision and discipline.
    
    You are not a signal factory. You are a market participant.
    You have a clear edge and the patience to wait for it.
    When the setup is there — you act. When it is not — you wait.
    Missing a good trade hurts just as much as taking a bad one.
    
    YOUR APPROACH:
    ${styleGuide}
    
    YOUR ASSIGNMENT:
    Pair: ${agent.pair}
    Risk per trade: ${agent.riskPercent}%
    
    HOW YOU FIND TRADES:
    
    Two valid entry approaches:
    
    CONFIRMATION — enter after breakout or strong momentum signal.
    Entry is at or near current price. Used when momentum is clear.
    
    PULLBACK — wait for price to return to a key structural level.
    Entry can be above or below current price.
    Used when a better risk-to-reward exists at a nearby level.
    Never force entry at current price if a cleaner level is close.
    
    HOW YOU SET LEVELS:
    
    Every level you output must come from visible market structure.
    Support zones, resistance zones, swing highs, swing lows, liquidity areas.
    No arbitrary numbers. No round numbers unless they are also structural.
    
    Stop loss = the exact point where your trade idea is proven wrong.
    Take profit = the next meaningful structural level in your favour.
    
    HOW YOU SET TRIGGERS:
    
    Triggers tell the system when to re-evaluate.
    They must be structural — not arbitrary distances.
    
    price_up = the nearest resistance above current price where
    a break would meaningfully change the market structure or your bias.
    
    price_down = the nearest support below current price where
    a break would meaningfully change the market structure or your bias.
    
    timeout = how long this analysis remains valid if price does nothing.
    Base it on your trading style and current volatility.
    
    Always provide triggers — even for NO_TRADE.
    For NO_TRADE — triggers represent where a setup could begin to form.
    
    CONFIDENCE:
    
    7.0 and above = trade is worth taking.
    Below 7.0 = setup is unclear — return NO_TRADE.
    Be honest. Do not inflate confidence to justify a trade.
    Do not deflate it out of excessive caution.
    
    ${learnedMistakes}
    
    ${testModeBlock}
    For "LONG" | "SHORT" entry_expiry = how long the setup remains valid if entry is not hit
    Always respond with valid JSON only. No text outside the JSON.
  `.trim();
}

// ─────────────────────────────────────────────
// Entry prompt — data only
// ─────────────────────────────────────────────

export function buildEntryPrompt(
  agent: Agent,
  mtfData: MultiTimeframeData,
  regime: RegimeAnalysis,
  newsContext: string,
  lessons: RelevantLesson[],
  monthlyPnl: number,
  performanceMode: PerformanceMode,
): string {

  const now = new Date().toISOString();
  const currentPrice = mtfData.tf5m.candles.at(-1)?.close
    ?? mtfData.tf15m.candles.at(-1)?.close
    ?? mtfData.tf1h.candles.at(-1)?.close
    ?? 0;

  const atr1h = mtfData.tf1h.indicators?.atr?.toFixed(5) ?? 'unknown';

  // Minimal portfolio context — mode name only, no descriptive text
  // that could bleed into entry logic
  const modeLabel = `Performance mode: ${performanceMode} | Monthly P&L: ${monthlyPnl >= 0 ? '+' : ''}${monthlyPnl.toFixed(2)}%`;

  const relevantLessons = lessons.length > 0
    ? `
━━━━━━━━━━━━━━━━━━━━━━━
PAST MISTAKES MATCHING THIS SETUP:
${lessons.map((l, i) =>
      `${i + 1}. [${l.patternTag}] ${l.ruleToAdd} — occurred ${l.frequency}x`
    ).join('\n')}
    `.trim()
    : '';

  const levels1h = findKeyLevels(mtfData.tf1h.candles);
  const levels4h = findKeyLevels(mtfData.tf4h.candles);
  const keyLevels = formatKeyLevelsForPrompt(levels1h);
  const majorLevels = formatKeyLevelsForPrompt(levels4h);

  return `
    ${modeLabel}
    CURRENT TIME (UTC): ${now}
    CURRENT PRICE: ${currentPrice}
    PAIR: ${agent.pair}
    1H ATR: ${atr1h}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    KEY LEVELS — 1H:
    ${keyLevels}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    MAJOR LEVELS — 4H:
    ${majorLevels}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    REGIME: ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% confidence)
    ADX: ${regime.adx} | BB width: ${regime.bbWidth} | EMA slope: ${regime.emaSlope}% | Volume: ${regime.volumeTrend}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    4H:
    ${formatTimeframe(mtfData.tf4h)}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    1H:
    ${formatTimeframe(mtfData.tf1h)}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    15M:
    ${formatTimeframe(mtfData.tf15m)}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    5M:
    ${formatTimeframe(mtfData.tf5m)}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    NEWS:
    ${newsContext}
    
    ${relevantLessons}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    BEFORE RESPONDING — check these:
    
    1. If LONG — is SL below entry? If SHORT — is SL above entry?
      If no — you have an error. Fix it.
    
    2. Is confidence genuinely 7.0 or above?
      If no — return NO_TRADE.
    
    Respond ONLY with this exact JSON:
    {
      "action": "LONG" | "SHORT" | "NO_TRADE",
      "entry": <number | null>,
      "tp": <number | null>,
      "sl": <number | null>,
      "confidence": <number 1-10>,
      "timeframe_used": "<timeframe that drove the decision>",
      "tradeStyle": "scalp" | "swing" | "position",
      "entry_expiry": "<ISO 8601 UTC | null>",
      "reasoning": "<max 150 chars>",
      "what_invalidates": "<max 80 chars>",
      "triggers": {
        "price_up": <number | null>,
        "price_down": <number | null>,
        "timeout": "<ISO 8601 UTC>"
      }
    }
  `.trim();
}

// ─────────────────────────────────────────────
// Management prompt
// ─────────────────────────────────────────────

export function buildManagementPrompt(
  agent: Agent,
  trade: OpenTrade,
  mtfData: MultiTimeframeData,
  newsContext: string,
): string {
  const pnlSign = trade.unrealisedPct >= 0 ? '+' : '';
  const duration = getTimeSince(trade.openedAt);
  const currentPrice = mtfData.tf5m.candles.at(-1)?.close ?? trade.entryPrice;

  return `
  You have an open ${trade.direction} trade on ${trade.pair}.

  OPEN TRADE:
  Direction:      ${trade.direction}
  Entry:          ${trade.entryPrice}
  Current price:  ${currentPrice}
  TP:             ${trade.currentTp}
  SL:             ${trade.currentSl}
  Unrealised P&L: ${pnlSign}${trade.unrealisedPct.toFixed(2)}% (${pnlSign}$${trade.unrealisedPnl.toFixed(2)})
  Time open:      ${duration}
  Original read:  "${trade.entryReasoning}"



  ━━━━━━━━━━━━━━━━━━━━━━━
  4H — is the original thesis still structurally intact?
  ${formatTimeframe(mtfData.tf4h)}

  ━━━━━━━━━━━━━━━━━━━━━━━
  1H — how is momentum developing?
  ${formatTimeframe(mtfData.tf1h)}

  ━━━━━━━━━━━━━━━━━━━━━━━
  15M — what is price doing right now?
  ${formatTimeframe(mtfData.tf15m)}

  ━━━━━━━━━━━━━━━━━━━━━━━
  NEWS:
  ${newsContext}

  Review the current state against your original thesis.
  A trade being temporarily in loss is normal. Do not close based on that alone.
  Close or adjust only if the thesis is genuinely invalidated or market structure changed.
  You may never move the stop loss further away from entry — only tighten it.

  After your decision, always provide re-analysis triggers.
  These are price levels where the trade situation changes significantly.

  price_up: a level above current price where you would want to re-assess
    — e.g. resistance that if broken changes the thesis
    — e.g. a level where partial profit should be taken

  price_down: a level below current price where you would want to re-assess  
    — e.g. support that if broken invalidates the trade
    — e.g. a level that would warrant tightening the stop

  Both must be based on visible structure — not arbitrary distances.
  Set to null only if no meaningful level exists nearby.

  Respond ONLY with this exact JSON:
  {
    "action": "HOLD" | "ADJUST" | "CLOSE" | "PARTIAL_CLOSE",
    "newTp": <number | null>,
    "newSl": <number | null>,
    "closePercent": <0-100 | null>,
    "reasoning": "<why you are making this decision — max 100 chars>",
    "urgency": "low" | "medium" | "high",
    "triggers": {
      "price_up": <number | null>,
      "price_down": <number | null>
    }
  }
  `.trim();
}

// ─────────────────────────────────────────────
// Post-mortem prompt
// ─────────────────────────────────────────────

export function buildPostMortemPrompt(
  trade: ClosedTrade,
  regimeAtEntry: string,
  newsAtEntry: string,
  rsiAtEntry: number,
  volumeRatioAtEntry: number,
): string {
  return `
A trade just closed at a loss. Analyse it with complete honesty.

TRADE:
Pair:      ${trade.pair}
Direction: ${trade.direction}
Entry:     ${trade.entryPrice} → Exit: ${trade.exitPrice}
Loss:      ${trade.realisedPct.toFixed(2)}%
Duration:  ${trade.durationHours.toFixed(1)} hours
Reason:    ${trade.closeReason}
Original reasoning: "${trade.entryReasoning}"

CONDITIONS AT ENTRY:
Regime:  ${regimeAtEntry}
RSI:     ${rsiAtEntry}
Volume:  ${volumeRatioAtEntry}x average
News:    ${newsAtEntry}

What actually went wrong?

Respond ONLY with this exact JSON:
{
  "primaryReason": "<one sentence — the real cause>",
  "warningSigns": ["<warning sign present at entry>", "<another if applicable>"],
  "patternTag": "<SCREAMING_SNAKE_CASE>",
  "ruleToAdd": "<one specific actionable rule to prevent this>",
  "verdict": "bad_trade" | "bad_luck" | "bad_management",
  "avoidable": <true | false>
}
  `.trim();
}

// ─────────────────────────────────────────────
// Synthesis prompt — weekly job
// ─────────────────────────────────────────────

export function buildSynthesisPrompt(lessons: any[]): string {
  return `
You have ${lessons.length} lessons from losing trades.
Find the top 5 most damaging recurring patterns.
Write one precise actionable rule per pattern.
Vague rules are worthless.

LESSONS:
${JSON.stringify(lessons, null, 2)}

Respond ONLY with this exact JSON:
{
  "rules": [
    {
      "patternTag": "<SCREAMING_SNAKE_CASE>",
      "rule": "<specific actionable rule>",
      "frequency": <number of occurrences>
    }
  ]
}
  `.trim();
}

// ─────────────────────────────────────────────
// Format timeframe — clean 6-line narrative
// Cuts noise, keeps what a trader actually reads
// ─────────────────────────────────────────────

function formatTimeframe(tf: MultiTimeframeData['tf4h']): string {
  if (!tf || tf.candles.length === 0) return 'Insufficient data';

  const candles = tf.candles;
  const ind = tf.indicators;
  const latest = candles.at(-1)!;
  const prev = candles.at(-2);

  const direction = latest.close >= (prev?.close ?? latest.close) ? '▲' : '▼';
  const structure = detectStructure(candles);
  const pattern = describeCandlePattern(latest, prev);

  const vsEma20 = latest.close > ind.ema20 ? `above EMA20 (${ind.ema20})` : `below EMA20 (${ind.ema20})`;
  const vsEma50 = latest.close > ind.ema50 ? `above EMA50 (${ind.ema50})` : `below EMA50 (${ind.ema50})`;

  const rsiContext =
    ind.rsi > 72 ? `${ind.rsi} — overbought` :
      ind.rsi < 28 ? `${ind.rsi} — oversold` :
        `${ind.rsi}`;

  const volContext =
    ind.volume.ratio > 1.8 ? `SPIKE (${ind.volume.ratio.toFixed(1)}x)` :
      ind.volume.ratio < 0.6 ? `weak (${ind.volume.ratio.toFixed(1)}x)` :
        `normal (${ind.volume.ratio.toFixed(1)}x)`;

  const macdRead = ind.macd.histogram > 0 ? 'positive' : 'negative';

  const recent = candles.slice(-10);
  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));

  return `
Price: ${latest.close} ${direction} | ${vsEma20} | ${vsEma50}
Structure: ${structure}
RSI: ${rsiContext} | Volume: ${volContext} | MACD histogram: ${macdRead}
ATR: ${ind.atr} | ADX: ${ind.adx}${ind.adx > 25 ? ' (trending)' : ' (no clear trend)'}
Latest candle: ${pattern}
Recent range: ${recentLow} — ${recentHigh}
  `.trim();
}

// ─────────────────────────────────────────────
// Detect market structure
// ─────────────────────────────────────────────

function detectStructure(candles: Candle[]): string {
  if (candles.length < 10) return 'Insufficient data';

  const recent = candles.slice(-20);
  const firstHalf = recent.slice(0, 10);
  const secondHalf = recent.slice(10);

  const firstHigh = Math.max(...firstHalf.map(c => c.high));
  const secondHigh = Math.max(...secondHalf.map(c => c.high));
  const firstLow = Math.min(...firstHalf.map(c => c.low));
  const secondLow = Math.min(...secondHalf.map(c => c.low));

  const higherHighs = secondHigh > firstHigh;
  const higherLows = secondLow > firstLow;
  const lowerHighs = secondHigh < firstHigh;
  const lowerLows = secondLow < firstLow;

  if (higherHighs && higherLows) return 'Uptrend — higher highs, higher lows';
  if (lowerHighs && lowerLows) return 'Downtrend — lower highs, lower lows';
  if (higherHighs && lowerLows) return 'Expanding range — increasing volatility';
  if (lowerHighs && higherLows) return 'Contracting range — compression forming';
  return 'Ranging — no clear direction';
}

// ─────────────────────────────────────────────
// Describe latest candle pattern
// ─────────────────────────────────────────────

function describeCandlePattern(candle: Candle, prev?: Candle): string {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const isBull = candle.close > candle.open;

  if (range === 0) return 'Doji — indecision';

  const bodyRatio = body / range;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;

  if (bodyRatio > 0.7) {
    return isBull
      ? `Strong bullish candle (${(bodyRatio * 100).toFixed(0)}% body)`
      : `Strong bearish candle (${(bodyRatio * 100).toFixed(0)}% body)`;
  }

  if (upperRatio > 0.6) return 'Upper wick rejection — bearish pressure';
  if (lowerRatio > 0.6) return 'Lower wick rejection — bullish pressure';
  if (bodyRatio < 0.2) return 'Doji / spinning top — indecision';

  if (prev) {
    const prevBull = prev.close > prev.open;
    if (isBull && !prevBull && candle.close > prev.open && candle.open < prev.close)
      return 'Bullish engulfing — reversal signal';
    if (!isBull && prevBull && candle.close < prev.open && candle.open > prev.close)
      return 'Bearish engulfing — reversal signal';
  }

  return isBull
    ? `Bullish candle (${(bodyRatio * 100).toFixed(0)}% body)`
    : `Bearish candle (${(bodyRatio * 100).toFixed(0)}% body)`;
}

// ─────────────────────────────────────────────
// Portfolio context block
// ─────────────────────────────────────────────

function buildPortfolioContext(monthlyPnl: number, mode: PerformanceMode): string {
  const modeContext = {
    NORMAL: 'Standard operation.',
    GROWTH: 'Monthly floor achieved. Focus on letting winners run.',
    CONSERVATIVE: 'Approaching drawdown limit. Be highly selective.',
    RECOVERY: 'In drawdown. Capital preservation is the priority.',
  }[mode] ?? '';

  return `
PORTFOLIO STATE:
Monthly P&L: ${monthlyPnl >= 0 ? '+' : ''}${monthlyPnl.toFixed(2)}%
Mode: ${mode} — ${modeContext}
  `.trim();
}

// ─────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────

function getTimeSince(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = ms / (1000 * 60 * 60);
  return hours < 1
    ? `${Math.round(hours * 60)} minutes`
    : `${hours.toFixed(1)} hours`;
}