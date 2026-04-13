import logger from '../utils/logger';
import { EconomicEvent, NewsItem } from '../types/market.types';

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const CRYPTOPANIC_URL = 'https://cryptopanic.com/api/v1/posts';
const POLL_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 minutes
const NEWS_WINDOW_MS = 30 * 60 * 1000;  // flag news from last 30 mins
const EVENT_WINDOW_MS = 30 * 60 * 1000;  // block trading 30 mins before event

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

  // Fetch immediately on start
  await fetchNews();
  await fetchEconomicEvents();

  // Then poll on interval
  pollTimer = setInterval(async () => {
    await fetchNews();
    await fetchEconomicEvents();
  }, POLL_INTERVAL_MS);
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
  const cutoff = new Date(Date.now() - NEWS_WINDOW_MS);
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
  try {
    const url = 'https://cryptocurrency.cv/api/news?limit=10&category=solana';

    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('Free Crypto News fetch failed', { status: res.status });
      return;
    }

    const data = await res.json();

    logger.info({ data: data.articles });

    recentNews = (data.articles ?? []).map((item: any): NewsItem => ({
      id: Math.random().toString(),
      headline: item.title,
      source: item.source ?? 'unknown',
      sentiment: item.sentiment ?? 'neutral', 
      impact: item.impact ?? (item.reputation && item.reputation > 70 ? 'high' : 'medium'),
      pairs: ['SOLUSDT'],
      url: item.link,
      publishedAt: new Date(item.pubDate),
    }));

    lastFetchAt = new Date();
    logger.info('News fetched', { news: recentNews });

  } catch (error) {
    logger.error('Failed to fetch news', { error });
  }
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

// CryptoPanic uses vote counts to signal sentiment
function mapSentiment(votes: any): NewsItem['sentiment'] {
  if (!votes) return 'neutral';
  const bullish = votes.positive ?? 0;
  const bearish = votes.negative ?? 0;
  if (bullish > bearish * 1.5) return 'positive';
  if (bearish > bullish * 1.5) return 'negative';
  return 'neutral';
}

// More negative votes = higher impact (controversy = market moving)
function mapImpact(votes: any): NewsItem['impact'] {
  if (!votes) return 'low';
  const total = (votes.positive ?? 0) + (votes.negative ?? 0) + (votes.important ?? 0);
  if (total > 50 || votes.important > 10) return 'high';
  if (total > 20) return 'medium';
  return 'low';
}

// CryptoPanic currencies: [{ code: "BTC", ... }] → ["BTC", "BTCUSDT"]
function extractPairsFromCurrencies(currencies: any[]): string[] {
  return currencies.flatMap(c => [c.code, `${c.code}USDT`]);
}

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