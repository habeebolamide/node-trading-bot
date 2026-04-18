

// ─────────────────────────────────────────────
// System prompt
// Establishes WHO the AI is — not what rules to follow
// This gets cached — charged once per session
// ─────────────────────────────────────────────

import { findKeyLevels, formatKeyLevelsForPrompt } from "../markets/keys";
import { Agent } from "../types/agent.types";
import { Candle, MultiTimeframeData, RegimeAnalysis } from "../types/market.types";
import { PerformanceMode, RelevantLesson } from "../types/risk.types";
import { ClosedTrade, OpenTrade } from "../types/trade.types";

export function buildSystemPrompt(agent: Agent): string {
  const styleGuide = {
    scalp: "You are a scalper. You hunt for quick, high-probability moves that last minutes to a few hours. You enter close to current price and use tight stops beyond immediate structure.",
    swing: "You are a swing trader. You focus on higher-timeframe structure and pullbacks. You hold through noise but exit at clear resistance/support levels.",
    auto: "You are a versatile trader. You first determine the market condition, then decide whether to scalp, swing, or stay out.",
  }[agent.tradingStyle] || "You are a professional trader.";

  const learnedRules = agent.learnedRules.length > 0
    ? `\nLESSONS FROM PAST LOSSES (Follow strictly):\n${agent.learnedRules
      .map((r, i) => `${i + 1}. [${r.patternTag}] ${r.rule}`)
      .join('\n')}`
    : '';

  return `
    You are a systematic crypto trading agent.

    Your purpose is to analyze market data and identify trade opportunities with favorable risk-to-reward.
    You operate based on probabilistic reasoning, not assumptions or guesswork.


    YOUR PROFILE:
    - Pair: ${agent.pair}
    - Risk per trade: ${agent.riskPercent}%
    - Style: ${agent.tradingStyle}

    ${styleGuide}


    MARKET BEHAVIOR:

  - Markets are often imperfect, noisy, or conflicting — this does not eliminate opportunity
  - Consolidation and compression can precede expansion
  - Mixed signals may still form a valid setup if a coherent narrative exists
  - Do not avoid trades solely because conditions are not perfect


 TRADE PRINCIPLES:

- Every trade must have:
  - Clear reasoning
  - Logical structure
  - Defined invalidation

- Entries should align with confirmation, not anticipation
- Avoid entering before price interaction with key level

- Stop loss must represent where the trade idea fails
- Take profit must align with a realistic price objective
- Favor good positioning (near structure) over chasing moves


  TRIGGERS:

  In addition to your trade decision, define trigger levels for re-evaluation.
  Triggers should represent meaningful changes in market context — not arbitrary distances.

  - price_up:
    A level ABOVE current price where the current idea may change.
    This should correspond to a structural shift such as:
    - breakout of resistance
    - reclaim of a key level
    - invalidation of bearish bias

    Avoid setting levels too far from current price.

  - price_down:
    A level BELOW current price where the current idea may change.
    This should correspond to:
    - breakdown of support
    - continuation trigger
    - loss of bullish structure

    Avoid setting levels too far from current price.

  - timeout:
    A future timestamp (ISO 8601 UTC) for re-evaluation if price remains inactive.

    Guidelines:
    - Must align with timeframe_used
    - 5M setups: 5–20 minutes
    - 15M setups: 15–45 minutes
    - 1H setups: 30–90 minutes
    - Do NOT exceed 90 minutes

    Timeout represents how long the setup remains valid WITHOUT entry.
    If no trigger is hit within this time, the idea is considered stale.

    Guidelines:
    - Triggers must be based on structure, not arbitrary distances
    - Do not place triggers too close to current price (avoid noise)
    - Do not place triggers too far (must be relevant to current setup)

  DECISION STANDARD:

  - You are not required to be certain — only reasonable
  - A valid trade can exist in imperfect conditions
  - Avoid both extremes:
    - Over-filtering (missing trades)
    - Over-forcing (low-quality trades)

    OUTPUT:

    Always respond with valid JSON only. No explanations outside JSON.

    `.trim() + learnedRules;
}



// TEST MODE:

// - You must return a trade (LONG or SHORT)
// - When no strong edge exists, choose the most reasonable directional bias
// - Do not invent structure or invalid levels
// - Reflect uncertainty through lower confidence

// ─────────────────────────────────────────────
// Entry prompt
// Pure data — no rules, no instructions on HOW to analyse
// Gemini reads this like a trader reads a chart
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

  const currentPrice = mtfData.tf5m.candles.at(-1)?.close ??
    mtfData.tf15m.candles.at(-1)?.close ?? 0;

  const relevantLessons = lessons.length > 0
    ? `\nRELEVANT LESSONS:\n${lessons.map((l, i) => `${i + 1}. [${l.patternTag}] ${l.ruleToAdd}`).join('\n')}`
    : '';

  const portfolioContext = `
    CURRENT PORTFOLIO STATE:
    Monthly P&L: ${monthlyPnl >= 0 ? '+' : ''}${monthlyPnl.toFixed(2)}%
    Performance mode: ${performanceMode}
    ${performanceMode === 'RECOVERY' ? 'You are in drawdown. Capital preservation is your top priority right now.' : ''}
    ${performanceMode === 'CONSERVATIVE' ? 'You are approaching your drawdown limit. Be selective.' : ''}
    ${performanceMode === 'GROWTH' ? 'You have hit your monthly floor. Let winners run.' : ''}
    ${performanceMode === 'NORMAL' ? 'Standard operation. Trade your plan.' : ''}
  `.trim();

  console.log(portfolioContext,"Checking Portfolio context");
  

  return `

  ${portfolioContext}

  CURRENT PRICE: ${currentPrice} | CURRENT TIME (UTC): ${now} | Pair: ${agent.pair}

  MARKET REGIME: ${regime.regime} (Confidence: ${(regime.confidence * 100).toFixed(0)}%)

  MULTI-TIMEFRAME ANALYSIS:

  4H:
  ${formatTimeframe(mtfData.tf4h)}

  1H:
  ${formatTimeframe(mtfData.tf1h)}

  15M:
  ${formatTimeframe(mtfData.tf15m)}

  5M:
  ${formatTimeframe(mtfData.tf5m)}

  KEY LEVELS (1H): ${formatKeyLevelsForPrompt(findKeyLevels(mtfData.tf1h.candles))}

  NEWS: ${newsContext}

  ${relevantLessons}

  Rules for entry_expiry:
  - Must be a valid ISO 8601 UTC timestamp (e.g. "2026-04-14T23:01:32Z")
  - Must be calculated relative to CURRENT TIME (UTC)
  - This is the maximum time the entry remains valid if price has NOT been triggered.
  - Base it on timeframe_used decided and current volatility.
  - If NO_TRADE, return null.

  Analyze the full picture and decide.

  Respond ONLY with this exact JSON structure:
  {
    "action": "LONG" | "SHORT" | "NO_TRADE",
    "entry": number | null,
    "tp": number | null,
    "sl": number | null,
    "confidence": number, // 1-10
    "timeframe_used": string,
    "reasoning": string,
    "what_invalidates": string,
    "tradeStyle": string, // if auto decide whether it's swing or scalp
    "entry_expiry": string | null,
    "triggers": {
      "price_up": number | null,
      "price_down": number | null,
      "timeout": string | null
    }
  }

  Keep "reasoning" under 120 characters.
  Keep "what_invalidates" under 80 characters.
 
`.trim();
}

// ─────────────────────────────────────────────
// Management prompt
// Show the AI the current state of the trade
// and the current market — let it decide
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
    Here is the complete current state.
    
    OPEN TRADE:
    Direction: ${trade.direction}
    Entry price: ${trade.entryPrice}
    Current price: ${currentPrice}
    Current TP: ${trade.currentTp}
    Current SL: ${trade.currentSl}
    Unrealised P&L: ${pnlSign}${trade.unrealisedPct.toFixed(2)}% (${pnlSign}$${trade.unrealisedPnl.toFixed(2)})
    Time in trade: ${duration}
    Your original reasoning: "${trade.entryReasoning}"


    IMPORTANT PRINCIPLES:

    - A trade being in loss is normal and NOT a reason to close
    - Only close a trade early if:
      - The original idea is clearly invalidated, OR
      - Market structure has significantly changed

    - If the setup is still valid → HOLD

    - You may ADJUST:
      - Tighten SL to reduce risk
      - Extend TP if momentum improves
      - Take partial profits if appropriate

    - Do NOT:
      - Panic close due to temporary drawdown
      - Move SL further away (never increase risk)
    
    CURRENT MARKET STATE:
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    4H (is the original thesis still intact?):
    ${formatTimeframe(mtfData.tf4h)}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    1H (how is momentum developing?):
    ${formatTimeframe(mtfData.tf1h)}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    15M (what is price doing right now?):
    ${formatTimeframe(mtfData.tf15m)}
    
    ━━━━━━━━━━━━━━━━━━━━━━━
    NEWS:
    ${newsContext}
    
    Review the trade against current market conditions.
    Has anything changed that affects your original thesis?
    
    Respond ONLY with this exact JSON:
    {
      "action": "HOLD" | "ADJUST" | "CLOSE" | "PARTIAL_CLOSE",
      "newTp": <number | null>,
      "newSl": <number | null>,
      "closePercent": <0-100 | null>,
      "reasoning": "<why you are making this decision>",
      "urgency": "low" | "medium" | "high"
    }
  `.trim();
}

// ─────────────────────────────────────────────
// Post-mortem prompt
// After every loss — understand what went wrong
// ─────────────────────────────────────────────

export function buildPostMortemPrompt(
  trade: ClosedTrade,
  regimeAtEntry: string,
  newsAtEntry: string,
  rsiAtEntry: number,
  volumeRatioAtEntry: number,
): string {
  return `
A trade closed at a loss. Analyse it with complete honesty.
 
TRADE:
Pair: ${trade.pair}
Direction: ${trade.direction}
Entry: ${trade.entryPrice} → Exit: ${trade.exitPrice}
Loss: ${trade.realisedPct.toFixed(2)}%
Duration: ${trade.durationHours.toFixed(1)} hours
Closed because: ${trade.closeReason}
Original reasoning at entry: "${trade.entryReasoning}"
 
MARKET CONDITIONS AT ENTRY:
Regime: ${regimeAtEntry}
RSI: ${rsiAtEntry}
Volume: ${volumeRatioAtEntry}x average
News: ${newsAtEntry}
 
Be brutally honest. What went wrong?
 
Respond ONLY with this exact JSON:
{
  "primaryReason": "<one clear sentence — the real cause>",
  "warningSigns": ["<sign that was present but ignored>", "..."],
  "patternTag": "<SCREAMING_SNAKE_CASE — e.g. COUNTER_TREND_ENTRY>",
  "ruleToAdd": "<one specific actionable rule to avoid this next time>",
  "verdict": "bad_trade" | "bad_luck" | "bad_management",
  "avoidable": <true | false>
}
  `.trim();
}

// ─────────────────────────────────────────────
// Synthesis prompt — weekly job
// Compress all lessons into top patterns
// ─────────────────────────────────────────────

export function buildSynthesisPrompt(lessons: any[]): string {
  return `
You have accumulated ${lessons.length} lessons from losing trades.
Study them carefully and identify the most damaging recurring patterns.
 
LESSONS:
${JSON.stringify(lessons, null, 2)}
 
Find the top 5 patterns that are costing the most money.
Write one precise, actionable rule for each.
Vague rules are worthless. Be specific.
 
Respond ONLY with this exact JSON:
{
  "rules": [
    {
      "patternTag": "<SCREAMING_SNAKE_CASE>",
      "rule": "<specific actionable rule>",
      "frequency": <how many times this pattern appeared>
    }
  ]
}
  `.trim();
}

// ─────────────────────────────────────────────
// Format timeframe data for the prompt
// Gives the AI what a trader sees on a chart —
// price action, structure, momentum, volume
// Not raw OHLCV — a readable market narrative
// ─────────────────────────────────────────────

function formatTimeframe(tf: MultiTimeframeData['tf4h']): string {
  if (!tf || tf.candles.length === 0) return 'Insufficient data';

  const candles = tf.candles;
  const ind = tf.indicators;
  const latest = candles.at(-1)!;
  const prev = candles.at(-2);
  const oldest = candles[0];

  // Price direction
  const candleDir = latest.close >= (prev?.close ?? latest.close) ? '▲' : '▼';

  // Price vs key MAs
  const vsEma20 = latest.close > ind.ema20
    ? `above EMA20 (${ind.ema20})`
    : `below EMA20 (${ind.ema20})`;
  const vsEma50 = latest.close > ind.ema50
    ? `above EMA50 (${ind.ema50})`
    : `below EMA50 (${ind.ema50})`;

  // Overall range context
  const rangeHigh = Math.max(...candles.map(c => c.high));
  const rangeLow = Math.min(...candles.map(c => c.low));
  const rangePct = ((latest.close - rangeLow) / (rangeHigh - rangeLow) * 100).toFixed(0);

  // Recent structure — last 10 candles
  const recent = candles.slice(-10);
  const recentHighs = recent.map(c => c.high);
  const recentLows = recent.map(c => c.low);
  const structure = detectStructure(candles);

  // Momentum
  const macdBias = ind.macd.histogram > 0 ? 'bullish' : 'bearish';
  const macdStrength = Math.abs(ind.macd.histogram) > Math.abs(ind.macd.signal) * 0.5
    ? 'strong'
    : 'weak';

  // Volume context
  const volContext = ind.volume.ratio > 1.5
    ? `ELEVATED (${ind.volume.ratio.toFixed(1)}x average)`
    : ind.volume.ratio < 0.7
      ? `LOW (${ind.volume.ratio.toFixed(1)}x average)`
      : `Normal (${ind.volume.ratio.toFixed(1)}x average)`;

  // Candle pattern on latest
  const candlePattern = describeCandlePattern(latest, prev);

  return `
    Price: ${latest.close} ${candleDir} | Range position: ${rangePct}% of last ${candles.length} candles
    Structure: ${structure}
    vs EMA20: ${vsEma20} | vs EMA50: ${vsEma50} | EMA200: ${ind.ema200}
    RSI(14): ${ind.rsi} ${ind.rsi > 70 ? '— overbought territory' : ind.rsi < 30 ? '— oversold territory' : ''}
    MACD: ${macdBias} momentum (${macdStrength}) | Histogram: ${ind.macd.histogram}
    Bollinger: width ${ind.bollinger.width} | Upper: ${ind.bollinger.upper} | Lower: ${ind.bollinger.lower}
    ADX: ${ind.adx} ${ind.adx > 25 ? '— trending' : '— no clear trend'}
    ATR: ${ind.atr} (current volatility measure)
    Volume: ${volContext}
    Latest candle: ${candlePattern}
    Recent high: ${Math.max(...recentHighs)} | Recent low: ${Math.min(...recentLows)}
  `.trim();
}

// ─────────────────────────────────────────────
// Detect price structure from candle series
// ─────────────────────────────────────────────

function detectStructure(candles: Candle[]): string {
  if (candles.length < 10) return 'Insufficient data';

  const recent = candles.slice(-20);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

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

  if (higherHighs && higherLows) return 'Uptrend — higher highs and higher lows';
  if (lowerHighs && lowerLows) return 'Downtrend — lower highs and lower lows';
  if (higherHighs && lowerLows) return 'Expanding range — increasing volatility';
  if (lowerHighs && higherLows) return 'Contracting range — compression, breakout likely';
  return 'Ranging — no clear directional structure';
}

// ─────────────────────────────────────────────
// Describe the most recent candle pattern
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

  if (upperRatio > 0.6) return 'Shooting star / upper wick rejection — bearish signal';
  if (lowerRatio > 0.6) return 'Hammer / lower wick rejection — bullish signal';
  if (bodyRatio < 0.2) return 'Doji / spinning top — indecision';

  // Engulfing patterns
  if (prev) {
    const prevBody = Math.abs(prev.close - prev.open);
    const prevBull = prev.close > prev.open;
    if (
      isBull && !prevBull &&
      candle.close > prev.open &&
      candle.open < prev.close
    ) return 'Bullish engulfing — strong reversal signal';
    if (
      !isBull && prevBull &&
      candle.close < prev.open &&
      candle.open > prev.close
    ) return 'Bearish engulfing — strong reversal signal';
  }

  return isBull
    ? `Bullish candle (${(bodyRatio * 100).toFixed(0)}% body)`
    : `Bearish candle (${(bodyRatio * 100).toFixed(0)}% body)`;
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