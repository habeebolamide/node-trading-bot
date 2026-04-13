import { prisma } from '../lib/prisma';
import logger from '../utils/logger';
import { Candle, CandleInterval } from '../types/market.types';
import { candleBuffers } from '../markets/websocket';

// ─────────────────────────────────────────────
// Bybit REST API — kline endpoint
// ─────────────────────────────────────────────

const BASE_URL = process.env.BYBIT_TESTNET === 'true'
    ? 'https://api-testnet.bybit.com'
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
    const timeframes: CandleInterval[] = ['5', '15', '60', '240'];

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
// Persist historical candles to DB
// Uses upsert — safe to call multiple times
// ─────────────────────────────────────────────

async function persistCandles(candles: Candle[]): Promise<void> {
    for (const candle of candles) {
        await prisma.candle.upsert({
            where: {
                pair_timeframe_timestamp: {
                    pair: candle.pair,
                    timeframe: candle.interval,
                    timestamp: BigInt(candle.openTime),
                },
            },
            update: {
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
            },
            create: {
                pair: candle.pair,
                timeframe: candle.interval,
                timestamp: BigInt(candle.openTime),
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
            },
        });
    }
}