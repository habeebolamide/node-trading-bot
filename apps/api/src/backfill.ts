/**
 * Market-data backfill surface (§25 pre-launch prep — operator request).
 *
 * The CLI (`npm run backfill --workspace @tip/scripts`) stays the power tool; this router is
 * the dashboard's one-button flow: POST kicks off a Bybit REST backfill for one symbol across
 * every timeframe + funding + OI, GET returns per-symbol coverage so the UI can show what's
 * loaded (rows + earliest/latest per TF) and whether a run is in flight.
 *
 * Runs in-process — MVP single-operator scale, same pattern as the seeding router. A per-symbol
 * in-memory registry prevents double-starts; on completion the coverage endpoint reflects the
 * new rows. Bybit only for now (memecoin has no historical backfill in MVP, §25). The Batch A
 * pagination fix (2026-09-02, `backfill.ts` header) is what makes this actually cover the range.
 */
import { Router } from 'express';
import { and, count, eq, max, min } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { marketCandle, fundingRate, openInterest } from '@tip/database';
import { marketSymbol, type Timeframe } from '@tip/domain';
import {
  BybitRestClient, DEFAULT_PERP_SYMBOLS, DEFAULT_TIMEFRAMES,
} from '@tip/ingestion';
import { backfillKlines, backfillFunding, backfillOpenInterest } from '@tip/evaluation';

interface BackfillProgress {
  timeframe: string;
  fetched: number;
  inserted: number;
}
interface BackfillJob {
  state: 'running' | 'done' | 'failed';
  months: number;
  from: string;
  to: string;
  startedAt: string;
  finishedAt?: string;
  progress: BackfillProgress[];
  funding?: BackfillProgress;
  openInterest?: BackfillProgress;
  error?: string;
}

const jobs = new Map<string, BackfillJob>();

interface CoveragePerTf {
  timeframe: string;
  rows: number;
  from: string | null;
  to: string | null;
}
interface SymbolCoverage {
  symbol: string;
  perTf: CoveragePerTf[];
  funding: { rows: number; from: string | null; to: string | null };
  openInterest: { rows: number; from: string | null; to: string | null };
  job: BackfillJob | null;
}

async function coverageFor(db: Db, symbol: string): Promise<SymbolCoverage> {
  const perTf: CoveragePerTf[] = [];
  for (const tf of DEFAULT_TIMEFRAMES) {
    const [r] = await db.select({ n: count(), from: min(marketCandle.openTime), to: max(marketCandle.openTime) })
      .from(marketCandle)
      .where(and(eq(marketCandle.symbol, symbol), eq(marketCandle.timeframe, tf)));
    perTf.push({
      timeframe: tf,
      rows: Number(r?.n ?? 0),
      from: r?.from ? (r.from as Date).toISOString() : null,
      to: r?.to ? (r.to as Date).toISOString() : null,
    });
  }
  const [f] = await db.select({ n: count(), from: min(fundingRate.fundingTime), to: max(fundingRate.fundingTime) })
    .from(fundingRate).where(eq(fundingRate.symbol, symbol));
  const [o] = await db.select({ n: count(), from: min(openInterest.snapshotTime), to: max(openInterest.snapshotTime) })
    .from(openInterest).where(eq(openInterest.symbol, symbol));
  return {
    symbol,
    perTf,
    funding: { rows: Number(f?.n ?? 0), from: f?.from ? (f.from as Date).toISOString() : null, to: f?.to ? (f.to as Date).toISOString() : null },
    openInterest: { rows: Number(o?.n ?? 0), from: o?.from ? (o.from as Date).toISOString() : null, to: o?.to ? (o.to as Date).toISOString() : null },
    job: jobs.get(symbol) ?? null,
  };
}

export function backfillRouter(db: Db, opts: { testnet?: boolean } = {}): Router {
  const r = Router();
  const testnet = opts.testnet ?? false;

  /** All-symbol coverage — one call feeds the whole Data page. */
  r.get('/status', async (_req, res) => {
    const symbols = [...DEFAULT_PERP_SYMBOLS];
    const cov = await Promise.all(symbols.map((s) => coverageFor(db, s)));
    res.json({ symbols: cov });
  });

  /** Single-symbol coverage. */
  r.get('/:symbol/status', async (req, res) => {
    const c = await coverageFor(db, req.params.symbol!);
    res.json(c);
  });

  /** Kick off a Bybit REST backfill for one symbol. Async in-process; status polling watches. */
  r.post('/:symbol/run', async (req, res) => {
    const symbol = req.params.symbol!;
    // Bybit symbols are uppercase alnum ending in USDT/USDC/USD. Guard against a random string
    // getting queued as a real REST call — `marketSymbol` is a bare brand cast.
    if (!/^[A-Z0-9]{2,15}(USDT|USDC|USD)$/.test(symbol)) {
      res.status(400).json({ error: 'invalid symbol' }); return;
    }
    const sym = marketSymbol(symbol);
    const existing = jobs.get(symbol);
    if (existing?.state === 'running') {
      res.status(409).json({ error: 'a backfill is already in progress for this symbol' });
      return;
    }
    const body = (req.body ?? {}) as { months?: number; days?: number; timeframes?: Timeframe[]; oiInterval?: string };
    // Accept `days` (finer for short ranges like 15/30d) OR `months`. `days` wins when both given.
    // Clamp to [1 day, 24 months]. `months` is retained on the job for legacy display.
    const rangeDays = body.days !== undefined
      ? Math.max(1, Math.min(24 * 30, body.days))
      : Math.max(1, Math.min(24, body.months ?? 6)) * 30;
    const months = rangeDays / 30;
    const timeframes = body.timeframes && body.timeframes.length > 0 ? body.timeframes : [...DEFAULT_TIMEFRAMES];
    const oiInterval = (body.oiInterval as '5min' | '15min' | '30min' | '1h' | '4h' | '1d') ?? '1h';

    const toMs = Date.now();
    const fromMs = toMs - rangeDays * 24 * 3600_000;
    const job: BackfillJob = {
      state: 'running', months,
      from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(),
      startedAt: new Date().toISOString(), progress: [],
    };
    jobs.set(symbol, job);

    void (async () => {
      const rest = new BybitRestClient({ testnet });
      try {
        for (const tf of timeframes) {
          const r_ = await backfillKlines(rest, db, sym, tf, fromMs, toMs, { delayMs: 150 });
          job.progress.push({ timeframe: tf, fetched: r_.fetched, inserted: r_.inserted });
          jobs.set(symbol, { ...job });
        }
        const f = await backfillFunding(rest, db, sym, fromMs, toMs, { delayMs: 150 });
        job.funding = { timeframe: 'funding', fetched: f.fetched, inserted: f.inserted };
        const oi = await backfillOpenInterest(rest, db, sym, oiInterval, fromMs, toMs, { delayMs: 150 });
        job.openInterest = { timeframe: `OI(${oiInterval})`, fetched: oi.fetched, inserted: oi.inserted };
        jobs.set(symbol, { ...job, state: 'done', finishedAt: new Date().toISOString() });
      } catch (err) {
        jobs.set(symbol, { ...job, state: 'failed', finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err) });
      }
    })();

    res.status(202).json({ started: true, symbol, from: job.from, to: job.to, months });
  });

  return r;
}

/** Test-only. */
export function clearBackfillJobsForTests(): void { jobs.clear(); }
