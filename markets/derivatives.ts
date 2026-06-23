import logger from '../utils/logger.js';

// ─────────────────────────────────────────────
// Derivatives positioning — funding rate + open interest.
//
// These are perp-specific signals the candle feed cannot carry:
//   • Funding rate — who is paying whom. Persistent positive funding = longs
//     crowded (reversal risk on an unwind); persistent negative = shorts
//     crowded (squeeze risk). Extremes mark crowded trades.
//   • Open interest — how much money is committed. Rising OI = new positions
//     entering (conviction behind the move); falling OI = positions closing
//     (exhaustion / unwind).
//
// Slow-moving signals (funding settles every 8h), so we poll on an interval and
// serve from cache — exactly like the news monitor. Gated to day/swing in the
// prompt; a 5-minute scalp rarely holds across a funding boundary.
// ─────────────────────────────────────────────

const BASE_URL = 'https://api.bybit.com';
const POLL_INTERVAL_MS = 5 * 60 * 1000;   // refresh every 5 minutes
const OI_LOOKBACK_HOURS = 6;              // window for the OI trend read

interface DerivativesSnapshot {
  fundingRate:     number;   // raw fraction per 8h (e.g. 0.0001 = 0.01%)
  nextFundingTime: number;   // ms epoch
  openInterestUsd: number;   // USD notional (latest)
  oiChangePct:     number;   // % change over OI_LOOKBACK_HOURS
  fetchedAt:       Date;
}

const store: Record<string, DerivativesSnapshot> = {};
let pollTimer: NodeJS.Timeout | null = null;
let monitoredPairs: string[] = [];

// ─────────────────────────────────────────────
// Public — start polling, call once from index.ts
// ─────────────────────────────────────────────

export async function startDerivativesMonitor(pairs: string[]): Promise<void> {
  monitoredPairs = [...new Set(pairs)];
  logger.info('Derivatives monitor starting', { pairs: monitoredPairs });

  await Promise.all(monitoredPairs.map(fetchDerivatives));

  pollTimer = setInterval(() => {
    void Promise.all(monitoredPairs.map(fetchDerivatives));
  }, POLL_INTERVAL_MS);
}

export function stopDerivativesMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─────────────────────────────────────────────
// Prompt context — sync read from cache (like getNewsContextForPrompt).
// Returns a 2-line funding + OI read, or a one-liner when not yet cached.
// ─────────────────────────────────────────────

export function getDerivativesContextForPrompt(pair: string): string {
  const s = store[pair];
  if (!s) return 'Derivatives data unavailable.';

  // ── Funding ──
  const r    = s.fundingRate;
  const absR = Math.abs(r);
  const pct  = (r * 100).toFixed(4);
  const dir      = r >= 0 ? 'longs pay shorts' : 'shorts pay longs';
  const balanced = absR < 0.00005;
  const crowd =
    balanced       ? 'balanced — no positioning skew' :
    absR < 0.0005  ? (r >= 0 ? 'mild long lean' : 'mild short lean') :
    absR < 0.001   ? (r >= 0 ? 'CROWDED LONG — reversal risk if it unwinds'
                             : 'CROWDED SHORT — squeeze risk if it unwinds') :
                     (r >= 0 ? 'EXTREME long crowding — high reversal risk'
                             : 'EXTREME short crowding — high squeeze risk');
  // At near-zero funding the direction is noise — drop it.
  const desc = balanced ? crowd : `${dir} — ${crowd}`;
  const hrs  = Math.max(0, (s.nextFundingTime - Date.now()) / 3_600_000);
  const fundingLine =
    `Funding: ${r >= 0 ? '+' : ''}${pct}% per 8h (${desc}) | next funding ~${hrs.toFixed(1)}h`;

  // ── Open interest ──
  const oiUsd = s.openInterestUsd;
  const oiUsdStr = oiUsd >= 1e9 ? `$${(oiUsd / 1e9).toFixed(2)}B` : `$${(oiUsd / 1e6).toFixed(0)}M`;
  const ch = s.oiChangePct;
  const oiTrend =
    ch >  2 ? `rising ${ch.toFixed(1)}% / ${OI_LOOKBACK_HOURS}h (new money entering — conviction behind the move)` :
    ch < -2 ? `falling ${Math.abs(ch).toFixed(1)}% / ${OI_LOOKBACK_HOURS}h (positions unwinding — possible exhaustion)` :
              `flat (${ch >= 0 ? '+' : ''}${ch.toFixed(1)}% / ${OI_LOOKBACK_HOURS}h)`;
  const oiLine = `Open interest: ${oiUsdStr} notional, ${oiTrend}`;

  return `${fundingLine}\n${oiLine}`;
}

// ─────────────────────────────────────────────
// Fetch — tickers (current funding + OI) + OI history (trend)
// ─────────────────────────────────────────────

async function fetchDerivatives(pair: string): Promise<void> {
  try {
    const [ticker, oiChangePct] = await Promise.all([
      fetchTicker(pair),
      fetchOiTrend(pair),
    ]);
    if (!ticker) return;

    store[pair] = {
      fundingRate:     ticker.fundingRate,
      nextFundingTime: ticker.nextFundingTime,
      openInterestUsd: ticker.openInterestUsd,
      oiChangePct,
      fetchedAt:       new Date(),
    };
  } catch (error: any) {
    logger.warn('Failed to fetch derivatives', { pair, error: error?.message ?? error });
  }
}

async function fetchTicker(pair: string): Promise<{
  fundingRate: number; nextFundingTime: number; openInterestUsd: number;
} | null> {
  const url = `${BASE_URL}/v5/market/tickers?category=linear&symbol=${pair}`;
  const res = await fetch(url);
  const data = await res.json() as any;

  if (data.retCode !== 0) {
    logger.warn('Bybit tickers fetch error', { pair, msg: data.retMsg });
    return null;
  }

  const r = data.result?.list?.[0];
  if (!r) return null;

  return {
    fundingRate:     parseFloat(r.fundingRate),
    nextFundingTime: Number(r.nextFundingTime),
    openInterestUsd: parseFloat(r.openInterestValue),
  };
}

// OI history is newest-first; compare the latest point to ~OI_LOOKBACK_HOURS ago.
async function fetchOiTrend(pair: string): Promise<number> {
  const limit = OI_LOOKBACK_HOURS + 1;
  const url = `${BASE_URL}/v5/market/open-interest?category=linear&symbol=${pair}&intervalTime=1h&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json() as any;

  if (data.retCode !== 0) return 0;

  const list = data.result?.list ?? [];
  if (list.length < 2) return 0;

  const newest = parseFloat(list[0].openInterest);
  const oldest = parseFloat(list[list.length - 1].openInterest);
  if (!(oldest > 0)) return 0;

  return ((newest - oldest) / oldest) * 100;
}

// ─────────────────────────────────────────────
// Util — expose for health checks
// ─────────────────────────────────────────────

export function getDerivativesMonitorStatus() {
  return {
    running: pollTimer !== null,
    pairs:   Object.keys(store),
    monitoredPairs,
  };
}
