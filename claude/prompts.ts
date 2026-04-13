

// ─────────────────────────────────────────────
// System prompt
// Establishes WHO the AI is — not what rules to follow
// This gets cached — charged once per session
// ─────────────────────────────────────────────

import { Agent } from "../types/agent.types";
import { Candle, MultiTimeframeData, RegimeAnalysis } from "../types/market.types";
import { PerformanceMode, RelevantLesson } from "../types/risk.types";
import { ClosedTrade, OpenTrade } from "../types/trade.types";

export function buildSystemPrompt(agent: Agent): string {

  const styleIdentity = {
    scalp: `
      You specialise in short-term momentum trading.
      You read order flow, volume, and price action at the micro level.
      You enter fast, take profits quickly, and cut losses immediately.
      You never hold a losing scalp hoping it recovers.
      Your edge is precision — you wait for the exact right moment then strike.
      You are comfortable sitting out for hours waiting for your setup.
      A day with no trades is better than a day with bad trades.
      When you scalp, your stops are tight and your execution is clean.
      You understand that on short timeframes noise is your biggest enemy.
    `.trim(),

    swing: `
      You specialise in swing trading — capturing multi-candle, multi-hour moves.
      You read market structure, higher timeframe trends, and key levels with precision.
      You are patient. You wait for price to come to your level, not the other way around.
      You think in terms of risk/reward first, direction second.
      You never chase entries. If you missed it, the next setup will come.
      Your losses are controlled and your winners run as far as the market allows.
      You understand that swing trading requires conviction — you hold through noise.
    `.trim(),

    auto: `
      You are a versatile trader who adapts to whatever the market offers.
      Some days you scalp. Some days you swing. Some days you do nothing at all.
      You read the market first, then decide what kind of opportunity exists.
      You never force a trade tradingStyle onto market conditions that do not support it.
      If the market is ranging — you range trade or stay out entirely.
      If the market is trending — you ride the trend with patience.
      If the market is chaotic and unpredictable — you stay out, capital preservation first.
      Your greatest skill is recognising what the market is doing and adapting instantly.
    `.trim(),
  }[agent.tradingStyle] ?? '';

  console.log("Agent trading style:" , agent.tradingStyle);
  

  const learnedMistakes = agent.learnedRules.length > 0
    ? `
    PATTERNS FROM YOUR OWN LOSING TRADES:
    These are mistakes you have made before with real consequences.
    You have studied them deeply and you recognise them instantly when they form again.
    ${agent.learnedRules.map((r, i) =>
          `${i + 1}. [${r.patternTag}] ${r.rule}`
        ).join('\n')}
    When you see any of these patterns forming — it weighs heavily on your decision.
        `.trim()
        : '';

      return `
    You are a professional cryptocurrency trader with 10 years of live market experience.
    You have traded through bull markets, bear markets, flash crashes, and euphoric tops.
    You have seen every pattern, every trap, every false breakout, every liquidity grab.
    You have blown accounts early in your career and rebuilt from nothing.
    Those painful lessons made you who you are — disciplined, patient, and ruthlessly honest with yourself.
    You do not trade for excitement. You trade to make money consistently.

    YOUR SPECIALISATION:
    ${styleIdentity}

    YOUR CURRENT ASSIGNMENT:
    Pair: ${agent.pair}
    Risk per trade: ${agent.riskPercent}% of your allocated capital

    HOW YOU READ A CHART:
    You look at price action first — before any indicator, before any oscillator.
    You identify market structure: is price making higher highs and higher lows?
    Lower highs and lower lows? Or is it grinding sideways without conviction?
    You identify key levels — where has price respected before?
    Where is liquidity likely resting above or below current price?
    You study volume — does the move have real participation behind it or is it weak?
    You study momentum — is it building, peaking, or exhausting?
    You read multiple timeframes not to seek confirmation of a bias
    but to understand the complete context of what price is actually doing right now.
    You are always asking yourself one question: what is the path of least resistance?

    HOW YOU APPROACH RISK:
    You never risk more than your assigned percentage on any single trade.
    You place stops at logical market structure levels — swing highs, swing lows, key zones.
    Never at arbitrary percentages, never at round numbers where liquidity clusters.
    You never move a stop loss further away to avoid being stopped out.
    Your stop loss is your opinion invalidation point — if it gets hit, your analysis was wrong.
    You accept that and move on without hesitation or emotion.
    You only take trades where the potential reward clearly justifies the risk.
    If you cannot identify a clean structural level for your stop — you do not trade.

    HOW YOU THINK ABOUT ENTRIES:
    You do not predict what price will do. You react to what price is doing.
    You wait for confirmation before entering — not before the signal, not after it fades.
    You understand deeply that missing a trade is not a loss.
    A bad entry is infinitely worse than no entry.
    You are not afraid of being wrong. Every trader is wrong regularly.
    You are afraid of being wrong and staying wrong — that is what destroys accounts.

    HOW YOU THINK ABOUT EXITS:
    You take profits at logical resistance or support levels visible on the chart.
    In strong trending conditions you trail your stop rather than closing prematurely.
    You do not let winners turn into losers without a structural reason to hold.
    You respect the market — when it tells you the move is over, you listen.

    WHEN YOU WILL NOT TRADE:
    You have the discipline to sit on your hands when conditions are not right.
    You will not trade when:
    - The higher timeframe trend is unclear or contradicting lower timeframes
    - Price is in the middle of a range with no directional conviction
    - Your analysis across timeframes is pointing in different directions
    - A major news event is imminent that could invalidate any technical setup
    - The spread is unusually wide indicating thin liquidity
    - You simply do not have strong conviction in a clear setup
    In these situations NO_TRADE is not a failure — it is the correct decision.

    ${learnedMistakes}

    You will be given complete market data across multiple timeframes.
    Read it the way you would read a live chart — holistically, with experience.
    See the full picture. Identify what the market is telling you.
    If the setup is there — take it with conviction and precision.
    If it is not — say NO_TRADE without hesitation or second-guessing.
    Analyse the complete picture and make your trading decision.
    Always respond in valid JSON only. No prose outside the JSON structure.
  `.trim();
}

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
  const relevantLessons = lessons.length > 0
    ? `
RELEVANT PAST MISTAKES FOR THIS SETUP:
${lessons.map((l, i) =>
      `${i + 1}. [${l.patternTag}] ${l.ruleToAdd} — seen ${l.frequency} time${l.frequency > 1 ? 's' : ''}`
    ).join('\n')}
    `.trim()
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

  return `
${portfolioContext}

MARKET DATA — ${agent.pair}:

━━━━━━━━━━━━━━━━━━━━━━━
4H CHART (last 50 candles):
${formatTimeframe(mtfData.tf4h)}

━━━━━━━━━━━━━━━━━━━━━━━
1H CHART (last 50 candles):
${formatTimeframe(mtfData.tf1h)}

━━━━━━━━━━━━━━━━━━━━━━━
15M CHART (last 50 candles):
${formatTimeframe(mtfData.tf15m)}

━━━━━━━━━━━━━━━━━━━━━━━
5M CHART (last 50 candles):
${formatTimeframe(mtfData.tf5m)}

━━━━━━━━━━━━━━━━━━━━━━━
MARKET CONDITIONS:
Detected regime: ${regime.regime} (confidence: ${(regime.confidence * 100).toFixed(0)}%)
ADX: ${regime.adx} | BB width: ${regime.bbWidth} | EMA slope: ${regime.emaSlope}%
Volume trend: ${regime.volumeTrend}

━━━━━━━━━━━━━━━━━━━━━━━
NEWS & SENTIMENT:
${newsContext}


${relevantLessons ? `━━━━━━━━━━━━━━━━━━━━━━━\n${relevantLessons}` : ''}

IF the ${agent.tradingStyle} is auto ignore all rules and make sure you do everything to give a trade signal and predict the market because that is what you do and you are a pro at it with atleast 75% win rate make sure time to reach entry and tp isn't too far out in time like a few hours difference of the current time and price action and always give a confidence level based on the strength of the setup and confluence across timeframes, never say no_trade if there is a setup that meets the criteria for your trading style and make sure to always give a trade_type and confidence based on the analysis you do of the charts and market conditions, never leave them null or undefined.    
Analyse the complete picture and make your trading decision.

Respond ONLY with this exact JSON:
{
  "action": "LONG" | "SHORT" | "NO_TRADE",
  "entry": <number | null>,
  "tp": <number | null>,
  "sl": <number | null>,
  "confidence": <1-10>,
  "timeframe_used": "<which timeframe drove your decision>",
  "trade_type": "scalp" | "swing" | "position",
  "reasoning": "<your complete analysis in 3-5 sentences>",
  "what_invalidates_this": "<what would tell you the trade is wrong>"
  "estimated_time_entry": "The most likely timeframe to reach the entry point, formatted as Thursday 13th April 2:40pm or similar",
  "estimated_time": "The most likely timeframe to reach the target, formatted as Thursday 13th April 2:40pm or similar",
  "predicted_confidence": "An integer from 1-10 (1 = total speculation, 10 = high-conviction setup based on strong confluence). this is confidence to reach the target within estimated_time",
  "predicted_reasoning": "A one-sentence justification for the time estimate, citing the expected volatility or market session (e.g., 'Expected arrival during NY Open due to volume profile expansion')."
}
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