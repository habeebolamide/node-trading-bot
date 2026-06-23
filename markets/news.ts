import logger from '../utils/logger.js';
import type { EconomicEvent, NewsItem } from '../types/market.types.js';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

// Crypto-news RSS feeds — keyless and bot-friendly. Unlike the JSON anti-bot
// endpoints (cryptocurrency.cv, TradingView) which 403 server requests, RSS is
// built to be machine-fetched. Headlines only; the LLM reads and weighs them.
const RSS_FEEDS = [
  'https://cointelegraph.com/rss',
  'https://decrypt.co/feed',
];
const POLL_INTERVAL_MS = 5 * 60 * 1000;             // re-fetch every 5 minutes
const NEWS_WINDOW_MS = 30 * 60 * 1000;              // "breaking" window — drives the high-impact significance gate
const NEWS_CONTEXT_WINDOW_MS = 6 * 60 * 60 * 1000;  // wider window for prompt context (RSS isn't minute-fresh)
const EVENT_WINDOW_MS = 30 * 60 * 1000;             // block trading 30 mins before event
// Cheap keyword heuristic for "market-moving" — RSS carries no impact field.
const HIGH_IMPACT_RE = /\b(sec|etf|hack|exploit|breach|lawsuit|ban|halt|fomc|cpi|fed|rate (cut|hike)|default|liquidat|crash|delist)\b/i;

// ─────────────────────────────────────────────
// In-memory store
// ─────────────────────────────────────────────

let recentNews: NewsItem[] = [];
let upcomingEvents: EconomicEvent[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let lastFetchAt: Date | null = null;

// ─────────────────────────────────────────────
// Public — start polling, call once from index.ts
// ─────────────────────────────────────────────

export async function startNewsMonitor(): Promise<void> {
  // if (!process.env.CRYPTOPANIC_API_KEY) {
  //   logger.warn('CRYPTOPANIC_API_KEY not set — news monitor disabled');
  //   return;
  // }

  logger.info('News monitor starting');

  // Fetch immediately on start, then poll. Economic-calendar fetch is disabled:
  // the only free endpoint (TradingView) 403s server requests, so a reliable
  // free econ calendar is an open gap. upcomingEvents stays empty and is handled
  // gracefully by getUpcomingEventWarning / isNearEconomicEvent.
  await fetchNews();

  pollTimer = setInterval(() => { void fetchNews(); }, POLL_INTERVAL_MS);
}

export function stopNewsMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─────────────────────────────────────────────
// Public queries — used by agent loop + regime
// ─────────────────────────────────────────────

// Returns true if high-impact news dropped in last 30 mins
// for the given pair — used by significance checker
export function hasRecentHighImpactNews(pair: string): boolean {
  const cutoff = new Date(Date.now() - NEWS_WINDOW_MS);
  const base = extractBaseCurrency(pair); // BTCUSDT → BTC

  return recentNews.some(news =>
    news.impact === 'high' &&
    news.publishedAt > cutoff &&
    (news.pairs.includes(pair) || news.pairs.includes(base) || news.pairs.length === 0)
  );
}

// Returns true if a major economic event is within the window
// Agent loop uses this to block new entries before big events
export function isNearEconomicEvent(): boolean {
  const now = Date.now();
  const window = EVENT_WINDOW_MS;

  return upcomingEvents.some(event => {
    const eventTime = event.scheduledAt.getTime();
    const diff = eventTime - now;
    return diff > 0 && diff < window && event.impact === 'high';
  });
}

// Returns upcoming high-impact event name + time for prompt context
export function getUpcomingEventWarning(): string | null {
  const now = Date.now();

  const next = upcomingEvents
    .filter(e => {
      const diff = e.scheduledAt.getTime() - now;
      return diff > 0 && diff < EVENT_WINDOW_MS && e.impact === 'high';
    })
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .at(0);

  if (!next) return null;

  const minsAway = Math.round((next.scheduledAt.getTime() - now) / 60_000);
  return `⚠️ ${next.name} in ${minsAway} minutes — avoid new entries`;
}

// Returns recent news headlines formatted for Claude prompt
export function getNewsContextForPrompt(pair: string): string {
  const cutoff = new Date(Date.now() - NEWS_CONTEXT_WINDOW_MS);
  const base = extractBaseCurrency(pair);

  const relevant = recentNews
    .filter(news =>
      news.publishedAt > cutoff &&
      (news.pairs.includes(pair) || news.pairs.includes(base) || news.pairs.length === 0)
    )
    .slice(0, 5); // max 5 headlines — keep prompt lean

  if (relevant.length === 0) {
    return 'No significant news in the last 30 minutes.';
  }

  const lines = relevant.map(n =>
    `[${n.impact.toUpperCase()}] [${n.sentiment}] ${n.headline}`
  );

  const eventWarning = getUpcomingEventWarning();
  if (eventWarning) lines.unshift(eventWarning);

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Fetch news from CryptoPanic
// ─────────────────────────────────────────────

async function fetchNews(): Promise<void> {
  const collected: NewsItem[] = [];

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; trading-bot/1.0)' },
      });
      if (!res.ok) {
        logger.warn('RSS fetch failed', { feed, status: res.status });
        continue;
      }
      collected.push(...parseRssItems(await res.text()));
    } catch (error) {
      logger.warn('RSS fetch error', { feed, error: (error as Error).message });
    }
  }

  // Keep the last good batch on a transient all-feeds failure rather than
  // blanking the NEWS block.
  if (collected.length === 0) return;

  // Newest first, dedupe by headline, cap the in-memory store.
  const seen = new Set<string>();
  recentNews = collected
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .filter(n => (seen.has(n.headline) ? false : (seen.add(n.headline), true)))
    .slice(0, 40);

  lastFetchAt = new Date();
}

// Minimal dependency-free RSS 2.0 parser — pulls title/link/pubDate from each
// <item>, handling CDATA-wrapped fields. Good enough for headline awareness;
// not a general XML parser.
function parseRssItems(xml: string): NewsItem[] {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const items: NewsItem[] = [];

  for (const block of blocks) {
    const headline = decodeEntities(extractTag(block, 'title'));
    if (!headline) continue;

    const link    = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const when    = pubDate ? new Date(pubDate) : new Date();

    items.push({
      id:          link || headline,
      headline,
      source:      'rss',
      sentiment:   'neutral',                                  // RSS has none; the LLM reads the headline itself
      impact:      HIGH_IMPACT_RE.test(headline) ? 'high' : 'medium',
      pairs:       [],                                         // broad market news — matches every pair's filter
      url:         link,
      publishedAt: isNaN(when.getTime()) ? new Date() : when,
    });
  }

  return items;
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'));
  return m?.[1]?.trim() ?? '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#8217;/g, '’');
}

// ─────────────────────────────────────────────
// Fetch economic calendar
// Using a free public API — swap for a paid one
// if you need more reliable coverage
// ─────────────────────────────────────────────

async function fetchEconomicEvents(): Promise<void> {
  try {
    // Using investing.com calendar scrape via a proxy
    // Replace with a proper economic calendar API if available
    // e.g. https://api.tradingeconomics.com/calendar
    const res = await fetch(
      'https://economic-calendar.tradingview.com/events?' +
      'from=' + new Date().toISOString() +
      '&to=' + new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() +
      '&importance=3' // high importance only
    );

    if (!res.ok) {
      logger.warn('Economic calendar fetch failed', { status: res.status });
      return;
    }

    const data = await res.json() as any;

    upcomingEvents = (data.result ?? [])
      .filter((e: any) => e.importance >= 3)
      .map((e: any): EconomicEvent => ({
        name: e.title,
        impact: 'high',
        scheduledAt: new Date(e.date),
        currency: e.currency ?? 'USD',
      }));

    logger.info('Economic events fetched', { count: upcomingEvents.length });

  } catch (error) {
    // Economic calendar is nice-to-have — don't crash if it fails
    logger.warn('Failed to fetch economic events', { error });
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

// BTCUSDT → BTC, ETHUSDT → ETH
function extractBaseCurrency(pair: string): string {
  return pair.replace('USDT', '').replace('BUSD', '').replace('USD', '');
}

// ─────────────────────────────────────────────
// Util — expose for health checks
// ─────────────────────────────────────────────

export function getNewsMonitorStatus() {
  return {
    running: pollTimer !== null,
    lastFetchAt,
    newsCount: recentNews.length,
    eventCount: upcomingEvents.length,
  };
}