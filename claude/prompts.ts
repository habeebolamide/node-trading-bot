import type { Agent } from '../types/agent.types.js';
import type {
  Candle,
  MultiTimeframeData,
  RegimeAnalysis
} from '../types/market.types.js';
import type {
  PerformanceMode,
  RelevantLesson,
  WinningPattern
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
import { calculateMomentumTrajectory } from '../markets/indicators.js';

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
Guidance, not handcuffs. When the market gives a clear opportunity that
breaks a default, you may still take it — say why in your reasoning.
Blindly following rules misses more good trades than it saves bad ones.

R/R defaults (structure sets the target; never stretch TP for arithmetic):
  scalp ~1.0R | day ~1.2R | swing ~1.5R | position ~2.0R
A thinner R/R is acceptable when the setup is exceptionally clean.

R/R is the ratio. Leverage + SL distance together set the absolute % impact.
A 1.5R win on a 0.1% stop at 25× ≈ 3.75% margin ROI; same R/R on a 1.0%
stop at 25× ≈ 37.5%. Same ratio, 10× the impact. Structure picks SL;
absolute impact tells you whether a win meaningfully moves capital.

Setup selection:
  Margin ROI is a BYPRODUCT of a good trade, never the goal. A clean trade
  to a NEAR reachable structural target beats a hopeful one to a far level.
  PREFER HIGH-GRADE setups — clean structure, fresh level, timeframe alignment
  in ONE direction, honest confidence ≥7, CLEAR path to a reachable target.
  If the setup is not high-grade, the answer is NO_TRADE — not a smaller
  version of a mediocre trade.

Timeframe alignment — when 4H and LTF momentum agree, you have a tailwind.
When they diverge:
  Pullback INTO HTF support/resistance = highest-probability setup. LTF
    "conflict" IS the entry trigger, not a reason to skip.
  Counter-trend bet AGAINST a strong 4H trend = be skeptical.

News proximity — within 30 min of a high-impact event, the technical read is
more often invalidated than confirmed. Raise the bar; trust structure less.

Structural levels — anchor every price to something visible: swing high,
swing low, prior reaction zone, volume node, or a historically-respected
round number. Pure round numbers without history are weak.

Honest confidence — a probability assessment, not a permission slip. Do NOT
inflate to act; do NOT deflate from over-caution.
`.trim();

// JSON output contracts — stable across all calls of a given phase, so they
// live in the (cacheable) system prompt rather than the per-cycle user prompt.
const ENTRY_JSON_SCHEMA = `
{
  "action": "LONG" | "SHORT" | "NO_TRADE",
  "entry": <number | null>,
  "tp": <number | null>,
  "sl": <number | null>,
  "confidence": <number 1-10>,
  "timeframe_used": "<timeframe that drove the decision>",
  "tradeStyle": "scalp" | "day" | "swing" | "position",
  "entry_expiry_minutes": <number | null — minutes LONG/SHORT stays valid; null for NO_TRADE>,
  "what_invalidates": "<max 100 chars — concrete level/signal that proves the thesis wrong>",
  "reasoning": "<max 200 chars — why this trade, right now: structure + edge>",
  "triggers": {
    "price_up":   <number | null — nearest structural resistance whose break demands a fresh look; null for LONG/SHORT>,
    "price_down": <number | null — nearest structural support whose break demands a fresh look; null for LONG/SHORT>,
    "timeout_minutes": <number — minutes this NO_TRADE context stays valid before re-analysis>
  }
}

SL/TP side rule (mechanical — will be rejected otherwise):
  LONG  → SL strictly BELOW entry, TP strictly ABOVE entry.
  SHORT → SL strictly ABOVE entry, TP strictly BELOW entry.
`.trim();

const MANAGEMENT_JSON_SCHEMA = `
{
  "action": "HOLD" | "ADJUST" | "CLOSE" | "PARTIAL_CLOSE",
  "newTp": <number | null — only when extending/changing TP>,
  "newSl": <number | null — only when tightening SL; MUST be closer to price than current, never further>,
  "closePercent": <0-100 | null — only for PARTIAL_CLOSE>,
  "reasoning": "<max 100 chars — name the specific level/signal driving the action, not a feeling>",
  "urgency": "low" | "medium" | "high"
}
`.trim();

// ─────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────

export function buildSystemPrompt(
  agent: Agent,
  challenge?: ChallengeRiskContext,
  phase: 'entry' | 'management' = 'entry',
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

  const methodBlock = phase === 'entry'
    ? `
<method>
Entry approaches — pick one per setup:
  CONFIRMATION — enter at or near current price after a clean breakout or
    momentum signal. Used when the move is already resolving.
  PULLBACK — wait for price to return to a key structural level. Entry can
    be above or below current price. Never force market entry at current
    price if a cleaner level is close.

Level setting — every price you emit must come from visible structure:
support/resistance zones, swing highs/lows, liquidity, volume nodes,
historically-respected round numbers. No arbitrary numbers.
  SL = the exact point where the thesis is proven wrong.
  TP = the next meaningful structural level in your favour.

Triggers (NO_TRADE only) — levels that would prompt a fresh look before the
next scheduled cycle. Must be structural, not arbitrary distances.
  price_up   = nearest structural resistance whose break demands re-analysis.
  price_down = nearest structural support whose break demands re-analysis.
  timeout_minutes = how long this NO_TRADE context stays valid.
For LONG / SHORT: set price_up and price_down to null.

Confidence — a probability assessment, honest:
  8–10 = high conviction. Clean structure, aligned momentum, clear invalidation.
  6–7  = decent setup with material uncertainty. Tradeable if R/R compensates.
  <6   = thesis genuinely unclear → NO_TRADE.
Above the floor, think in expected value. A clean 7 with 2.0R > an 8 with 1.2R.
</method>`.trim()
    : `
<method>
You are managing a LIVE position, not analysing a fresh entry. You already
committed. Your job is to manage well, not re-litigate the trade.

Default is HOLD. Act only on real, data-backed evidence that the read has
changed — reversal structure against you, momentum decisively flipped with
volume, the level the trade relies on visibly failing.

Never widen SL. Tighten only. In profit → protect (tighten SL toward BE or
behind the most recent swing) and extend TP only if a further structural
level genuinely exists. Near TP with exhaustion showing → PARTIAL_CLOSE or
CLOSE rather than round-tripping the win.

In drawdown, being underwater is NOT a reason to close. The SL already caps
downside. But if reversal evidence is actually present, cut early — don't
stubbornly ride to the stop.
</method>`.trim();

  const formatBlock = phase === 'entry'
    ? `<format>\nRespond with valid JSON only. No text outside the JSON.\n\n${ENTRY_JSON_SCHEMA}\n</format>`
    : `<format>\nRespond with valid JSON only. No text outside the JSON.\n\n${MANAGEMENT_JSON_SCHEMA}\n</format>`;

  const limitationsBlock = phase === 'entry'
    ? `
<limitations>
Absolutes — these never bend:
  Never widen an SL once a trade is live. Tighten only.
  Never add to a losing position. If the thesis breaks, exit clean.
  Never emit an SL/TP on the wrong side of entry (LONG: SL<entry<TP; SHORT: TP<entry<SL).

NO_TRADE is the DEFAULT. A trade must EARN its way past it. Sitting out a
marginal market is the correct, disciplined outcome — not a wasted cycle.
Expect most cycles to end in NO_TRADE.

Fold triggers — return NO_TRADE unless a truly exceptional trigger fires
RIGHT NOW (and name it in reasoning):
  Macro bias NEUTRAL, or ADX < ~22, or 4H compressing / no clean structure.
  A big "★★★★★ confluence zone" in a chop tape is NOT a reason to trade —
    price knifes through zones in a rangebound market.
  Counter-trend setup where TP sits on the very S/R the dominant trend
    would bounce/reject from.
  R/R that looks great only because TP is behind one or more opposing ≥4★
    zones — that is a LIE; the number looks big and the trade still loses.
  Within 30 min of a known high-impact news release.

Directional anchor:
  The MACRO BIAS (4H) is your side. REGIME + 1m/5m/15m labels are timing,
  not a reason to reverse. Do NOT flip LONG↔SHORT unless the 4H itself has
  broken (loses its most recent higher-low / lower-high and closes through).
  A pullback against the 4H trend IS the pullback-entry in the 4H direction.

Mode floors — the risk layer auto-rejects any signal that fails these; the
active floors are surfaced in the per-cycle context. If confidence or R/R
would be below the floor, choose NO_TRADE rather than emit a doomed signal.
</limitations>`.trim()
    : `
<limitations>
Never widen an SL. newSl must be strictly closer to price than currentSl.
Never CLOSE purely because you are red — drawdown alone is not evidence.
Never emit an action just to act. If nothing concrete has changed: HOLD.
Reasoning MUST name the specific level or signal driving the action.
</limitations>`.trim();

  return `
<role>
You trade crypto on your own judgment. You read the market, find real setups,
and pull the trigger when the read is clean. You are not here to print signals
— you are here to trade. You know your edge and you wait for it. Forcing a
trade costs as much as missing one.
</role>

<approach>
${styleGuide}
</approach>

<assignment>
Pair:     ${agent.pair}
Leverage: ${leverage}x
${riskClause}
${challengeBlock ? '\n' + challengeBlock : ''}
</assignment>

<principles>
${CORE_PRINCIPLES}
</principles>

${methodBlock}

${formatBlock}

${limitationsBlock}
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
  derivativesContext: string = '',
  winningPatterns: WinningPattern[] = [],
  calibrationNote: string = '',
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
    `  ${modeDescriptions[performanceMode]}\n` +
    `  AUTO-REJECT FLOORS (this mode): confidence < ${floors.confidence} OR R/R < ${floors.rr.toFixed(1)} → risk layer rejects before market.`;

  // Leverage / risk / challenge block all live in the system prompt now —
  // the entry prompt focuses on per-candle market state only.

  const relevantLessons = lessons.length > 0
    ? `Past mistakes matching this setup:\n${lessons.map((l, i) =>
        `  ${i + 1}. [${l.patternTag}] ${l.ruleToAdd} — occurred ${l.frequency}x`
      ).join('\n')}`
    : '';

  const winningPlaybook = winningPatterns.length > 0
    ? `What's been working — your most repeatable winning setups (look for these first):\n${winningPatterns.map((w, i) =>
        `  ${i + 1}. [${w.patternTag}] ${w.rule} — won ${w.frequency}x`
      ).join('\n')}`
    : '';

  const calibrationBlock = calibrationNote
    ? `Confidence calibration (realised win rate by stated confidence):\n  ${calibrationNote}\n  If your 8s win like your 6s, you are inflating. Weight EV by these real odds, not the number you'd like to write.`
    : '';

  // Per-style key-level coverage. Scalps need intraday levels because they're
  // operating on 5m/15m structure; swing/position pull in the 1D macro frame
  // above the 4H anchor. Daily is gated OUT of scalp/day — at those horizons it
  // is noise, not coverage (a scalp never reasons off daily structure).
  const style = agent.tradingStyle ?? 'auto';
  const includeTfs: Array<'1m' | '5m' | '15m' | '1h' | '4h' | '1d'> = (
    style === 'scalp' ? ['1m', '5m', '15m'] :   // minutes-long (5–10 min): pure micro-structure on 1m/5m, 15m for immediate context
      style === 'day' ? ['5m', '15m', '1h', '4h'] :   // intraday: time entries on 5m, work 15m/1h, 4h frames the day's range/trend
        style === 'swing' ? ['15m', '1h', '4h', '1d'] :   // swing: 1D is the macro frame above the 4H anchor
          style === 'position' ? ['1h', '4h', '1d'] :     // position: macro view, anchored on 1D
            ['1m', '5m', '15m', '1h', '4h', '1d']    // auto: full coverage — 1m for scalp adaptation, 1d for swing adaptation
  );

  const levelBlocks: string[] = [];

  if (includeTfs.includes('1m')) {
    // 1m is the noisiest feed — keep only the strongest structural levels, top 3
    // per side, and drop round numbers (meaningless at this resolution).
    const raw = findKeyLevels(mtfData.tf1m.candles);
    const trimmed = trimLevels(raw, 3, ['round_number']);
    levelBlocks.push(`SCALP LEVELS — 1M (top 3, structural only — entry/exit timing):\n${formatKeyLevelsForPrompt(trimmed)}`);
  }

  if (includeTfs.includes('5m')) {
    const raw = findKeyLevels(mtfData.tf5m.candles);
    const trimmed = trimLevels(raw, 3, ['round_number']);
    levelBlocks.push(`INTRADAY LEVELS — 5M (top 3, structural only):\n${formatKeyLevelsForPrompt(trimmed)}`);
  }

  if (includeTfs.includes('15m')) {
    levelBlocks.push(`INTRADAY LEVELS — 15M:\n${formatKeyLevelsForPrompt(findKeyLevels(mtfData.tf15m.candles))}`);
  }

  if (includeTfs.includes('1h')) {
    levelBlocks.push(`KEY LEVELS — 1H:\n${formatKeyLevelsForPrompt(findKeyLevels(mtfData.tf1h.candles))}`);
  }

  if (includeTfs.includes('4h')) {
    levelBlocks.push(`MAJOR LEVELS — 4H:\n${formatKeyLevelsForPrompt(findKeyLevels(mtfData.tf4h.candles))}`);
  }

  if (includeTfs.includes('1d')) {
    levelBlocks.push(`MACRO LEVELS — 1D (strongest, slowest-moving S/R on the chart):\n${formatKeyLevelsForPrompt(findKeyLevels(mtfData.tf1d.candles))}`);
  }

  // Cross-timeframe confluence — computed from the same timeframes the agent
  // is allowed to see. Surfaced FIRST so the model anchors on the strongest
  // multi-TF structure before reading per-timeframe detail. These survive even
  // when far from spot, which is exactly what a pullback-limit entry needs.
  const tfSnapshots: Record<'1m' | '5m' | '15m' | '1h' | '4h' | '1d', MultiTimeframeData['tf4h']> = {
    '1m': mtfData.tf1m,
    '5m': mtfData.tf5m,
    '15m': mtfData.tf15m,
    '1h': mtfData.tf1h,
    '4h': mtfData.tf4h,
    '1d': mtfData.tf1d,
  };
  const confluenceZones = findConfluenceZones(
    includeTfs.map(tf => ({ tf, candles: tfSnapshots[tf].candles })),
    currentPrice,
  );
  const confluenceBlock = `CONFLUENCE ZONES (multi-timeframe — strongest structure on the chart):\n${formatConfluenceZonesForPrompt(confluenceZones, currentPrice)}`;

  const structureSection = [confluenceBlock, ...levelBlocks].join('\n\n');

  // Timeframe read-outs, gated by trade style. Ordered high → low for top-down.
  const tfSummaryBlocks: string[] = [];
  const pushTfSummary = (
    key:   '1d' | '4h' | '1h' | '15m' | '5m' | '1m',
    label: string,
    snap:  MultiTimeframeData['tf4h'],
  ) => {
    if (includeTfs.includes(key)) {
      tfSummaryBlocks.push(`${label}:\n${formatTimeframe(snap)}`);
    }
  };
  pushTfSummary('1d',  '1D',  mtfData.tf1d);
  pushTfSummary('4h',  '4H',  mtfData.tf4h);
  pushTfSummary('1h',  '1H',  mtfData.tf1h);
  pushTfSummary('15m', '15M', mtfData.tf15m);
  pushTfSummary('5m',  '5M',  mtfData.tf5m);
  pushTfSummary('1m',  '1M',  mtfData.tf1m);
  const timeframesSection = tfSummaryBlocks.join('\n\n');

  // Macro directional anchor — derived ONLY from the 4H so it stays stable
  // while lower TFs (and REGIME) chop. Gated to styles that look at the 4H.
  const macroBias = includeTfs.includes('4h')
    ? describeMacroBias(mtfData.tf4h)
    : null;

  const regimeBlock =
    `REGIME (LTF momentum — SECONDARY to MACRO BIAS; flips on small moves): ${regime.regime} (${(regime.confidence * 100).toFixed(0)}% confidence)\n` +
    `ADX: ${regime.adx} | EMA slope: ${regime.emaSlope}% | Volume: ${regime.volumeTrend}`;

  // Derivatives — gated out of scalp (minutes-long trades rarely hold across
  // a funding boundary; OI shifts are day/swing-horizon signals).
  const derivativesLine = (derivativesContext && style !== 'scalp')
    ? `Funding + open interest (crowding & conviction):\n${derivativesContext}`
    : '';

  const memoryBlock = [winningPlaybook, relevantLessons, calibrationBlock]
    .filter(Boolean).join('\n\n');

  const contextSections = [
    `<session>\n${modeLabel}\nTime (UTC): ${now}\nPair: ${agent.pair}\nPrice: ${currentPrice}\n1H ATR: ${atr1h}\n</session>`,
    macroBias ? `<macro>\nMACRO BIAS (4H — your directional anchor):\n${macroBias}\n</macro>` : '',
    `<regime>\n${regimeBlock}\n</regime>`,
    `<structure>\n${structureSection}\n</structure>`,
    `<timeframes>\n${timeframesSection}\n</timeframes>`,
    derivativesLine ? `<derivatives>\n${derivativesLine}\n</derivatives>` : '',
    `<news>\n${newsContext}\n</news>`,
    memoryBlock ? `<memory>\n${memoryBlock}\n</memory>` : '',
  ].filter(Boolean).join('\n\n');

  return `
<context>
${contextSections}
</context>

<instruction>
Work top-down through the tape you actually have. Do NOT re-derive the
absolutes or fold triggers — those live in your system prompt <limitations>.

1. Read <macro> + <regime> + ADX. Classify the tape:
     NO-EDGE (neutral bias / ADX < 22 / compression) → NO_TRADE unless a
       genuinely exceptional trigger fires RIGHT NOW; name it.
     TRENDING (bias BULLISH or BEARISH, ADX ≥ ~22, structure confirming) →
       hunt a setup IN the trend direction. No counter-trend.

2. If trending: pick the nearest strong (≥4★) <structure> zone price can
   realistically reach in the trend direction. Build entry AT the zone,
   SL just beyond where the thesis breaks, TP at the next structural level
   in your favour.

3. Check geometry, not arithmetic:
     Is SL beyond ~1× trade-TF ATR so routine noise won't stop it?
     Is the path to TP CLEAR, or does it sit behind one or more opposing
       ≥4★ zones? A large R/R produced by a far TP behind resistance is
       a LIE — the number looks great and the trade still loses.

4. EV gate: does confidence × R/R × structure quality give genuinely
   positive expected value ABOVE the mode floors surfaced in <session>?
   If not → NO_TRADE.

Emit in the JSON format defined in your system prompt <format>.
</instruction>
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

  const reversalShape = trade.direction === 'LONG' ? 'lower highs + lower lows' : 'higher highs + higher lows';
  const trailAnchor   = trade.direction === 'LONG' ? 'swing low' : 'swing high';
  const partialCloseNote = isPartialCloseDisabled
    ? 'PARTIAL_CLOSE is DISABLED for this position size — HOLD or full CLOSE only.'
    : '';

  return `
<context>
<position>
Live ${trade.direction} on ${trade.pair} — real money at risk. Not a fresh analysis.
Direction:       ${trade.direction}
Entry:           ${trade.entryPrice}
Current price:   ${currentPrice}
TP:              ${trade.currentTp}
SL:              ${trade.currentSl}  ← exchange-enforced backstop
Unrealised:      ${pnlSign}${trade.unrealisedPct.toFixed(2)}% (${pnlSign}$${trade.unrealisedPnl.toFixed(2)}) — ${inProfit ? 'IN PROFIT' : 'IN DRAWDOWN'}
Duration:        ${duration}
Original thesis: ${trade.entryReasoning}
${originalInvalidation ? `Thesis breaks if: ${originalInvalidation}` : ''}
Partial close:   ${partialCloseStatus}
</position>

<market>
Every price you reference MUST come from the data below — do not invent levels.

4H — is the original thesis still structurally intact?
${formatTimeframe(mtfData.tf4h)}

1H — how is momentum developing?
${formatTimeframe(mtfData.tf1h)}

15M — what is price doing right now?
${formatTimeframe(mtfData.tf15m)}

5M — near-term momentum into the current move
${formatTimeframe(mtfData.tf5m)}

1M — live price action for precise exits (critical for fast scalps)
${formatTimeframe(mtfData.tf1m)}
</market>
</context>

<instruction>
Default is HOLD. Absolutes and "never widen SL" live in system <limitations>.

1. Is the entry thesis still structurally intact on the timeframe that framed it?
   If yes and no reversal evidence → HOLD.

2. CLOSE EARLY (or PARTIAL_CLOSE) — do NOT wait for the SL at ${trade.currentSl}
   — when you can point to REAL evidence the move is turning:
     - LTF printing ${reversalShape} against your position, or a strong
       opposite-side rejection / engulfing at a key level
     - momentum decisively flipped on the timeframe that carried the thesis,
       ideally with volume confirming the against-side
     - the structural level the trade relied on is visibly failing
   "It looks weak" / one noisy candle / fear are NOT reasons.

3. NEAR TP — if price has run most of the way and exhaustion / opposite-side
   pressure is now showing, PARTIAL_CLOSE to bank the bulk (or CLOSE if the
   reversal looks convincing). Round-tripping a near-winner is worse than
   taking most of the target.

4. IN PROFIT — protect and extend:
     ADJUST: tighten SL toward BE or behind the most recent ${trailAnchor},
       keeping ≥~1× ATR back so normal noise won't wick you.
     ADJUST: extend TP ONLY if price cleanly reached the old TP AND a further
       structural level genuinely exists beyond it.
     PARTIAL_CLOSE: extended move + uncertain next leg → bank some, ride rest.
     ${partialCloseNote}

5. IN DRAWDOWN — patient, not reactive. Red alone is not a reason to close.
   But if the reversal evidence in step 2 is actually there, cut early — don't
   stubbornly ride to the stop.

Reasoning MUST name the SPECIFIC level or signal driving the action (e.g.
"4H lost 1985 support, structure flipped" — not "looks weak"). If you cannot
name it → HOLD. Emit in the JSON format defined in your system prompt <format>.
</instruction>
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
// Win-analysis prompt — positive mirror of the post-mortem.
// Run after a winning trade closes to extract the repeatable edge.
// ─────────────────────────────────────────────

export function buildWinAnalysisPrompt(
  trade: ClosedTrade,
  regimeAtEntry: string,
  newsAtEntry: string,
  rsiAtEntry: number,
  volumeRatioAtEntry: number,
): string {
  return `
A trade just closed in PROFIT. Analyse what actually worked — the repeatable
edge — with the same honesty you'd apply to a loss. Do NOT credit luck or a
lucky news spike as edge: if the win was not repeatable, say so in the driver
and pick a pattern tag that reflects that.

TRADE:
Pair:      ${trade.pair}
Direction: ${trade.direction}
Entry:     ${trade.entryPrice} → Exit: ${trade.exitPrice}
Gain:      ${trade.realisedPct.toFixed(2)}%
Duration:  ${trade.durationHours.toFixed(1)} hours
Reason:    ${trade.closeReason}
Original reasoning: "${trade.entryReasoning}"

CONDITIONS AT ENTRY:
Regime:  ${regimeAtEntry}
RSI:     ${rsiAtEntry}
Volume:  ${volumeRatioAtEntry}x average
News:    ${newsAtEntry}

PATTERN TAG: SCREAMING_SNAKE_CASE describing the winning setup. Examples:
  PULLBACK_TO_4H_SUPPORT_LONG
  BREAKOUT_RETEST_WITH_VOLUME
  RANGE_FADE_AT_CONFLUENCE
  TREND_CONTINUATION_AFTER_EMA_RECLAIM

RULE TO REPEAT: a specific, actionable rule with concrete conditions.
  Good: "Take LONG pullbacks to 4H support when 4H trend is up and RSI > 45."
  Bad:  "Buy the dip."

Respond ONLY with this exact JSON:
{
  "primaryDriver": "<one sentence — the real, repeatable reason this worked>",
  "patternTag": "<SCREAMING_SNAKE_CASE — see examples above>",
  "ruleToRepeat": "<specific actionable rule with concrete conditions where possible>"
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

  // Momentum DIRECTION, not just level — is RSI rising/falling, is the MACD
  // histogram building or fading, is price diverging from RSI. Falls back to the
  // static MACD sign when the series is too short to compute a trajectory.
  const traj = calculateMomentumTrajectory(candles);
  const macdRead = traj
    ? `MACD ${traj.macdSign}, ${traj.macd}`
    : `MACD histogram: ${ind.macd.histogram > 0 ? 'positive' : 'negative'}`;
  const rsiTrend = traj && traj.rsi !== 'flat' ? `, ${traj.rsi}` : '';
  const divergenceNote = traj?.divergence
    ? `\n⚠ ${traj.divergence === 'bearish' ? 'BEARISH' : 'BULLISH'} divergence — price vs RSI (momentum not confirming price)`
    : '';

  const recent = candles.slice(-10);
  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));

  return `
Price: ${latest.close} ${direction} | ${vsEma20} | ${vsEma50}
Structure: ${structure}
RSI: ${rsiContext}${rsiTrend} | Volume: ${volContext} | ${macdRead}
ATR: ${ind.atr} | ADX: ${ind.adx}${ind.adx > 25 ? ' (trending)' : ' (no clear trend)'}
Latest candle: ${pattern}
Recent range: ${recentLow} — ${recentHigh}${divergenceNote}
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