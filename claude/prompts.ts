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
// System prompt
// WHO the AI is, HOW it thinks, WHAT it knows
// about itself — not a rulebook
// ─────────────────────────────────────────────

export function buildSystemPrompt(agent: Agent): string {

  const styleGuide = {
    scalp: "You are a fast scalping engine. You hunt for quick momentum moves lasting minutes to a few hours. You enter near current price and use tight stops.",

    swing: "You are a swing trading engine. You focus on higher-timeframe structure and pullbacks. Trades last hours to days with wider stops and clear targets.",

    position: "You are a position trading engine. You focus on major market structure, macro direction, and key levels on higher timeframes. Trades can last days to weeks. You prioritize strong confluence and high reward-to-risk setups over frequency.",

    auto: "You are a versatile trading engine. You adapt to whatever the market is offering — scalp, swing, position, or stay out.",

  }[agent.tradingStyle ?? 'auto'] || "You are a high-performance trading engine.";

  const learnedRulesText = agent.learnedRules?.length > 0
    ? `\nSTRICT LESSONS FROM PAST LOSSES (Never violate these):\n${agent.learnedRules.map((r, i) => `${i + 1}. [${r.patternTag}] ${r.rule}`).join('\n')}`
    : '';

  return `
    You are a high-performance cryptocurrency trading signal generator.

    Your job is to analyze the market and return high-quality trade setups when a real edge exists.

    CORE BEHAVIOR:
    - Markets can be noisy, chaotic, or conflicting — this does not eliminate opportunity
    - You may find trades in imperfect conditions if a clear idea exists
    - You must never guess, force, or hallucinate a setup

    CONFIDENCE:
    - Confidence reflects clarity of the setup (1–10)
    - Higher confidence = cleaner structure, better positioning
    - Lower confidence = more uncertainty

    - You may return a trade even with moderate confidence
      if a reasonable edge exists

    - If there is no meaningful edge → return NO_TRADE

    TRADE QUALITY:

    - Prefer trades with strong positioning:
      - Entries near support/resistance or structure
      - Pullbacks, retests, or rejection zones

    - Avoid poor positioning:
      - Mid-range entries with no clear edge
      - Chasing extended moves

    - Stop loss must represent true invalidation:
      - Where the idea is clearly wrong
      - Not placed too tight to normal volatility

    - Take profit must align with realistic price objectives:
      - Previous highs/lows
      - Liquidity zones
      - Key levels

    - Favor trades where reward-to-risk is naturally strong due to positioning

    TRIGGERS (Very Important):

    You must ALWAYS provide triggers — even if you return NO_TRADE.

    Triggers define when the system should re-analyze the market.

    - price_up_trigger:
      A level above current price where market structure may change

    - price_down_trigger:
      A level below current price where market structure may change

    - timeout_minutes:
      Time in minutes to force re-analysis if price remains inactive

    For NO_TRADE:
    - Triggers should represent conditions where a potential setup could emerge
    - This ensures the system continues monitoring intelligently

    Triggers must:
    - Be based on structure (not arbitrary distance)
    - Not be too close (avoid noise)
    - Not be too far (remain relevant)

    CURRENT PROFILE:
    - Pair: ${agent.pair}
    - Risk per trade: ${agent.riskPercent}%
    - Style: ${agent.tradingStyle}
    - Style Guide: ${styleGuide}

    ${learnedRulesText}

    You will be given multi-timeframe data, regime, key levels, and news.

    Decide based on real market logic.

    Return:
    - LONG or SHORT if a reasonable edge exists
    - NO_TRADE if no meaningful opportunity is present

    Always respond with valid JSON only.
  `.trim();
}

// ─────────────────────────────────────────────
// Entry prompt
// Data only — no instructions on how to analyse
// The system prompt handles reasoning identity
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

  const portfolioContext = buildPortfolioContext(monthlyPnl, performanceMode);

  const relevantLessons = lessons.length > 0
    ? `
━━━━━━━━━━━━━━━━━━━━━━━
PAST MISTAKES MATCHING THIS SETUP:
${lessons.map((l, i) =>
      `${i + 1}. [${l.patternTag}] ${l.ruleToAdd} — occurred ${l.frequency} time${l.frequency > 1 ? 's' : ''}`
    ).join('\n')}
    `.trim()
    : '';

  const levels1h = findKeyLevels(mtfData.tf1h.candles);
  const levels4h = findKeyLevels(mtfData.tf4h.candles);
  const keyLevels = formatKeyLevelsForPrompt(levels1h);
  const majorLevels = formatKeyLevelsForPrompt(levels4h);

  return `
${portfolioContext}

CURRENT TIME (UTC): ${now}
CURRENT PRICE: ${currentPrice}
PAIR: ${agent.pair}
1H ATR (volatility reference): ${atr1h}

Use the ATR as your reference for realistic entry distance, stop placement,
and target distance. Do not place levels disconnected from this volatility context.

━━━━━━━━━━━━━━━━━━━━━━━
KEY LEVELS — 1H (trade-level structure):
${keyLevels}

━━━━━━━━━━━━━━━━━━━━━━━
MAJOR LEVELS — 4H (structural context):
${majorLevels}

━━━━━━━━━━━━━━━━━━━━━━━
MARKET REGIME: ${regime.regime} (code confidence: ${(regime.confidence * 100).toFixed(0)}%)
ADX: ${regime.adx} | BB width: ${regime.bbWidth} | EMA slope: ${regime.emaSlope}% | Volume trend: ${regime.volumeTrend}

━━━━━━━━━━━━━━━━━━━━━━━
4H — trend and structural context:
${formatTimeframe(mtfData.tf4h)}

━━━━━━━━━━━━━━━━━━━━━━━
1H — momentum and setup development:
${formatTimeframe(mtfData.tf1h)}

━━━━━━━━━━━━━━━━━━━━━━━
15M — entry timing and trigger:
${formatTimeframe(mtfData.tf15m)}

━━━━━━━━━━━━━━━━━━━━━━━
5M — precise current price action:
${formatTimeframe(mtfData.tf5m)}

━━━━━━━━━━━━━━━━━━━━━━━
NEWS & SENTIMENT:
${newsContext}

${relevantLessons}

━━━━━━━━━━━━━━━━━━━━━━━
BEFORE YOU RESPOND — run this audit on your own output:

1. Is my entry within a realistic distance of ${currentPrice}
   given the current 1H ATR of ${atr1h}?
   An entry more than 2-3x ATR away from current price is disconnected from reality.

2. If LONG — is my stop loss BELOW my entry?
   If SHORT — is my stop loss ABOVE my entry?
   If either fails, you have made an error. Correct it.

3. Is there a visible key level between my entry and my target
   that I have not accounted for?
   If yes — either adjust the target or explain why price will push through it.

4. Am I genuinely at 7.5 confidence or above on conviction?
   Be honest. If you are below 7.5 confidence — return NO_TRADE.
   The market does not reward low-conviction entries.

If any check reveals an error — fix it before writing the JSON.

Respond ONLY with this exact JSON:
{
  "action": "LONG" | "SHORT" | "NO_TRADE",
  "entry": <number | null>,
  "tp": <number | null>,
  "sl": <number | null>,
  "confidence": number,                    <1-10>
  "timeframe_used": "<which timeframe drove the decision>",
  "tradeStyle": "scalp" | "swing" | "position" ,
  "entry_expiry": "<ISO 8601 UTC timestamp — when this signal expires if entry not triggered >",
  "reasoning": "<your honest analysis in 2-3 sentences — max 150 chars>",
  "what_invalidates": "<what price action proves your read wrong — max 80 chars>",
  "triggers": {
    "price_up": <number>,
    "price_down": <number>,
    "timeout": "<ISO 8601 UTC timestamp>"
  }
}

Keep reasoning under 150 characters.
Keep what_invalidates under 80 characters.
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
  const styleGuide = {
    scalp: "You are a fast scalping engine. You hunt for quick momentum moves lasting minutes to a few hours. You enter near current price and use tight stops.",

    swing: "You are a swing trading engine. You focus on higher-timeframe structure and pullbacks. Trades last hours to days with wider stops and clear targets.",

    position: "You are a position trading engine. You focus on major market structure, macro direction, and key levels on higher timeframes. Trades can last days to weeks. You prioritize strong confluence and high reward-to-risk setups over frequency.",

    auto: "You are a versatile trading engine. You adapt to whatever the market is offering — scalp, swing, position, or stay out.",

  }[agent.tradingStyle ?? 'auto'] || "You are a high-performance trading engine.";

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
  Trading Style Guide: ${styleGuide}



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