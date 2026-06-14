import type { Agent } from '../types/agent.types.js';
import type {
  Candle,
  MultiTimeframeData,
  RegimeAnalysis
} from '../types/market.types.js';
import type {
  PerformanceMode,
  RelevantLesson
} from '../types/risk.types.js';
import type {
  ClosedTrade,
  OpenTrade
} from '../types/trade.types.js';
import type { ChallengeRiskContext } from '../types/challenge.types.js';
import {
  findKeyLevels,
  formatKeyLevelsForPrompt,
  findConfluenceZones,
  formatConfluenceZonesForPrompt,
  type KeyLevelsResult,
} from "../markets/keys.js";
import { getLotSpec } from '../risk/index.js';

// ─────────────────────────────────────────────
// TEST MODE FLAG
// Set to true to force LONG/SHORT signals
// Remove entirely when going live
// ─────────────────────────────────────────────


// ─────────────────────────────────────────────
// Stable principles — kept identical across all agents and calls.
// Anthropic prompt caching requires ≥1024 tokens of stable content;
// this block guarantees the system prompt clears that threshold from day one.
// ─────────────────────────────────────────────

const CORE_PRINCIPLES = `
━━━━━━━━━━━━━━━━━━━━━━━
CORE PRINCIPLES — guidance, not handcuffs:

These shape how you think. They are not boxes to tick.
When the market gives a clear opportunity that breaks one of the defaults,
you may still take it — say why in your reasoning. Blindly following rules
misses more good trades than it saves bad ones. Use judgment.

ABSOLUTE — these two never bend:
  Never widen a stop loss once a trade is live. Tighten only.
  Never add to a losing position. If the thesis breaks, exit clean.

DEFAULT (override with reason, not impulse):

Risk-to-reward — favor setups offering at least:
  ~1.0R for scalps (high win-rate, tight structure)
  ~1.2R for day trades (intraday structure, flat by session end)
  ~1.5R for swings
  ~2.0R for position trades
A thinner R/R is acceptable when the setup is exceptionally clean — but never stretch
the TP just to hit a ratio. Structure decides the target, not arithmetic.

R/R is the ratio; leverage and SL distance together produce the absolute %
impact. A 1.5R win on a 0.1% stop at 25× ≈ 3.75% margin ROI; same R/R on a
1.0% stop at 25× ≈ 37.5%. Same ratio, ten times the impact. Structure still
picks the stop; absolute impact tells you whether a win meaningfully moves
your capital.

Setup selection (above the R/R + confidence floors):

  TARGET ≥100% margin ROI per win — that's the goal. Compounds fastest and
  pays for the API cost of running. Achievable on most clean trades given
  the leverage you have; do the math (price_move_% × leverage).

  PREFER HIGH-GRADE setups at any ROI tier — clean structure, fresh level,
  good timeframe alignment, honest confidence ≥7. A high-grade 60% setup
  beats a mediocre 100% one. Quality first, magnitude second.

  Take DECENT (50–80% margin ROI) when quality is strong and nothing
  100%+ is currently in front of you — don't sit out a clean A-grade
  setup waiting for a unicorn.

  AVOID LOW (<40% margin ROI) unless the setup is exceptionally clean AND
  nothing higher-impact is available. Management can extend TP to the next
  structural level if the trade runs, turning a 30% entry into 80%+.

  NO_TRADE when nothing reasonable exists. Don't force trades. Burning an
  LLM call on NO_TRADE is cheaper than burning a trade on a marginal setup.

Timeframe alignment — when 4H and lower-TF momentum agree, you have a tailwind.
When they diverge, ask which kind of divergence this is:
  Pullback INTO HTF support or resistance — one of the highest-probability setups
  there is. The LTF "conflict" is the entry trigger, not a reason to skip.
  Counter-trend bet AGAINST a strong 4H trend — this is what to be skeptical of.
Do not treat all divergence as a no-go.

News proximity — within 30 minutes of a known high-impact event,
the technical read is more often invalidated than confirmed.
Raise your bar. Not a hard no — just lean stricter and trust structure less.

Structural levels — anchor every price to something visible:
swing high, swing low, prior reaction zone, volume node, or a round number
that has been historically respected. Pure round numbers without history are weak.

Honest confidence — your confidence is a probability assessment.
Do not inflate it to act. Do not deflate it from over-caution.
Use it to size and weigh the decision — not as a wall to clear.
━━━━━━━━━━━━━━━━━━━━━━━
`.trim();

// ─────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────

export function buildSystemPrompt(
  agent: Agent,
  challenge?: ChallengeRiskContext,
): string {

  const styleGuide = {
    scalp: `
      You trade short-term momentum off the 1m and 5m, using 15m only for
      immediate context. Trades are fast — typically 5–10 minutes, never hours.
      You look for quick, high-probability moves with tight stops and clear
      targets, entering close to current price or at immediate 1m/5m structure.
      Because stops are tight, you run high leverage — a small price move is a
      large margin ROI, so precision on entry and exit timing is everything.
      If the move doesn't resolve quickly, get out; do not let a scalp turn into
      a bag-hold.
    `.trim(),

    day: `
      You trade intraday moves. Trades last a few hours and you close them out
      within the same trading day — you do NOT hold overnight. You trade with
      the intraday trend off the 15m/1h, timing entries on the 5m at a key level
      or on a clean momentum break. Targets are the next intraday structural
      level; stops sit behind the level that frames the day's range. If a setup
      can't reasonably resolve before the session winds down, skip it.
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
      You adapt to whatever the market is offering. Pick the style that fits
      the current structure — never force a style onto conditions that don't
      support it. Stay out if nothing aligns.

      SCALP — fast, 1-20 minutes (never hours). Use when 1m/5m momentum is clean:
        1m/5m trend with volume, tight range break, or a clear reaction off a fresh
        level (15m for immediate context only). Tight stops with high leverage so a
        small move is a large margin ROI, R/R ≥ 1.0, entry close to current price.
        Best in low-news, mid-volatility tape. If it doesn't resolve fast, exit.

      DAY — a few hours, closed within the session (no overnight hold). Use when
        the 15m/1h shows a defined intraday trend or range you can work, timing
        entry on the 5m at an intraday level. R/R ≥ 1.2, stop behind the level
        framing the day's range, TP at the next intraday structural level. Best
        when there's a clean intraday read but not a multi-day thesis.

      SWING — hours. Use when 1h/4h structure is intact and you
        can wait for a pullback to a key level (prior swing, demand/supply zone,
        VWAP, round number). Wider stops, R/R ≥ 1.5, entry usually a limit at
        the level — not market. Best when trend is defined but extended, and a
        retrace is reasonable. Let the next structural level set the TP — if
        that gives you R/R 4+, take it.

      Decision rule: match the style to the dominant timeframe showing the
      cleanest structure. If the 5m is clean and fast — scalp. If the 15m/1h
      frames a trend you can work and exit the same day — day. If the 5m is
      noisy but 1h/4h structure invites holding through noise — swing. If
      everything is choppy — NO_TRADE. Emit the chosen style in tradeStyle
      so the server clamps entry expiry correctly.
    `.trim(),
  }[agent.tradingStyle ?? 'auto'] ?? '';

  // Leverage and risk model live here in the system prompt — they're
  // agent-stable for the duration of a session, and the LLM reads them
  // alongside its identity rather than as ephemeral per-call data.
  const leverage = agent.leverage ?? 10;
  const riskPct  = agent.riskPercent;
  const riskClause = challenge
    ? `Risk model (challenge — nested cap):
        ALLOCATION per trade: ${(challenge.maxMarginPct * 100).toFixed(0)}% of bucket = $${(challenge.equity * challenge.maxMarginPct).toFixed(2)} of margin.
        MAX risk per trade: ${challenge.riskPercent}% of that margin allocation.
        These are CEILINGS the bot enforces, not budgets to spend. Place your stop where the thesis breaks (structural). If the structural stop risks less than the ceiling, the trade is smaller and that is correct.
        NEVER widen a stop to "use up" the risk budget — that's the fastest way to blow the bucket.`
    : `Risk model:
        The bot caps loss per trade at ${riskPct}% of the margin used for THAT trade (a ratio, not a dollar budget — you don't need to know the account size to use this).
        How the bot sizes positions:
          - You pick SL by STRUCTURE. The bot computes position size automatically so that loss-if-SL-hits ≤ ${riskPct}% of margin.
          - Tighter SL → bot can use larger position for the same loss cap. Wider SL → bot scales position DOWN to keep loss inside the cap.
          - If structural SL is so wide that the scaled-down position falls below the exchange minimum lot, the trade is rejected. Don't narrow SL just to fit — return NO_TRADE with low confidence instead.
        NEVER widen a stop to "use up" risk budget — wider stop = bigger loss when wrong, every time. Structure decides SL; the bot decides size.`;

  const challengeBlock = challenge ? buildChallengeBlock(challenge) : '';


  return `
    You trade crypto on your own judgment. You read the market, find real
    setups, and pull the trigger when the read is clean.

    You are not here to print signals — you are here to trade. You know your
    edge and you wait for it. When the setup shows up, you take it. When
    nothing is there, you sit on your hands. Forcing a trade costs you just
    as much as missing one.
    
    YOUR APPROACH:
    ${styleGuide}
    
    YOUR ASSIGNMENT:
    Pair: ${agent.pair}
    Leverage: ${leverage}x 
    ${riskClause}

    ${challengeBlock}

    ${CORE_PRINCIPLES}

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

    Triggers tell the system when to re-evaluate AHEAD of the next candle close.
    They are ONLY USED FOR NO_TRADE decisions — they represent levels where a
    setup could begin to form, prompting a fresh look. Must be structural,
    not arbitrary distances.

    price_up = the nearest resistance above current price where a break
    would prompt a fresh look (a setup might appear).

    price_down = the nearest support below current price where a break
    would prompt a fresh look (a setup might appear).

    timeout_minutes = how long this NO_TRADE context stays valid before
    fresh re-analysis is needed.

    For LONG / SHORT signals: triggers are not used. The bot waits for your
    entry price to be hit (or expiry to elapse), then management runs on
    each significant candle close. Just set price_up/price_down to null and
    do not over-think these fields for directional signals.

    CONFIDENCE:

    Confidence is a probability assessment, not a permission slip. Be honest:
      8–10 = high conviction. Clean structure, aligned momentum, clear invalidation.
      6–7  = decent setup with material uncertainty. Tradeable if R/R compensates.
      <6   = thesis is genuinely unclear. NO_TRADE.

    Above the floor: think in expected value. A clean 7 with 2.0R potential
    is a better trade than an 8 with 1.2R. Do NOT inflate confidence to
    clear a threshold, do NOT deflate it from over-caution.

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
  const currentPrice = mtfData.tf1m.candles.at(-1)?.close
    ?? mtfData.tf5m.candles.at(-1)?.close
    ?? mtfData.tf15m.candles.at(-1)?.close
    ?? mtfData.tf1h.candles.at(-1)?.close
    ?? 0;

  const atr1h = mtfData.tf1h.indicators?.atr?.toFixed(5) ?? 'unknown';

  // Performance mode + the actual auto-reject floors the risk layer enforces
  // for this mode. Surfaced so the LLM never returns a signal that's
  // mathematically certain to get bounced. Numbers must stay in sync with
  // risk/index.ts (MIN_RR_BY_MODE, MIN_CONFIDENCE_BY_MODE, LIMITS).
  const modeDescriptions: Record<PerformanceMode, string> = {
    NORMAL:       'Standard operation. Trade good setups as they appear.',
    GROWTH:       'Monthly floor achieved. Let winners run; selectivity unchanged.',
    CONSERVATIVE: 'Approaching monthly drawdown cap. Tighten up — fewer trades, higher quality.',
    RECOVERY:     'In drawdown. Capital preservation first. Only A+ setups.',
  };
  const modeFloors: Record<PerformanceMode, { confidence: number; rr: number }> = {
    NORMAL:       { confidence: 6.0, rr: 1.0 },
    GROWTH:       { confidence: 6.0, rr: 1.0 },
    CONSERVATIVE: { confidence: 6.5, rr: 1.8 },
    RECOVERY:     { confidence: 7.0, rr: 2.5 },
  };
  const floors = modeFloors[performanceMode];

  const modeLabel =
    `Performance mode: ${performanceMode} | Monthly P&L: ${monthlyPnl >= 0 ? '+' : ''}${monthlyPnl.toFixed(2)}%\n` +
    `    ${modeDescriptions[performanceMode]}\n` +
    `    AUTO-REJECT FLOORS (this mode): confidence < ${floors.confidence} OR R/R < ${floors.rr.toFixed(1)} → rejected by risk layer before reaching the market.`;

  // Leverage / risk / challenge block all live in the system prompt now —
  // the entry prompt focuses on per-candle market state only.

  const relevantLessons = lessons.length > 0
    ? `
  ━━━━━━━━━━━━━━━━━━━━━━━
  PAST MISTAKES MATCHING THIS SETUP:
  ${lessons.map((l, i) =>
      `${i + 1}. [${l.patternTag}] ${l.ruleToAdd} — occurred ${l.frequency}x`
    ).join('\n')}
    `.trim()
    : '';

  // Per-style key-level coverage. Scalps need intraday levels because they're
  // operating on 5m/15m structure; position trades only need the macro view.
  // Daily levels would be added here once we seed Daily candles.
  const style = agent.tradingStyle ?? 'auto';
  const includeTfs: Array<'1m' | '5m' | '15m' | '1h' | '4h'> = (
    style === 'scalp' ? ['1m', '5m', '15m'] :   // minutes-long (5–10 min): pure micro-structure on 1m/5m, 15m for immediate context
      style === 'day' ? ['5m', '15m', '1h', '4h'] :   // intraday: time entries on 5m, work 15m/1h, 4h frames the day's range/trend
        style === 'swing' ? ['15m', '1h', '4h'] :
          style === 'position' ? ['1h', '4h'] :
            ['1m', '5m', '15m', '1h', '4h']    // auto: full coverage incl. 1m for scalp-style adaptation
  );

  const levelBlocks: string[] = [];

  if (includeTfs.includes('1m')) {
    // 1m is the noisiest feed — keep only the strongest structural levels, top 3
    // per side, and drop round numbers (meaningless at this resolution). Use for
    // pinpoint scalp entry/exit timing, not for framing the trade thesis.
    const raw = findKeyLevels(mtfData.tf1m.candles);
    const trimmed = trimLevels(raw, 3, ['round_number']);
    levelBlocks.push(`━━━━━━━━━━━━━━━━━━━━━━━
    SCALP LEVELS — 1M (top 3, structural only — entry/exit timing):
    ${formatKeyLevelsForPrompt(trimmed)}`);
  }

  if (includeTfs.includes('5m')) {
    // 5m has the most noise — filter to swing/volume_node only, top 3 per side.
    // Round-number levels at this resolution are usually meaningless.
    const raw = findKeyLevels(mtfData.tf5m.candles);
    const trimmed = trimLevels(raw, 3, ['round_number']);
    levelBlocks.push(`━━━━━━━━━━━━━━━━━━━━━━━
    INTRADAY LEVELS — 5M (top 3, structural only):
    ${formatKeyLevelsForPrompt(trimmed)}`);
  }

  if (includeTfs.includes('15m')) {
    const levels15m = findKeyLevels(mtfData.tf15m.candles);
    levelBlocks.push(`━━━━━━━━━━━━━━━━━━━━━━━
    INTRADAY LEVELS — 15M:
    ${formatKeyLevelsForPrompt(levels15m)}`);
  }

  if (includeTfs.includes('1h')) {
    const levels1h = findKeyLevels(mtfData.tf1h.candles);
    levelBlocks.push(`━━━━━━━━━━━━━━━━━━━━━━━
    KEY LEVELS — 1H:
    ${formatKeyLevelsForPrompt(levels1h)}`);
  }

  if (includeTfs.includes('4h')) {
    const levels4h = findKeyLevels(mtfData.tf4h.candles);
    levelBlocks.push(`━━━━━━━━━━━━━━━━━━━━━━━
    MAJOR LEVELS — 4H:
    ${formatKeyLevelsForPrompt(levels4h)}`);
  }

  // Cross-timeframe confluence — computed from the same timeframes the agent
  // is allowed to see. Surfaced FIRST so the model anchors on the strongest
  // multi-TF structure before reading per-timeframe detail. These survive even
  // when far from spot, which is exactly what a pullback-limit entry needs.
  const tfSnapshots: Record<'1m' | '5m' | '15m' | '1h' | '4h', MultiTimeframeData['tf4h']> = {
    '1m': mtfData.tf1m,
    '5m': mtfData.tf5m,
    '15m': mtfData.tf15m,
    '1h': mtfData.tf1h,
    '4h': mtfData.tf4h,
  };
  const confluenceZones = findConfluenceZones(
    includeTfs.map(tf => ({ tf, candles: tfSnapshots[tf].candles })),
    currentPrice,
  );
  const confluenceBlock = `━━━━━━━━━━━━━━━━━━━━━━━
    CONFLUENCE ZONES (multi-timeframe — strongest structure on the chart):
    ${formatConfluenceZonesForPrompt(confluenceZones, currentPrice)}`;

  const levelsSection = [confluenceBlock, ...levelBlocks].join('\n\n    ');

  // Timeframe read-outs, gated by trade style (same set as the levels above).
  // A scalp shouldn't be reasoning off the 4H; a position trade shouldn't be
  // distracted by 1m noise. Ordered high → low for a top-down read.
  const tfSummaryBlocks: string[] = [];
  const pushTfSummary = (
    key:   '4h' | '1h' | '15m' | '5m' | '1m',
    label: string,
    snap:  MultiTimeframeData['tf4h'],
  ) => {
    if (includeTfs.includes(key)) {
      tfSummaryBlocks.push(`━━━━━━━━━━━━━━━━━━━━━━━
    ${label}:
    ${formatTimeframe(snap)}`);
    }
  };
  pushTfSummary('4h',  '4H',  mtfData.tf4h);
  pushTfSummary('1h',  '1H',  mtfData.tf1h);
  pushTfSummary('15m', '15M', mtfData.tf15m);
  pushTfSummary('5m',  '5M',  mtfData.tf5m);
  pushTfSummary('1m',  '1M',  mtfData.tf1m);
  const tfSummarySection = tfSummaryBlocks.join('\n\n    ');

  // Macro directional anchor — derived ONLY from the 4H, so it stays stable
  // while the lower timeframes (and the REGIME line) chop. The model is told
  // below to anchor its side here and NOT reverse on lower-timeframe noise.
  // Gated to styles that actually look at the 4H — a pure scalp does not.
  const macroBias = includeTfs.includes('4h')
    ? describeMacroBias(mtfData.tf4h)
    : null;
  const macroBiasBlock = macroBias
    ? `━━━━━━━━━━━━━━━━━━━━━━━
    MACRO BIAS (4H — your directional anchor):
    ${macroBias}

    `
    : '';

  return `
    ${modeLabel}
    CURRENT TIME (UTC): ${now}
    CURRENT PRICE: ${currentPrice}
    PAIR: ${agent.pair}
    1H ATR: ${atr1h}

    ${levelsSection}

    ${macroBiasBlock}━━━━━━━━━━━━━━━━━━━━━━━
    REGIME (lower-timeframe momentum — SECONDARY to MACRO BIAS, flips on small moves): ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% confidence)
    ADX: ${regime.adx} | BB width: ${regime.bbWidth} | EMA slope: ${regime.emaSlope}% | Volume: ${regime.volumeTrend}
    
    ${tfSummarySection}

    ━━━━━━━━━━━━━━━━━━━━━━━
    NEWS:
    ${newsContext}
    
    ${relevantLessons}

    ━━━━━━━━━━━━━━━━━━━━━━━
    FIRST — evaluate the pullback-limit option before you may say NO_TRADE:

    A resting limit at a level price has NOT reached yet is a VALID trade, not a
    NO_TRADE. "Nothing is happening at current price right now" / "choppy" /
    "range contraction" are NOT reasons to pass when a strong zone sits nearby —
    that is exactly when you place the limit and wait.

    Before returning NO_TRADE you MUST construct and weigh at least one
    pullback-limit setup from the CONFLUENCE ZONES above:
      1. Pick the nearest strong (≥4★) confluence zone price could realistically
         reach — support for a LONG, resistance for a SHORT.
      2. Build it: entry AT the zone, SL just beyond it (where the zone breaks
         and the thesis is wrong), TP at the next confluence zone / structural
         level in your favour.
      3. Compute R/R and margin ROI (price_move_% × leverage).
      4. Decide. If you REJECT it, your reasoning MUST name the concrete reason
         — e.g. "counter to 4H downtrend, ADX 30, EMA50 overhead" — NOT a vague
         "no clean edge". Reject only for a real reason: poor R/R, a hard fight
         against a strong higher-timeframe trend, or no reachable quality zone.

    This does NOT mean force a trade. A counter-trend limit into a strong 4H
    trend is still a legitimate pass. The point is to actually CONSTRUCT and
    EVALUATE the setup, not skip it because the current candle is quiet.

    ━━━━━━━━━━━━━━━━━━━━━━━
    DIRECTIONAL CONSISTENCY — read before you pick a side:

    The MACRO BIAS (4H) above is your anchor. The REGIME line and the 1m/5m/15m
    structure labels are momentum reads that flip on small moves — a sub-1% wiggle
    can swing them from "uptrend" to "downtrend", or NEUTRAL to TRENDING_BEAR.
    Treat them as timing, NOT as a reason to reverse direction.

    - Do NOT flip LONG↔SHORT unless the 4H structure ITSELF has broken — e.g. the
      4H loses its most recent higher-low and closes below it. A regime-label
      change or a lower-timeframe pullback is NOT a 4H structure break.
    - A pullback AGAINST the 4H trend is a pullback-ENTRY in the 4H direction, not
      a signal to trade the other way. If MACRO BIAS is BULLISH, a dip toward
      support is a LONG opportunity — not a cue to SHORT.
    - Be especially skeptical of a counter-trend trade whose TP sits on the very
      support/resistance the dominant trend would bounce from — you would be
      aiming at the level where the trend reloads against you.
    - If lower-timeframe momentum is against the 4H but price has NOT reached your
      level, the correct action is usually to WAIT — keep the resting limit or
      return NO_TRADE — rather than chase the opposite side.

    BEFORE RESPONDING — sanity checks:

    1. SL placement:
       LONG  → SL strictly BELOW entry. TP strictly ABOVE entry.
       SHORT → SL strictly ABOVE entry. TP strictly BELOW entry.
       Anything else is a mechanical error and will be rejected.

    2. Mode floors (see AUTO-REJECT FLOORS in this prompt):
       Is confidence ≥ the mode floor? Is R/R ≥ the mode floor?
       If either is below the floor — the risk layer auto-rejects regardless
       of how good the setup looks. Pick NO_TRADE rather than waste the cycle.

    3. Above the floor — does confidence × R/R × structure quality give
       genuinely positive expected value? If yes, take it. If no, NO_TRADE.

    4. Would you take this trade with your own money under the conditions
       shown? If you would hesitate, let that show in confidence — not
       necessarily NO_TRADE, but be honest about uncertainty.
    
    Respond ONLY with this exact JSON:
    {
      "action": "LONG" | "SHORT" | "NO_TRADE",
      "entry": <number | null>,
      "tp": <number | null>,
      "sl": <number | null>,
      "confidence": <number 1-10>,
      "timeframe_used": "<timeframe that drove the decision>",
      "tradeStyle": "scalp" | "day" | "swing" | "position",
      "entry_expiry_minutes": <number | null — minutes the LONG/SHORT setup stays valid; null for NO_TRADE>,
      "what_invalidates": "<max 100 chars — concrete level/signal that proves the thesis wrong, not a feeling.>",
      "reasoning": "<max 200 chars — why this trade, right now: the structure + edge.>",
      "triggers": {
        "price_up": <number | null>,
        "price_down": <number | null>,
        "timeout_minutes": <number — minutes this NO_TRADE context stays valid before re-analysis>
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
  originalInvalidation?: string,
): string {
  const pnlSign = trade.unrealisedPct >= 0 ? '+' : '';
  const duration = getTimeSince(trade.openedAt);
  const currentPrice = mtfData.tf1m.candles.at(-1)?.close
    ?? mtfData.tf5m.candles.at(-1)?.close
    ?? trade.entryPrice;

  const inProfit = trade.unrealisedPct >= 0;

  const lot = getLotSpec(trade.pair);
  const isPartialCloseDisabled = trade.positionSize < 2 * lot.minQty;
  const partialCloseStatus = isPartialCloseDisabled
    ? `DISABLED (Position size ${trade.positionSize} is too small to split — minimum order qty is ${lot.minQty} for ${trade.pair}. Any partial close is impossible. You must either HOLD or fully CLOSE.)`
    : `ENABLED (Current size: ${trade.positionSize}, minimum order qty: ${lot.minQty})`;

  return `
    You are managing a LIVE ${trade.direction} position on ${trade.pair} — real money is at risk right now.
    This is not a fresh analysis. You already committed to this trade. Your job is to manage it well,
    not to re-litigate whether you'd take it again.

    POSITION:
    Direction:       ${trade.direction}
    Entry:           ${trade.entryPrice}
    Current price:   ${currentPrice}
    TP:              ${trade.currentTp}
    SL:              ${trade.currentSl}  ← this is your invalidation line; the exchange enforces it automatically
    Unrealised:      ${pnlSign}${trade.unrealisedPct.toFixed(2)}% (${pnlSign}$${trade.unrealisedPnl.toFixed(2)}) — currently ${inProfit ? 'IN PROFIT' : 'IN DRAWDOWN'}
    Duration:        ${duration}
    Original thesis: ${trade.entryReasoning}
    ${originalInvalidation ? `Thesis breaks if:  ${originalInvalidation}` : ''}
    Partial close:   ${partialCloseStatus}

    CURRENT MARKET (every price you reference MUST come from the data below — do not invent levels):
    ━━ 4H — is the original thesis still structurally intact? ━━
    ${formatTimeframe(mtfData.tf4h)}

    ━━ 1H — how is momentum developing? ━━
    ${formatTimeframe(mtfData.tf1h)}

    ━━ 15M — what is price doing right now? ━━
    ${formatTimeframe(mtfData.tf15m)}

    ━━ 5M — near-term momentum into the current move ━━
    ${formatTimeframe(mtfData.tf5m)}

    ━━ 1M — live price action for precise exits (critical for fast scalps) ━━
    ${formatTimeframe(mtfData.tf1m)}

    ━━━━━━━━━━━━━━━━━━━━━━━
    HOW TO DECIDE — work through this in order:

    1. DEFAULT IS HOLD. Most of the time, the correct action is to do nothing and
      let the trade work toward TP or SL. You placed the SL where the thesis breaks
      — trust it. A position being temporarily underwater is NORMAL and is NOT a
      reason to close. Acting without a concrete, data-backed reason is itself a
      mistake — it bleeds edge through fees and bad fills.

    2. CLOSE EARLY when the read has changed — do NOT wait for the SL. The SL at
      ${trade.currentSl} is the hard backstop the exchange enforces for you; by the
      time price prints there it is already too late to add value. A good trader's
      edge is getting out BEFORE the stop, while the exit is still good. CLOSE (or
      PARTIAL_CLOSE) when you can point to REAL evidence in the data that the move is
      turning against you, such as:
        - a reversal forming against your position — e.g. you are ${trade.direction} and the
          lower timeframes are now printing ${trade.direction === 'LONG' ? 'lower highs + lower lows' : 'higher highs + higher lows'},
          or a strong opposite-side rejection / engulfing at a key level
        - momentum has decisively flipped: the timeframe that carried your thesis is
          now driving the other way, ideally with volume confirming the against-side
        - the structure the trade relied on is visibly failing — the level is being
          lost in front of you; you do NOT have to wait for the exact SL price to print
      This is a JUDGEMENT call and the bar is REAL evidence, not a feeling. "Price
      moved against me a bit", a single noisy candle, or fear are NOT reasons. If the
      strongest thing you can say is "it looks weak", HOLD.

    2b. NEAR TP — protect the win. If price has run most of the way to TP and is now
      showing exhaustion or starting to reverse (rejection wick, stalling momentum,
      opposite-side pressure building), do not give the gains back chasing the last
      few ticks. PARTIAL_CLOSE to bank the bulk of it, or CLOSE outright if the
      reversal looks convincing. Round-tripping a near-winner back to break-even is a
      worse outcome than taking most of the target.

    3. IF IN PROFIT — protect and extend:
      - ADJUST: tighten SL toward break-even or behind the most recent ${trade.direction === 'LONG' ? 'swing low' : 'swing high'}
        to lock in gains. Keep the SL a sensible distance back (roughly ≥1× ATR
        from price) so normal noise does not wick you out prematurely.
      - ADJUST: extend TP ONLY if price has cleanly reached the old TP zone AND a
        further structural level genuinely exists beyond it. Otherwise leave TP.
      - PARTIAL_CLOSE: when the move is extended and the next leg is uncertain —
        bank a portion, let the rest ride with a protected stop. ${isPartialCloseDisabled ? 'NOTE: PARTIAL CLOSE IS CURRENTLY DISABLED FOR THIS POSITION SIZE.' : ''}

    4. IF IN DRAWDOWN — be patient, not reactive:
      - The SL already caps the downside. Do NOT close just because you are red —
        being underwater is not a reason. But if the early-exit evidence in step 2 is
        actually there (reversal forming, momentum flipped against you), don't stubbornly
        ride it to the stop either — cut it. Red + real reversal = CLOSE; red + noise = HOLD.
      - NEVER widen the SL. NEVER move it further from price. Tighten only.

    5. Never act just to act. If nothing concrete has changed since entry: HOLD.

    reasoning must name the SPECIFIC level or signal driving the decision (e.g.
    "4H broke 1985 support, structure flipped" — not "looks weak"). If you cannot
    name it, the answer is HOLD.

    JSON response:
    {
      "action": "HOLD" | "ADJUST" | "CLOSE" | "PARTIAL_CLOSE",
      "newTp": <number | null — only when extending/changing TP>,
      "newSl": <number | null — only when tightening SL; must be closer to price than current, never further>,
      "closePercent": <0-100 | null — only for PARTIAL_CLOSE>,
      "reasoning": "<max 100 chars — name the specific level/signal driving the action, not a feeling.>",
      "urgency": "low" | "medium" | "high"
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
Avoid the temptation to blame "the market" — focus on what could have been
seen at entry time.

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

VERDICT GUIDE:
  bad_trade      — the setup itself was flawed; a warning sign was visible at entry.
  bad_luck       — the setup was reasonable; price did something unusual (gap, news flash).
  bad_management — the entry was fine but the stop/sizing/exit handling was wrong.

PATTERN TAG: SCREAMING_SNAKE_CASE describing the failure mode. Examples:
  LONG_INTO_OVERBOUGHT_4H_RSI
  COUNTER_TREND_AGAINST_STRONG_ADX
  ENTERED_WITHIN_30MIN_OF_NEWS
  SHORT_AT_UNCONFIRMED_RESISTANCE

RULE TO ADD: a specific, actionable rule with concrete thresholds.
  Good: "Skip LONG entries when 4H RSI > 75 even if structure supports."
  Bad:  "Be careful with overbought."

Respond ONLY with this exact JSON:
{
  "primaryReason": "<one sentence — the real cause>",
  "warningSigns": ["<warning sign visible at entry>", "<another if applicable, else omit>"],
  "patternTag": "<SCREAMING_SNAKE_CASE — see examples above>",
  "ruleToAdd": "<specific actionable rule with concrete thresholds where possible>",
  "verdict": "bad_trade" | "bad_luck" | "bad_management",
  "avoidable": <true | false>
}
  `.trim();
}

// ─────────────────────────────────────────────
// Synthesis prompt — weekly job
// ─────────────────────────────────────────────

export function buildSynthesisPrompt(lessons: any[]): string {
  // Cap input — without this, ~500 lessons would blow up the prompt.
  // 50 most recent gives plenty of signal for the top-5 pattern detection;
  // older lessons are stale relative to current strategy anyway.
  const SYNTHESIS_MAX_LESSONS = 50;
  const truncated = lessons.length > SYNTHESIS_MAX_LESSONS
    ? lessons.slice(-SYNTHESIS_MAX_LESSONS)
    : lessons;
  const truncationNote = lessons.length > SYNTHESIS_MAX_LESSONS
    ? `\n(Showing ${SYNTHESIS_MAX_LESSONS} most recent of ${lessons.length} total — older lessons omitted.)`
    : '';

  return `
You have ${truncated.length} lessons from losing trades.${truncationNote}
Find the top 5 most damaging recurring patterns.
Write one precise actionable rule per pattern.
Vague rules are worthless.

GOOD rule examples:
  "Skip entries when 4H RSI > 75 and you're going LONG on a pullback."
  "Never short into a 4H uptrend if ADX > 30 on 1H."

BAD rule examples (too vague):
  "Be more careful with overbought conditions."
  "Wait for confirmation before entering."

LESSONS:
${JSON.stringify(truncated, null, 2)}

Respond ONLY with this exact JSON:
{
  "rules": [
    {
      "patternTag": "<SCREAMING_SNAKE_CASE — e.g. LONG_INTO_4H_RSI_OVERBOUGHT>",
      "rule": "<specific actionable rule with concrete thresholds where possible>",
      "frequency": <number of occurrences in the lessons above>
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
// Macro directional bias — the stable anchor the entry prompt is told not to
// fight on lower-timeframe noise. Derived ONLY from the 4H (structure + EMAs),
// reusing the same primitives as formatTimeframe so it never disagrees with the
// 4H block the model also sees. Returns BULLISH / BEARISH / NEUTRAL plus a
// short note on what a trade with vs. against the bias implies.
// ─────────────────────────────────────────────

function describeMacroBias(tf4h: MultiTimeframeData['tf4h']): string {
  if (!tf4h || tf4h.candles.length === 0) return 'UNKNOWN — insufficient 4H data; treat LONG and SHORT symmetrically.';

  const ind       = tf4h.indicators;
  const latest    = tf4h.candles.at(-1)!;
  const structure = detectStructure(tf4h.candles);
  const aboveEma20 = latest.close > ind.ema20;
  const aboveEma50 = latest.close > ind.ema50;

  const bullish = structure.startsWith('Uptrend')   && aboveEma50;
  const bearish = structure.startsWith('Downtrend') && !aboveEma50;

  if (bullish) {
    return `BULLISH — 4H ${structure.toLowerCase()}; price ${aboveEma20 ? 'above' : 'below'} EMA20, above EMA50. `
      + `Prefer LONG / pullback-buys into support. A SHORT here is counter-trend — take it only on an exceptional, clearly-justified setup, not on lower-timeframe momentum.`;
  }
  if (bearish) {
    return `BEARISH — 4H ${structure.toLowerCase()}; price ${aboveEma20 ? 'above' : 'below'} EMA20, below EMA50. `
      + `Prefer SHORT / pullback-sells into resistance. A LONG here is counter-trend — take it only on an exceptional, clearly-justified setup, not on lower-timeframe momentum.`;
  }
  return `NEUTRAL — 4H ${structure.toLowerCase()}; EMAs mixed (price ${aboveEma20 ? 'above' : 'below'} EMA20, ${aboveEma50 ? 'above' : 'below'} EMA50). `
    + `No macro tailwind either way — treat LONG and SHORT symmetrically and demand cleaner lower-timeframe structure before committing.`;
}

// ─────────────────────────────────────────────
// Trim a KeyLevelsResult — used for noisier timeframes (5m) where the full
// set would flood the prompt with weak round-number guesses. Keeps the same
// shape so formatKeyLevelsForPrompt works unchanged.
// ─────────────────────────────────────────────

function trimLevels(
  result: KeyLevelsResult,
  maxPerSide: number,
  excludeSources: ('swing' | 'volume_node' | 'round_number' | 'recent_extreme')[] = [],
): KeyLevelsResult {
  // Keep nearest AND strongest within the cap — same anti-eviction logic as
  // selectSide, so a strong distant level isn't dropped on these noisy TFs.
  const filterSide = (levels: KeyLevelsResult['resistances']) => {
    const filtered = levels.filter(l => !excludeSources.includes(l.source));
    const byDistance = (a: typeof filtered[number], b: typeof filtered[number]) =>
      Math.abs(a.price - result.currentPrice) - Math.abs(b.price - result.currentPrice);
    const byStrength = (a: typeof filtered[number], b: typeof filtered[number]) =>
      (b.strength - a.strength) || (b.touched - a.touched);

    const nearKeep   = Math.ceil(maxPerSide / 2);
    const nearest    = [...filtered].sort(byDistance).slice(0, nearKeep);
    const strongest  = [...filtered].sort(byStrength).slice(0, maxPerSide);

    const seen = new Set<string>();
    const out: typeof filtered = [];
    for (const l of [...nearest, ...strongest]) {
      const key = l.price.toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    return out.sort(byDistance);
  };

  const resistances = filterSide(result.resistances);
  const supports = filterSide(result.supports);

  return {
    ...result,
    resistances,
    supports,
    nearestResistance: resistances[0]?.price ?? null,
    nearestSupport: supports[0]?.price ?? null,
  };
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
// Util
// ─────────────────────────────────────────────

function getTimeSince(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = ms / (1000 * 60 * 60);
  return hours < 1
    ? `${Math.round(hours * 60)} minutes`
    : `${hours.toFixed(1)} hours`;
}

// ─────────────────────────────────────────────
// Challenge context block — included in BOTH entry and exit prompts when
// the agent is running inside a session. Gives LLM the equity / target /
// timer / drawdown awareness needed to lock in wins near target and play
// defensive near the floor. See guides/CHALLENGE_MODE.md.
// ─────────────────────────────────────────────

function buildChallengeBlock(ctx: ChallengeRiskContext): string {
  const target       = ctx.targetCapital;
  const start        = ctx.startingCapital;
  const equity       = ctx.equity;
  const progressPct  = start > 0 ? ((equity - start) / (target - start)) * 100 : 0;
  const drawdownUsed = ctx.maxDrawdownPct > 0
    ? (ctx.drawdownPct / ctx.maxDrawdownPct) * 100
    : 0;
  const daysLeftMs   = ctx.endsAt.getTime() - Date.now();
  const daysLeft     = Math.max(0, daysLeftMs / 86_400_000);
  const floor        = start * (1 - ctx.maxDrawdownPct);

  const maxMargin = equity * ctx.maxMarginPct;
  const maxNotionalFromMargin = maxMargin * ctx.leverage;

  return `
  ━━━━━━━━━━━━━━━━━━━━━━━
  CHALLENGE MODE ACTIVE — flip $${start.toFixed(2)} into $${target.toFixed(2)}:

  Current equity:  $${equity.toFixed(2)}
  Progress:        ${progressPct.toFixed(1)}% to target
  Drawdown used:   ${drawdownUsed.toFixed(1)}% of ${(ctx.maxDrawdownPct * 100).toFixed(0)}% budget (floor: $${floor.toFixed(2)})
  Days remaining:  ${daysLeft.toFixed(1)}
  Max margin/trade: $${maxMargin.toFixed(2)} (${(ctx.maxMarginPct * 100).toFixed(0)}% of bucket) → notional cap $${maxNotionalFromMargin.toFixed(2)}

  This is an isolated bucket — wins compound, losses shrink the bucket.
  You are operating under a compounding deadline. The setup selection
  rules from CORE PRINCIPLES apply with extra urgency — prefer HIGH-
  impact setups whenever possible to compound the bucket toward target
  in time.

  Near target: lock in.   Near floor: play defensive.   Mid-bucket: hunt.
  ━━━━━━━━━━━━━━━━━━━━━━━`.trim();
}