import logger from '../utils/logger.js';
import { getPostMortem, getWinAnalysis, getSynthesis } from '../claude/client.js';
import { buildPostMortemPrompt, buildWinAnalysisPrompt, buildSynthesisPrompt } from '../claude/prompts.js';
import type { ClosedTrade } from '../types/trade.types.js';
import type { PostMortemResult, WinAnalysisResult } from '../types/claude.types.js';
import type { RelevantLesson, TradeLessonInput, WinningPattern } from '../types/risk.types.js';
import { prisma } from '../lib/prisma.js';
import type { LearnedRule } from '../types/agent.types.js';


// ─────────────────────────────────────────────
// Post-mortem
// Called automatically after every losing trade
// ─────────────────────────────────────────────

export async function runPostMortem(
  trade:         ClosedTrade,
  regimeAtEntry: string,
  newsAtEntry:   string,
  rsiAtEntry:    number,
  volumeRatio:   number,
): Promise<void> {
  logger.info('Running post-mortem', { tradeId: trade.id, pnl: trade.realisedPct });

  const prompt = buildPostMortemPrompt(
    trade,
    regimeAtEntry,
    newsAtEntry,
    rsiAtEntry,
    volumeRatio,
  );

  const result = await getPostMortem(prompt, trade.agentId);

  if (!result.success || !result.data) {
    logger.error('Post-mortem Claude call failed', { tradeId: trade.id });
    return;
  }

  const analysis = result.data as PostMortemResult;

  // Save lesson to DB
  await saveLesson({
    agentId:       trade.agentId,
    tradeId:       trade.id,
    pair:          trade.pair,
    outcome:       'loss',
    patternTag:    analysis.patternTag,
    primaryReason: analysis.primaryReason,
    ruleToAdd:     analysis.ruleToAdd,
    verdict:       analysis.verdict,
    marketRegime:  analysis.marketRegime,
    rsiAtEntry,
    trendAtEntry:  regimeAtEntry,
    volumeRatio,
    newsAtEntry:   newsAtEntry !== 'No significant news in the last 30 minutes.' ? newsAtEntry : null,
    avoidable:     analysis.avoidable,
  });

  logger.info('Post-mortem saved', {
    tradeId:    trade.id,
    patternTag: analysis.patternTag,
    verdict:    analysis.verdict,
    avoidable:  analysis.avoidable,
  });
}

// ─────────────────────────────────────────────
// Win-analysis
// Called automatically after every winning trade — the positive mirror of the
// post-mortem. Extracts the repeatable edge and stores it as a win lesson so
// getWinningPatterns can surface "what's been working" into the entry prompt.
// ─────────────────────────────────────────────

export async function runWinAnalysis(
  trade:         ClosedTrade,
  regimeAtEntry: string,
  newsAtEntry:   string,
  rsiAtEntry:    number,
  volumeRatio:   number,
): Promise<void> {
  logger.info('Running win-analysis', { tradeId: trade.id, pnl: trade.realisedPct });

  const prompt = buildWinAnalysisPrompt(
    trade,
    regimeAtEntry,
    newsAtEntry,
    rsiAtEntry,
    volumeRatio,
  );

  const result = await getWinAnalysis(prompt, trade.agentId);

  if (!result.success || !result.data) {
    logger.error('Win-analysis Claude call failed', { tradeId: trade.id });
    return;
  }

  const analysis = result.data as WinAnalysisResult;

  await saveLesson({
    agentId:       trade.agentId,
    tradeId:       trade.id,
    pair:          trade.pair,
    outcome:       'win',
    patternTag:    analysis.patternTag,
    primaryReason: analysis.primaryDriver,
    ruleToAdd:     analysis.ruleToRepeat,
    rsiAtEntry,
    trendAtEntry:  regimeAtEntry,
    volumeRatio,
    newsAtEntry:   newsAtEntry !== 'No significant news in the last 30 minutes.' ? newsAtEntry : null,
  });

  logger.info('Win-analysis saved', {
    tradeId:    trade.id,
    patternTag: analysis.patternTag,
  });
}

// ─────────────────────────────────────────────
// Save lesson to DB
// ─────────────────────────────────────────────

async function saveLesson(input: TradeLessonInput): Promise<void> {
  await prisma.tradeLesson.create({
    data: {
      agentId:     input.agentId,
      tradeId:     input.tradeId ?? null,
      tag:         input.patternTag,
      rule:        input.ruleToAdd,
      description: input.primaryReason,
      outcome:     input.outcome,
      verdict:     input.verdict   ?? null,
      avoidable:   input.avoidable ?? null,
    },
  });
}

// ─────────────────────────────────────────────
// Lesson retriever
// Returns only the lessons relevant to the
// current market setup — not all 100
// Uses tag matching — fast, free, no extra API
// ─────────────────────────────────────────────

export async function getRelevantLessons(
  agentId:     string,
  regime:      string,
  signal:      string,      // LONG or SHORT
  rsi:         number,
  volumeRatio: number,
  pair:        string,
  dayOfWeek:   number,      // 0 = Sunday, 6 = Saturday
): Promise<RelevantLesson[]> {

  // Detect which pattern tags are relevant right now
  const relevantTags = detectRelevantTags({
    regime,
    signal,
    rsi,
    volumeRatio,
    dayOfWeek,
  });

  if (relevantTags.length === 0) return [];

  // Fetch matching LOSS lessons from DB. Fetch a few extra — the avoidability
  // filter below drops some, and we still want a full top-5 afterward.
  const rawLessons = await prisma.tradeLesson.findMany({
    where: {
      agentId,
      outcome: 'loss',
      tag: { in: relevantTags },
    },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });

  // Drop lessons the post-mortem judged pure bad luck or unavoidable — surfacing
  // them as "rules" would teach the bot to avoid setups that were actually fine,
  // suppressing good future trades. Legacy lessons (verdict/avoidable = null)
  // predate this signal, so we keep them rather than guess.
  const lessons = rawLessons.filter(l => l.verdict !== 'bad_luck' && l.avoidable !== false);

  if (lessons.length === 0) return [];

  // Count frequency per tag — more frequent = more important
  const tagFrequency: Record<string, number> = {};
  lessons.forEach(l => {
    tagFrequency[l.tag] = (tagFrequency[l.tag] ?? 0) + 1;
  });

  // Deduplicate by tag — keep most recent rule per tag
  const seen    = new Set<string>();
  const unique  = lessons.filter(l => {
    if (seen.has(l.tag)) return false;
    seen.add(l.tag);
    return true;
  });

  // Map to RelevantLesson shape + attach frequency
  const result: RelevantLesson[] = unique.map(l => ({
    patternTag:    l.tag,
    ruleToAdd:     l.rule,
    primaryReason: l.description,
    frequency:     tagFrequency[l.tag] ?? 1,
  }));

  // Sort by frequency — most repeated mistakes first
  result.sort((a, b) => b.frequency - a.frequency);

  // Return top 5 — keep prompt lean
  return result.slice(0, 5);
}

// ─────────────────────────────────────────────
// Winning-pattern retriever
// Surfaces the agent's most repeatable winning setups (by frequency) into the
// entry prompt as "what's been working". Unlike the loss retriever this is not
// setup-matched — win tags are LLM-generated and varied — it's general "here is
// your edge" awareness. Tag-matching wins to the current setup is a future step.
// ─────────────────────────────────────────────

export async function getWinningPatterns(
  agentId: string,
  limit = 3,
): Promise<WinningPattern[]> {
  const wins = await prisma.tradeLesson.findMany({
    where:   { agentId, outcome: 'win' },
    orderBy: { createdAt: 'desc' },
    take:    50,
  });

  if (wins.length === 0) return [];

  // Group by tag, counting frequency and keeping the most recent rule per tag
  // (findMany is ordered desc, so the first row seen for a tag is the newest).
  const byTag: Record<string, { rule: string; count: number }> = {};
  for (const w of wins) {
    if (!byTag[w.tag]) byTag[w.tag] = { rule: w.rule, count: 0 };
    byTag[w.tag]!.count++;
  }

  return Object.entries(byTag)
    .map(([patternTag, v]) => ({ patternTag, rule: v.rule, frequency: v.count }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit);
}

// ─────────────────────────────────────────────
// Confidence calibration
// Buckets the agent's CLOSED trades by the confidence stated at entry and
// reports the actual win rate per band. Surfaced into the entry prompt so the
// LLM can see whether its "8" really wins like an 8 — grounding confidence in
// realised odds instead of letting it drift. Reads confidence from the entry
// snapshot JSON (no schema column). Returns '' until there's enough history.
// ─────────────────────────────────────────────

export async function getConfidenceCalibration(
  agentId:   string,
  minTrades = 10,
): Promise<string> {
  const trades = await prisma.trade.findMany({
    where:   { agentId, status: 'closed', realizedPnL: { not: null } },
    select:  { realizedPnL: true, entrySnapshot: true },
    orderBy: { closedAt: 'desc' },
    take:    200,
  });

  const bandFor = (c: number): string =>
    c >= 9 ? '9-10' : c >= 8 ? '8' : c >= 7 ? '7' : c >= 6 ? '6' : '<6';

  const bands: Record<string, { wins: number; total: number }> = {};
  let counted = 0;

  for (const t of trades) {
    const snap = t.entrySnapshot as { confidence?: number } | null;
    const c = typeof snap?.confidence === 'number' ? snap.confidence : null;
    if (c == null) continue;                       // pre-calibration trades have no confidence

    const band = bandFor(c);
    if (!bands[band]) bands[band] = { wins: 0, total: 0 };
    bands[band]!.total++;
    if ((t.realizedPnL ?? 0) > 0) bands[band]!.wins++;
    counted++;
  }

  if (counted < minTrades) return '';

  const order = ['9-10', '8', '7', '6', '<6'];
  return order
    .filter(b => bands[b])
    .map(b => {
      const { wins, total } = bands[b]!;
      return `  conf ${b}: ${Math.round((wins / total) * 100)}% win (${total} trades)`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────
// Tag detector
// Pure logic — detects which lesson tags are
// relevant to the current market setup
// Zero tokens, zero cost
// ─────────────────────────────────────────────

function detectRelevantTags(ctx: {
  regime:      string;
  signal:      string;            // 'LONG' | 'SHORT' | 'UNKNOWN' (pre-decision)
  rsi:         number;
  volumeRatio: number;
  dayOfWeek:   number;
}): string[] {
  const tags: string[] = [];
  const unknown = ctx.signal === 'UNKNOWN';

  // Counter trend entry — going against the big trend.
  // Pre-decision (UNKNOWN): surface for any strong trend regime since either
  // direction could be counter-trend depending on what the LLM picks.
  if (
    (unknown && (ctx.regime === 'TRENDING_BULL' || ctx.regime === 'TRENDING_BEAR')) ||
    (ctx.regime === 'TRENDING_BEAR' && ctx.signal === 'LONG') ||
    (ctx.regime === 'TRENDING_BULL' && ctx.signal === 'SHORT')
  ) {
    tags.push('COUNTER_TREND_ENTRY');
  }

  // Ranging market — momentum entries fail here
  if (ctx.regime === 'RANGING') {
    tags.push('RANGING_MARKET');
    tags.push('MOMENTUM_IN_RANGE');
  }

  // Volatile market — risk is elevated
  if (ctx.regime === 'VOLATILE') {
    tags.push('VOLATILE_ENTRY');
    tags.push('NEWS_DRIVEN_MOVE');
  }

  // Overbought entering long (or any direction if pre-decision)
  if (ctx.rsi > 68 && (unknown || ctx.signal === 'LONG')) {
    tags.push('OVERBOUGHT_LONG');
    tags.push('RSI_EXTREME_ENTRY');
  }

  // Oversold entering short (or any direction if pre-decision)
  if (ctx.rsi < 32 && (unknown || ctx.signal === 'SHORT')) {
    tags.push('OVERSOLD_SHORT');
    tags.push('RSI_EXTREME_ENTRY');
  }

  // Low volume breakout — often fake
  if (ctx.volumeRatio < 1.0) {
    tags.push('LOW_VOLUME_BREAK');
    tags.push('WEAK_BREAKOUT');
  }

  // Volume spike — could be news-driven
  if (ctx.volumeRatio > 2.5) {
    tags.push('VOLUME_SPIKE_ENTRY');
    tags.push('NEWS_BLIND');
  }

  // Weekend — lower liquidity, unreliable signals
  if (ctx.dayOfWeek === 0 || ctx.dayOfWeek === 6) {
    tags.push('WEEKEND_TRAP');
    tags.push('LOW_LIQUIDITY_SESSION');
  }

  return tags;
}

// ─────────────────────────────────────────────
// Weekly synthesis job
// Compresses all lessons into top 5 rules
// Run via cron — once per week
// Updates agent's learnedRules in DB
// ─────────────────────────────────────────────

export async function synthesiseLessons(agentId: string): Promise<LearnedRule[]> {
  logger.info('Running lesson synthesis', { agentId });

  const allLessons = await prisma.tradeLesson.findMany({
    where:   { agentId },
    orderBy: { createdAt: 'desc' },
    take:    100,
  });

  if (allLessons.length < 5) {
    logger.info('Not enough lessons to synthesise yet', { count: allLessons.length });
    return [];
  }

  const prompt  = buildSynthesisPrompt(allLessons);
  const result  = await getSynthesis(prompt, agentId);

  if (!result.success || !result.data) {
    logger.error('Synthesis Claude call failed', { agentId });
    return [];
  }

  const rules: LearnedRule[] = result.data.rules.map(r => ({
    patternTag: r.patternTag,
    rule:       r.rule,
    frequency:  r.frequency,
    createdAt:  new Date(),
  }));

  // Persist synthesised rules back to agent
  await prisma.agent.update({
    where: { id: agentId },
    data:  { learnedRules: JSON.stringify(rules) },
  });

  logger.info('Synthesis complete', { agentId, rulesCount: rules.length });

  return rules;
}

// ─────────────────────────────────────────────
// Get lesson stats — used by dashboard
// ─────────────────────────────────────────────

export async function getLessonStats(agentId: string) {
  const total = await prisma.tradeLesson.count({ where: { agentId } });

  const byTag = await prisma.tradeLesson.groupBy({
    by:      ['tag'],
    where:   { agentId },
    _count:  { tag: true },
    orderBy: { _count: { tag: 'desc' } },
    take:    10,
  });

  return {
    total,
    topPatterns: byTag.map(t => ({
      tag:   t.tag,
      count: t._count.tag,
    })),
  };
}