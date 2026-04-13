import WebSocket from 'ws';
import logger from '../utils/logger';
import { prisma } from '../lib/prisma';
import { agentManager } from '../agents';

const BUFFER_SIZE = 200;
const PING_INTERVAL = 20_000;
const TIMEFRAMES = ['1', '5', '15', '60', '240'];

// in-memory buffer — [pair][timeframe] = Candle[]
const candleBuffers: Record<string, Record<string, any[]>> = {};

export async function seedCandleBuffers(pairs: string[]): Promise<void> {
  logger.info('Seeding candle buffers', { pairs });

  const timeframes = ['5', '15', '60', '240'];
  // const BASE_URL = process.env.BYBIT_TESTNET === 'true'
  //   ? 'https://api-testnet.bybit.com'
  //   : 'https://api.bybit.com';

  const BASE_URL = 'https://api.bybit.com';

  for (const pair of pairs) {
    if (!candleBuffers[pair]) candleBuffers[pair] = {};

    for (const tf of timeframes) {
      try {
        const url = `${BASE_URL}/v5/market/kline?symbol=${pair}&interval=${tf}&limit=200`;
        const res = await fetch(url);
        const data = await res.json() as any;


        if (data.retCode !== 0) {
          logger.warn('Failed to fetch candles', { pair, tf, msg: data.retMsg });
          continue;
        }

        // Bybit returns newest first — reverse to oldest first
        const rows: any[][] = (data.result?.list ?? []).reverse();

        candleBuffers[pair][tf] = rows.map(row => ({
          pair,
          interval: tf,
          openTime: Number(row[0]),
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseFloat(row[5]),
          closeTime: Number(row[0]),
        }));

        // logger.info('Buffer seeded', {
        //   candleBuffers
        // });

      } catch (error: any) {
        logger.error('Seed error', { pair, tf, error: error.message });
      }
    }
  }

  console.log('All buffers seeded — bot ready');
}

export function initBuffer(pair: string, tf: string): void {
  if (!candleBuffers[pair]) candleBuffers[pair] = {};
  if (!candleBuffers[pair][tf]) candleBuffers[pair][tf] = [];
}

export function getCandleBuffer(pair: string, tf: string): any[] {
  
  if (!candleBuffers[pair]) candleBuffers[pair] = {};
  if (!candleBuffers[pair][tf]) candleBuffers[pair][tf] = [];
  return candleBuffers[pair][tf];
}

// event listeners — agent loops subscribe here
type CandleHandler = (candle: any) => void;
const listeners: Record<string, CandleHandler[]> = {};

export function onCandle(pair: string, tf: string, handler: CandleHandler) {
  const key = `${pair}:${tf}`;
  if (!listeners[key]) listeners[key] = [];
  listeners[key].push(handler);
}

export class BybitWebSocket {
  private ws: WebSocket | null = null;
  private subscribedTopics = new Set<string>();
  private reconnectAttempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly MAX_RECONNECT = 10;

  public async connectWebSocket(): Promise<void> {
    // const url = process.env.BYBIT_TESTNET === 'true'
    //   ? 'wss://stream-testnet.bybit.com/v5/public/linear'
    //   : 'wss://stream.bybit.com/v5/public/linear';

    const url = 'wss://stream.bybit.com/v5/public/linear';

    this.ws = new WebSocket(url, { handshakeTimeout: 10_000 });

    this.ws.on('open', async () => {
      logger.info('Bybit WebSocket connected');
      this.reconnectAttempts = 0;
      await this.subscribeToAllPairs();
      this.startPing();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);  // ← was missing
      } catch (e) {
        logger.error('WebSocket message parse error', { error: e });
      }
    });

    this.ws.on('close', (code) => {
      this.stopPing();
      logger.warn('WebSocket closed', { code });
      this.handleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error('WebSocket error', { error: err.message });
    });
  }

  private async subscribeToAllPairs(): Promise<void> {
    const agents = await agentManager.loadAgents();
    const uniquePairs = [...new Set(agents.map(a => a.pair))];

    // initialise buffers for each pair + timeframe
    uniquePairs.forEach(pair => {
      if (!candleBuffers[pair]) candleBuffers[pair] = {};  // only if missing
      TIMEFRAMES.forEach(tf => {
        if (!candleBuffers[pair][tf]) candleBuffers[pair][tf] = []; // only if missing
      });
    });
    
    const topics: string[] = [];

    uniquePairs.forEach(pair => {
      TIMEFRAMES.forEach(tf => {
        const topic = `kline.${tf}.${pair}`;
        if (!this.subscribedTopics.has(topic)) {
          topics.push(topic);
          this.subscribedTopics.add(topic);
        }
      });
    });

    if (topics.length > 0 && this.ws) {
      logger.info('Subscribing to topics', { topics });

      this.ws.send(JSON.stringify({ op: 'subscribe', args: topics }));
      logger.info(`Subscribed to ${topics.length} topics`);
    }
  }

  private handleMessage(message: any): void {
    if (message.op === 'pong') return;

    if (message.op === 'subscribe') {
      logger.info('Subscription confirmed', { success: message.success });
      return;
    }

    if (message.topic?.startsWith('kline.')) {
      this.handleKline(message);
    }
  }

  private handleKline(message: any): void {
    const parts = message.topic.split('.');
    const tf = parts[1];
    const pair = parts[2];
    const klineData = message.data?.[0];

    if (!klineData || !klineData.confirm) return;

    const candle = {
      pair,
      interval: tf,
      openTime: Number(klineData.start),
      open: parseFloat(klineData.open),
      high: parseFloat(klineData.high),
      low: parseFloat(klineData.low),
      close: parseFloat(klineData.close),
      volume: parseFloat(klineData.volume),
      closeTime: Number(klineData.end),
    };

    // update buffer
    const buffer = candleBuffers[pair]?.[tf];
    if (buffer) {
      buffer.push(candle);
      if (buffer.length > BUFFER_SIZE) buffer.shift();
    }

    // save to DB (non-blocking)
    this.saveCandle(candle).catch(err =>
      logger.error('Failed to save candle', { error: err })
    );

    // notify agent loops
    const key = `${pair}:${tf}`;
    listeners[key]?.forEach(handler => handler(candle));

    logger.info('Candle closed', { pair, tf, close: candle.close });
  }

  private async saveCandle(candle: any): Promise<void> {
    await prisma.candle.upsert({
      where: {
        pair_timeframe_timestamp: {
          pair: candle.pair,
          timeframe: candle.interval,
          timestamp: BigInt(candle.openTime),
        },
      },
      update: {
        open: candle.open, high: candle.high,
        low: candle.low, close: candle.close, volume: candle.volume,
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

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT) {
      logger.error('Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;

    logger.warn(`Reconnecting in ${delay}ms`, { attempt: this.reconnectAttempts });
    setTimeout(() => this.connectWebSocket(), delay);
  }

  public close(): void {
    this.stopPing();
    this.ws?.close();
  }
}

export { candleBuffers };
