import logger from '../utils/logger';
import { getPostMortem, getSynthesis } from '../claude/client';
import { buildPostMortemPrompt, buildSynthesisPrompt } from '../claude/prompts';
import { ClosedTrade } from '../types/trade.types';
import { PostMortemResult } from '../types/claude.types';
import { RelevantLesson, TradeLessonInput } from '../types/risk.types';
import { prisma } from '../lib/prisma';
import { LearnedRule } from '../types/agent.types';


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

  // Fetch matching lessons from DB
  const lessons = await prisma.tradeLesson.findMany({
    where: {
      agentId,
      tag: { in: relevantTags },
    },
    orderBy: { createdAt: 'desc' },
    take: 20, // fetch more than needed — we'll rank and trim
  });

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
// Tag detector
// Pure logic — detects which lesson tags are
// relevant to the current market setup
// Zero tokens, zero cost
// ─────────────────────────────────────────────

function detectRelevantTags(ctx: {
  regime:      string;
  signal:      string;
  rsi:         number;
  volumeRatio: number;
  dayOfWeek:   number;
}): string[] {
  const tags: string[] = [];

  // Counter trend entry — going against the big trend
  if (
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

  // Overbought entering long
  if (ctx.rsi > 68 && ctx.signal === 'LONG') {
    tags.push('OVERBOUGHT_LONG');
    tags.push('RSI_EXTREME_ENTRY');
  }

  // Oversold entering short
  if (ctx.rsi < 32 && ctx.signal === 'SHORT') {
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