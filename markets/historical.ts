import { prisma } from '../lib/prisma.js';
import logger from '../utils/logger.js';
import type { Candle, CandleInterval } from '../types/market.types.js';
import { candleBuffers } from '../markets/websocket.js';

// ─────────────────────────────────────────────
// Bybit REST API — kline endpoint
// ─────────────────────────────────────────────

const BASE_URL = process.env.BYBIT_TESTNET === 'true'
    ? 'https://api.bybit.com'
    : 'https://api.bybit.com';

// ─────────────────────────────────────────────
// Fetch historical candles from Bybit REST
// Returns last `limit` candles for pair + timeframe
// ─────────────────────────────────────────────

export async function fetchHistoricalCandles(
    pair: string,
    timeframe: CandleInterval,
    limit: number = 200,
): Promise<Candle[]> {
    try {
        const url = `${BASE_URL}/v5/market/kline?` +
            `symbol=${pair}` +
            `&interval=${timeframe}` +
            `&limit=${limit}`;

        const res = await fetch(url);

        if (!res.ok) {
            logger.error('Bybit REST fetch failed', { status: res.status, pair, timeframe });
            return [];
        }

        const data = await res.json() as any;

        if (data.retCode !== 0) {
            logger.error('Bybit REST error', { retMsg: data.retMsg, pair, timeframe });
            return [];
        }

        // Bybit returns newest first — reverse so oldest is first
        const rows: any[][] = (data.result?.list ?? []).reverse();

        const candles: Candle[] = rows.map(row => ({
            pair,
            interval: timeframe,
            openTime: Number(row[0]),
            open: parseFloat(row[1]),
            high: parseFloat(row[2]),
            low: parseFloat(row[3]),
            close: parseFloat(row[4]),
            volume: parseFloat(row[5]),
            closeTime: Number(row[0]), // Bybit doesn't give closeTime in kline — use openTime
        }));

        logger.info('Historical candles fetched', {
            pair,
            timeframe,
            count: candles.length,
        });

        return candles;

    } catch (error: any) {
        logger.error('Failed to fetch historical candles', {
            pair,
            timeframe,
            error: error.message,
        });
        return [];
    }
}

// ─────────────────────────────────────────────
// Seed all candle buffers on startup
// Call this in index.ts after WebSocket connects
// so indicators work immediately on first candle
// ─────────────────────────────────────────────

export async function seedCandleBuffers(pairs: string[]): Promise<void> {
    const timeframes: CandleInterval[] = ['1', '5', '15', '60', '240'];

    for (const pair of pairs) {
        // Initialise the pair if it doesn't exist
        if (!candleBuffers[pair]) candleBuffers[pair] = {};

        for (const tf of timeframes) {
            const candles = await fetchHistoricalCandles(pair, tf, 200);
            if (candles.length === 0) continue;

            // Write directly into the shared object
            candleBuffers[pair][tf] = candles;

            logger.info('Buffer seeded', {
                pair,
                tf,
                count: candles.length,
                latestClose: candles.at(-1)?.close,
            });
        }
    }

    logger.info('All candle buffers seeded — bot ready');
}

// ─────────────────────────────────────────────
// Fetch a full historical RANGE, paginating Bybit's 1000-candle cap.
// The single-shot fetchHistoricalCandles above only returns the most recent N;
// a backtest needs months of history, so we page backward from `endMs` until
// the whole [startMs, endMs] window is covered.
// category=linear — these are USDT perpetuals, matching the live feed.
// ─────────────────────────────────────────────

const PAGE_LIMIT = 1000;
const PAGE_DELAY_MS = 150; // be polite to Bybit's rate limiter

export async function fetchHistoricalRange(
    pair: string,
    timeframe: CandleInterval,
    startMs: number,
    endMs: number,
): Promise<Candle[]> {
    const byTime = new Map<number, Candle>();
    let cursorEnd = endMs;

    while (cursorEnd > startMs) {
        const url = `${BASE_URL}/v5/market/kline?` +
            `category=linear` +
            `&symbol=${pair}` +
            `&interval=${timeframe}` +
            `&start=${startMs}` +
            `&end=${cursorEnd}` +
            `&limit=${PAGE_LIMIT}`;

        let rows: any[][];
        try {
            const res = await fetch(url);
            if (!res.ok) {
                logger.error('Bybit range fetch failed', { status: res.status, pair, timeframe });
                break;
            }
            const data = await res.json() as any;
            if (data.retCode !== 0) {
                logger.error('Bybit range error', { retMsg: data.retMsg, pair, timeframe });
                break;
            }
            // Newest first — oldest last.
            rows = data.result?.list ?? [];
        } catch (error: any) {
            logger.error('Bybit range fetch threw', { pair, timeframe, error: error.message });
            break;
        }

        if (rows.length === 0) break;

        let oldestInPage = cursorEnd;
        for (const row of rows) {
            const openTime = Number(row[0]);
            oldestInPage = Math.min(oldestInPage, openTime);
            if (openTime < startMs || openTime > endMs) continue;
            byTime.set(openTime, {
                pair,
                interval: timeframe,
                openTime,
                open: parseFloat(row[1]),
                high: parseFloat(row[2]),
                low: parseFloat(row[3]),
                close: parseFloat(row[4]),
                volume: parseFloat(row[5]),
                closeTime: openTime,
            });
        }

        // Page backward. Stop if we've reached the start or made no progress.
        if (oldestInPage <= startMs || oldestInPage >= cursorEnd) break;
        cursorEnd = oldestInPage - 1;

        await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
    }

    const candles = Array.from(byTime.values()).sort((a, b) => a.openTime - b.openTime);
    logger.info('Historical range fetched', {
        pair, timeframe, count: candles.length,
        from: new Date(startMs).toISOString(),
        to: new Date(endMs).toISOString(),
    });
    return candles;
}

// ─────────────────────────────────────────────
// Persist historical candles to DB.
// Bulk insert with skipDuplicates — historical OHLCV is immutable, so we never
// need to update an existing row. Chunked to stay under statement limits.
// Idempotent: re-running a backfill just skips rows already present.
// ─────────────────────────────────────────────

export async function persistCandles(candles: Candle[]): Promise<number> {
    const CHUNK = 1000;
    let written = 0;

    for (let i = 0; i < candles.length; i += CHUNK) {
        const chunk = candles.slice(i, i + CHUNK);
        const res = await prisma.candle.createMany({
            data: chunk.map(c => ({
                pair: c.pair,
                timeframe: c.interval,
                timestamp: BigInt(c.openTime),
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
            })),
            skipDuplicates: true,
        });
        written += res.count;
    }

    return written;
}