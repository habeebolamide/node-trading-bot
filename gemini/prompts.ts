

// ─────────────────────────────────────────────
// System prompt — injected into every Claude call
// This is cached — only charged once per session
// Keep rules clear and unambiguous
// ─────────────────────────────────────────────

import { formatRegimeForPrompt } from "../markets/regime";
import { Agent, LearnedRule } from "../types/agent.types";
import { MultiTimeframeData, RegimeAnalysis } from "../types/market.types";
import { PerformanceMode, RelevantLesson } from "../types/risk.types";
import { ClosedTrade, OpenTrade } from "../types/trade.types";

export function buildSystemPrompt(agent: any): string {
  const learnedRulesText = agent.learnedRules.length > 0
    ? `
LEARNED RULES FROM PAST LOSSES (auto-generated — follow strictly):
${agent.learnedRules.map((r: any, i: number) => `${i + 1}. [${r.patternTag}] ${r.rule}`).join('\n')}
`
    : '';

  return `
You are an autonomous cryptocurrency trading agent.
Your job is to analyse market data and make precise trading decisions.

IDENTITY:
- Agent name: ${agent.name}
- Trading pair: ${agent.pair}
- Trading style: ${agent.style}
- Risk per trade: ${agent.riskPercent}% of allocated capital

CORE RULES — NON-NEGOTIABLE:
1. Never trade against the dominant 4h/Daily trend under any circumstance
2. Never enter a trade with confidence below 7 out of 10
3. Never set a stop loss further than 3% from entry
4. Never widen a stop loss once a trade is open — only tighten
5. Always respond in valid JSON — no prose, no markdown, no explanation outside JSON
6. If you are uncertain — return NO_TRADE. Patience is a position.
7. Never chase a move — if the entry price has passed, skip the trade

TIMEFRAME SCORING GUIDE:
Score each timeframe from -2 to +2:
+2 = strongly bullish structure
+1 = mildly bullish
 0 = neutral / unclear
-1 = mildly bearish
-2 = strongly bearish

Total score interpretation:
+4 to +6  → Strong LONG signal
+1 to +3  → Weak LONG — reduce size or skip
-1 to +1  → NO_TRADE — conflicting signals
-2 to -3  → Weak SHORT — reduce size or skip
-4 to -6  → Strong SHORT signal

STOP LOSS PLACEMENT:
- Use ATR-based placement: SL = entry ± (ATR × 1.5)
- Always place SL beyond a structural level (swing high/low)
- Never place SL at a round number where liquidity clusters

TAKE PROFIT PLACEMENT:
- Target next significant resistance (LONG) or support (SHORT)
- Minimum risk/reward ratio: 1.5 — if you cannot achieve 1.5 RR, skip the trade
- In strong trends extend TP to next major level

${learnedRulesText}
`.trim();
}

// ─────────────────────────────────────────────
// Entry prompt — agent is IDLE, looking for trade
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
  const lessonsText = lessons.length > 0
    ? `
RELEVANT LESSONS FROM PAST LOSSES:
${lessons.map((l, i) => `${i + 1}. [${l.patternTag}] ${l.ruleToAdd} (seen ${l.frequency}x)`).join('\n')}
Check if current setup matches any of these before deciding.
`
    : '';

  const performanceContext = buildPerformanceContext(monthlyPnl, performanceMode);

  return `
${formatRegimeForPrompt(regime)}

MULTI-TIMEFRAME ANALYSIS:

4H (trend / big picture):
${formatTimeframe(mtfData.tf4h)}

1H (momentum / confirmation):
${formatTimeframe(mtfData.tf1h)}

15M (entry timing):
${formatTimeframe(mtfData.tf15m)}

5M (precise entry):
${formatTimeframe(mtfData.tf5m)}

NEWS CONTEXT:
${newsContext}

${lessonsText}
${performanceContext}

Based on ALL timeframes, decide whether to enter a trade.

Respond ONLY with this exact JSON structure:
{
  "action": "LONG" | "SHORT" | "NO_TRADE",
  "entry": <number | null>,
  "tp": <number | null>,
  "sl": <number | null>,
  "confidence": <1-10>,
  "timeframeScores": {
    "tf4h": <-2 to 2>,
    "tf1h": <-2 to 2>,
    "tf15m": <-2 to 2>,
    "tf5m": <-2 to 2>,
    "total": <sum>
  },
  "regimeConfirmed": "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "VOLATILE" | "NEUTRAL",
  "regimeOverride": <true | false>,
  "regimeReasoning": "<one sentence>",
  "primaryTimeframe": "<which TF drove the decision>",
  "entryTrigger": "<what specific thing triggered this signal>",
  "reasoning": "<2-3 sentences explaining the full setup>",
  "lessonsApplied": ["<lesson tag if relevant>"]
}
`.trim();
}

// ─────────────────────────────────────────────
// Management prompt — agent is IN_TRADE
// Called every significant candle
// ─────────────────────────────────────────────

export function buildManagementPrompt(
  agent: Agent,
  trade: OpenTrade,
  mtfData: MultiTimeframeData,
  newsContext: string,
): string {
  const pnlSign = trade.unrealisedPct >= 0 ? '+' : '';
  const duration = getHoursSince(trade.openedAt);

  return `
You are managing an open ${trade.direction} trade on ${trade.pair}.

OPEN POSITION:
- Direction: ${trade.direction}
- Entry: ${trade.entryPrice}
- Current price: ${mtfData.tf5m.candles.at(-1)?.close ?? 'unknown'}
- Current TP: ${trade.currentTp}
- Current SL: ${trade.currentSl}
- Unrealised P&L: ${pnlSign}${trade.unrealisedPct}% (${pnlSign}$${trade.unrealisedPnl.toFixed(2)})
- Time in trade: ${duration} hours
- Original reasoning: "${trade.entryReasoning}"

CURRENT MARKET:

1H (primary management timeframe):
${formatTimeframe(mtfData.tf1h)}

15M (short term structure):
${formatTimeframe(mtfData.tf15m)}

4H (is the big trend still intact?):
${formatTimeframe(mtfData.tf4h)}

NEWS:
${newsContext}

MANAGEMENT RULES:
- Never move SL further from entry — only tighten
- If unrealised P&L > 1.5% — move SL to at least breakeven
- If unrealised P&L > 3% — trail SL to lock in at least 1%
- If original trend thesis is invalidated — close immediately
- If high-impact negative news appeared — tighten SL or close

Decide what to do with this trade.

Respond ONLY with this exact JSON structure:
{
  "action": "HOLD" | "ADJUST" | "CLOSE" | "PARTIAL_CLOSE",
  "newTp": <number | null>,
  "newSl": <number | null>,
  "closePercent": <0-100 | null>,
  "reasoning": "<1-2 sentences>",
  "urgency": "low" | "medium" | "high"
}
`.trim();
}

// ─────────────────────────────────────────────
// Post-mortem prompt — called after every loss
// ─────────────────────────────────────────────

export function buildPostMortemPrompt(
  trade: ClosedTrade,
  regimeAtEntry: string,
  newsAtEntry: string,
  rsiAtEntry: number,
  volumeRatioAtEntry: number,
): string {
  return `
A trade closed at a loss. Analyse it thoroughly.

TRADE DETAILS:
- Pair: ${trade.pair}
- Direction: ${trade.direction}
- Entry: ${trade.entryPrice} → Exit: ${trade.exitPrice}
- Loss: ${trade.realisedPct.toFixed(2)}%
- Duration: ${trade.durationHours.toFixed(1)} hours
- Close reason: ${trade.closeReason}
- Original reasoning: "${trade.entryReasoning}"

CONDITIONS AT ENTRY:
- Market regime: ${regimeAtEntry}
- RSI at entry: ${rsiAtEntry}
- Volume ratio: ${volumeRatioAtEntry}x average
- News at entry: ${newsAtEntry}

Identify what went wrong.

Respond ONLY with this exact JSON structure:
{
  "primaryReason": "<one clear sentence — the main cause of loss>",
  "warningSigns": ["<sign 1>", "<sign 2>", "<sign 3>"],
  "patternTag": "<SCREAMING_SNAKE_CASE tag e.g. COUNTER_TREND_ENTRY>",
  "ruleToAdd": "<specific, actionable rule to avoid this in future>",
  "verdict": "bad_trade" | "bad_luck" | "bad_management",
  "marketRegime": "<regime at time of loss>",
  "avoidable": <true | false>
}
`.trim();
}

// ─────────────────────────────────────────────
// Lesson synthesis prompt
// Run weekly to compress lessons into rules
// ─────────────────────────────────────────────

export function buildSynthesisPrompt(lessons: any[]): string {
  return `
You have accumulated ${lessons.length} trading lessons from past losses.
Synthesise them into the top 5 most impactful recurring patterns.

LESSONS:
${JSON.stringify(lessons, null, 2)}

For each pattern write one clear, specific, actionable avoidance rule.
Vague rules are useless. Be precise.

Respond ONLY with this exact JSON structure:
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
// Helpers
// ─────────────────────────────────────────────

function formatTimeframe(tf: MultiTimeframeData['tf4h']): string {
  const latest = tf.candles.at(-1);
  const prev = tf.candles.at(-2);
  const ind = tf.indicators;

  if (!latest || !ind) return 'Insufficient data';

  const priceVsEma20 = latest.close > ind.ema20 ? 'above' : 'below';
  const priceVsEma50 = latest.close > ind.ema50 ? 'above' : 'below';
  const candleDir = latest.close >= (prev?.close ?? latest.close) ? '▲' : '▼';

  return `
- Price: ${latest.close} ${candleDir}
- vs EMA20: ${priceVsEma20} (${ind.ema20}) | vs EMA50: ${priceVsEma50} (${ind.ema50})
- RSI: ${ind.rsi} | MACD histogram: ${ind.macd.histogram}
- Volume: ${ind.volume.ratio}x avg (${ind.volume.trend})
- BB width: ${ind.bollinger.width} | ATR: ${ind.atr}
`.trim();
}

function buildPerformanceContext(
  monthlyPnl: number,
  performanceMode: PerformanceMode,
): string {
  const sign = monthlyPnl >= 0 ? '+' : '';

  const modeInstructions: Record<PerformanceMode, string> = {
    NORMAL: 'Standard operation — target 5% floor.',
    GROWTH: 'Floor achieved. Prioritise trailing stops and letting winners run. No need to chase new setups aggressively.',
    CONSERVATIVE: 'Approaching drawdown cap. Only take setups with confidence 8+. Reduce aggression.',
    RECOVERY: 'In drawdown. Capital preservation is the priority. Only A+ setups. Confidence must be 9+ to enter.',
  };

  return `
MONTHLY PERFORMANCE:
- Month P&L so far: ${sign}${monthlyPnl.toFixed(2)}%
- Current mode: ${performanceMode}
- Instruction: ${modeInstructions[performanceMode]}
`.trim();
}

function getHoursSince(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = ms / (1000 * 60 * 60);
  return hours < 1
    ? `${Math.round(hours * 60)}m`
    : `${hours.toFixed(1)}h`;
}