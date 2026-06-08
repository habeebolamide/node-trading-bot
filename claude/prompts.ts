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
import { findKeyLevels, formatKeyLevelsForPrompt, type KeyLevelsResult } from "../markets/keys.js";
import { getLotSpec } from '../risk/index.js';

// ─────────────────────────────────────────────
// TEST MODE FLAG
// Set to true to force LONG/SHORT signals
// Remove entirely when going live
// ─────────────────────────────────────────────

const TEST_MODE = false;

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
      You trade short-term momentum. Trades last minutes.
      You look for quick, high-probability moves with tight stops and clear targets.
      You enter close to current price or at immediate structure levels.
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

      SCALP — minutes to ~1 hour. Use when intraday momentum is clean: 5m/15m
        trend with volume, tight range break, or a clear reaction off a fresh
        level. Tight stops, R/R ≥ 1.0, entry close to current price. Best in
        low-news, mid-volatility tape.

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

  const testModeBlock = TEST_MODE
    ? `
      ━━━━━━━━━━━━━━━━━━━━━━━
      TEST MODE — ACTIVE:
      You MUST return LONG or SHORT. NO_TRADE is not allowed.
      If the market is unclear choose the most reasonable directional bias.
      CRITICAL: You are strictly hunting for HIGH-ROI setups (e.g. 100%+ margin ROI equivalent).
      A 100% margin ROI requires roughly (100 / leverage)% from entry — at ${leverage}× that's ${(100 / leverage).toFixed(2)}%.
      Do NOT return low-potential, 20% ROI micro-scalps just to fulfill the trade requirement.
      Look further out on the chart for major structural levels that offer massive Risk/Reward.
      Do not invent fake levels. Keep entries logical relative to current price.
      Reflect uncertainty through lower confidence score.
      ━━━━━━━━━━━━━━━━━━━━━━━
    `.trim()
    : '';

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

    For management decisions (HOLD / ADJUST / CLOSE / PARTIAL_CLOSE):
    triggers are not used either. The exchange's TP/SL handles critical
    exits autonomously; management re-runs on each candle close. When
    managing an open trade, evaluate news/events independently — do not
    rely on pre-computed context. If a major event just broke, assess whether
    it invalidates the thesis.
    
    CONFIDENCE:

    Confidence is a probability assessment, not a permission slip. Be honest:
      8–10 = high conviction. Clean structure, aligned momentum, clear invalidation.
      6–7  = decent setup with material uncertainty. Tradeable if R/R compensates.
      <6   = thesis is genuinely unclear. NO_TRADE.

    Above the floor: think in expected value. A clean 7 with 2.0R potential
    is a better trade than an 8 with 1.2R. Do NOT inflate confidence to
    clear a threshold, do NOT deflate it from over-caution.

    There IS a hard floor enforced by the risk layer (varies by performance
    mode — see EFFECTIVE PARAMETERS / mode block in the entry prompt). The
    entry prompt will show the exact floor for the current call. Signals
    below it are auto-rejected regardless of how strong the R/R looks.
    
    ${testModeBlock}
    For "LONG" | "SHORT": entry_expiry_minutes = how long the setup remains valid if entry isn't hit (e.g. 30 for a tight scalp, 180 for a day trade, 240 for a swing).
    For "NO_TRADE": triggers.timeout_minutes = how long this market context stays valid before fresh re-analysis is needed.
    Emit DURATIONS in minutes, not absolute timestamps — the server computes the deadline from your duration.
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
  const includeTfs: Array<'5m' | '15m' | '1h' | '4h'> = (
    style === 'scalp' ? ['5m', '15m', '1h'] :   // minutes-long: 5m/15m structure + 1h trend; 4h levels are too far to be entry/SL/TP
      style === 'day' ? ['5m', '15m', '1h', '4h'] :   // intraday: time entries on 5m, work 15m/1h, 4h frames the day's range/trend
        style === 'swing' ? ['15m', '1h', '4h'] :
          style === 'position' ? ['1h', '4h'] :
            ['5m', '15m', '1h', '4h']    // auto: full coverage
  );

  const levelBlocks: string[] = [];

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

  const levelsSection = levelBlocks.join('\n\n    ');

  return `
    ${modeLabel}
    CURRENT TIME (UTC): ${now}
    CURRENT PRICE: ${currentPrice}
    PAIR: ${agent.pair}
    1H ATR: ${atr1h}

    ${levelsSection}

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
      "reasoning": "<max 150 chars>",
      "what_invalidates": "<max 80 chars>",
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
  const currentPrice = mtfData.tf5m.candles.at(-1)?.close ?? trade.entryPrice;

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

━━━━━━━━━━━━━━━━━━━━━━━
HOW TO DECIDE — work through this in order:

1. DEFAULT IS HOLD. Most of the time, the correct action is to do nothing and
   let the trade work toward TP or SL. You placed the SL where the thesis breaks
   — trust it. A position being temporarily underwater is NORMAL and is NOT a
   reason to close. Acting without a concrete, data-backed reason is itself a
   mistake — it bleeds edge through fees and bad fills.

2. CLOSE only if the ORIGINAL THESIS IS GENUINELY BROKEN — i.e. structure that
   the trade depended on has actually failed on the chart in front of you (a
   real break of the level, a clean shift in structure, a confirmed reversal).
   "Price moved against me a bit" is not invalidation. Fear is not invalidation.
   If you cannot point to a specific broken level in the data above, do not CLOSE.

3. IF IN PROFIT — protect and extend:
   - ADJUST: tighten SL toward break-even or behind the most recent ${trade.direction === 'LONG' ? 'swing low' : 'swing high'}
     to lock in gains. Keep the SL a sensible distance back (roughly ≥1× ATR
     from price) so normal noise does not wick you out prematurely.
   - ADJUST: extend TP ONLY if price has cleanly reached the old TP zone AND a
     further structural level genuinely exists beyond it. Otherwise leave TP.
   - PARTIAL_CLOSE: when the move is extended and the next leg is uncertain —
     bank a portion, let the rest ride with a protected stop. ${isPartialCloseDisabled ? 'NOTE: PARTIAL CLOSE IS CURRENTLY DISABLED FOR THIS POSITION SIZE.' : ''}

4. IF IN DRAWDOWN — be patient, not reactive:
   - The SL already caps the downside. Do NOT pre-emptively close just because
     you are red. Either the thesis holds (HOLD) or it is genuinely broken (CLOSE).
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
  "reasoning": "<name the specific level/signal — max 100 chars>",
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
// Trim a KeyLevelsResult — used for noisier timeframes (5m) where the full
// set would flood the prompt with weak round-number guesses. Keeps the same
// shape so formatKeyLevelsForPrompt works unchanged.
// ─────────────────────────────────────────────

function trimLevels(
  result: KeyLevelsResult,
  maxPerSide: number,
  excludeSources: ('swing' | 'volume_node' | 'round_number' | 'recent_extreme')[] = [],
): KeyLevelsResult {
  const filterSide = (levels: KeyLevelsResult['resistances']) =>
    levels.filter(l => !excludeSources.includes(l.source)).slice(0, maxPerSide);

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
// the agent is running inside a session. Gives Claude the equity / target /
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