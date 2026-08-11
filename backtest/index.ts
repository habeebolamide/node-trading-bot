import logger from '../utils/logger.js';
import { getEntrySignal, getManagementDecision } from '../claude/client.js';
import { buildEntryPrompt, buildManagementPrompt, buildSystemPrompt } from '../claude/prompts.js';
import { validateEntrySignal } from '../risk/index.js';
import { getRelevantLessons } from '../learning/index.js';
import type { Agent } from '../types/agent.types.js';
import type { BacktestConfig, BacktestResult, BacktestTrade, MonthlyReturn } from '../types/risk.types.js';
import type { Candle, CandleInterval, MultiTimeframeData, TimeframeSnapshot } from '../types/market.types.js';
import type { OpenTrade } from '../types/trade.types.js';
import type { EntrySignal, ManagementDecision } from '../types/claude.types.js';
import { detectRegime } from '../markets/regime.js';
import { calculateIndicators } from '../markets/indicators.js';
import { prisma } from '../lib/prisma.js';


// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const MIN_CANDLES_REQUIRED = 200; // need enough history for EMA200

// ─────────────────────────────────────────────
// Cost model — applied to every simulated fill so the backtest P&L reflects
// what live trading actually costs. Without these, the backtest reports a
// falsely rosy number (zero-cost, exact-level fills) that fails in production.
// Rates are % and easy to tune; defaults are conservative Bybit-perp figures.
// ─────────────────────────────────────────────
const TAKER_FEE_PCT   = 0.055; // taker fee per side, % of notional
const ENTRY_SLIP_PCT  = 0.02;  // adverse slippage on entry fill, %
const STOP_SLIP_PCT   = 0.05;  // adverse slippage when a stop gaps through, %
const EXIT_SLIP_PCT   = 0.02;  // adverse slippage on a discretionary market close, %
// TP is a resting limit order — it fills at the level with no adverse slippage.

// How many 1h candles a placed entry order rests before it expires unfilled.
// Mirrors live PendingSignal expiry so the backtest doesn't fill stale orders.
const ENTRY_EXPIRY_CANDLES = 4;

// Adverse slippage: shift a fill price in the direction that hurts the trader.
// LONG pays up on entry / receives less on exit; SHORT is the mirror.
function applySlippage(
  price:     number,
  direction: 'LONG' | 'SHORT',
  side:      'entry' | 'exit',
  slipPct:   number,
): number {
  const worseUp =
    (direction === 'LONG'  && side === 'entry') ||
    (direction === 'SHORT' && side === 'exit');
  return price * (worseUp ? 1 + slipPct / 100 : 1 - slipPct / 100);
}

// ─────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────

export async function runBacktest(
  agent:  Agent,
  config: BacktestConfig,
): Promise<BacktestResult> {
  logger.info('Backtest starting', {
    agent:     agent.name,
    pair:      config.pair,
    startDate: config.startDate,
    endDate:   config.endDate,
  });

  // Load historical candles from DB for all timeframes
  const candles = await loadHistoricalCandles(
    config.pair,
    config.startDate,
    config.endDate,
  );

  const candles1h  = candles['60']  ?? [];
  const candles4h  = candles['240'] ?? [];
  const candles15m = candles['15']  ?? [];

  if (candles1h.length < MIN_CANDLES_REQUIRED) {
    throw new Error(
      `Not enough historical data. Need ${MIN_CANDLES_REQUIRED} candles, got ${candles1h.length}`
    );
  }

  logger.info('Historical data loaded', {
    candles1h:  candles1h.length,
    candles4h:  candles4h.length,
    candles15m: candles15m.length,
  });

  // Run the simulation
  const trades = await simulate(agent, config, candles);

  // Analyse results
  const result = analyseResults(config, trades);

  // Save to DB
  await saveBacktestResult(agent.id, config, result);

  logger.info('Backtest complete', {
    trades:      result.totalTrades,
    winRate:     result.winRate,
    netPnl:      result.netPnlPct,
    maxDrawdown: result.maxDrawdownPct,
  });

  return result;
}

// ─────────────────────────────────────────────
// Simulation loop
// Walks candles one by one — never peeks ahead
// ─────────────────────────────────────────────

interface PendingEntry {
  signal:          EntrySignal;
  direction:       'LONG' | 'SHORT';
  positionSize:    number;
  expiresAtIndex:  number;
}

async function simulate(
  agent:   Agent,
  config:  BacktestConfig,
  candles: Record<string, Candle[]>,
): Promise<BacktestTrade[]> {
  const trades:     BacktestTrade[]  = [];
  const candles1h   = candles['60'] ?? [];

  let openTrade:    OpenTrade | null      = null;
  let pendingEntry: PendingEntry | null   = null;
  let state:        'IDLE' | 'IN_TRADE'   = 'IDLE';
  let capitalValue  = config.initialCapital * (config.allocationPct / 100);

  // Start from MIN_CANDLES_REQUIRED so indicators have enough history
  for (let i = MIN_CANDLES_REQUIRED; i < candles1h.length; i++) {

    const currentCandle = candles1h[i];
    if (!currentCandle) continue;

    // ── Resolve a resting entry order placed on an earlier candle ──
    // The signal was authored at the open of a prior candle; it fills only when
    // price actually trades through the named entry level (limit/stop), and
    // expires unfilled after a few candles. This avoids the fantasy of an
    // instant fill at the exact price on the decision candle.
    if (pendingEntry) {
      if (i >= pendingEntry.expiresAtIndex) {
        pendingEntry = null;
      } else if (
        currentCandle.low  <= pendingEntry.signal.entry! &&
        pendingEntry.signal.entry! <= currentCandle.high
      ) {
        const fillPrice = applySlippage(
          pendingEntry.signal.entry!,
          pendingEntry.direction,
          'entry',
          ENTRY_SLIP_PCT,
        );

        openTrade = {
          id:             `bt_${i}`,
          agentId:        agent.id,
          pair:           config.pair,
          direction:      pendingEntry.direction,
          entryPrice:     fillPrice,
          currentTp:      pendingEntry.signal.tp!,
          currentSl:      pendingEntry.signal.sl!,
          positionSize:   pendingEntry.positionSize,
          positionValue:  pendingEntry.positionSize * fillPrice,
          unrealisedPnl:  0,
          unrealisedPct:  0,
          openedAt:       new Date(currentCandle.openTime),
          entryReasoning: pendingEntry.signal.reasoning,
          mode:           'paper',
          leverage:       agent.leverage ?? 10,
        };

        state        = 'IN_TRADE';
        pendingEntry = null;

        logger.info('Backtest entry filled', {
          index:     i,
          direction: openTrade.direction,
          entry:     round(fillPrice),
        });

        // Don't evaluate TP/SL on the fill candle — start next candle to avoid
        // resolving an intrabar move we can't order within.
        continue;
      }

      // Still waiting on the resting order — don't seek a new signal meanwhile.
      if (pendingEntry) continue;
    }

    // ── Check if open trade TP/SL was hit ──
    if (state === 'IN_TRADE' && openTrade) {
      const closed = checkTpSlHit(openTrade, currentCandle);

      if (closed) {
        const pnlPct = calculatePnlPct(
          openTrade.direction,
          openTrade.entryPrice,
          closed.exitPrice,
          openTrade.leverage,
        );

        trades.push({
          openTime:  openTrade.openedAt,
          closeTime: currentCandle.closeTime
            ? new Date(currentCandle.closeTime)
            : new Date(),
          direction: openTrade.direction,
          entry:     openTrade.entryPrice,
          exit:      closed.exitPrice,
          pnlPct,
          outcome:   pnlPct > 0 ? 'win' : 'loss',
          reasoning: openTrade.entryReasoning,
        });

        // Update capital
        capitalValue = capitalValue * (1 + pnlPct / 100);

        openTrade = null;
        state     = 'IDLE';
        continue;
      }

      // ── Management cycle ──
      // Only run every 4 candles to save API costs in backtest
      if (i % 4 === 0) {
        const mtfData = buildMtfSnapshot(candles, i);
        if (!mtfData) continue;

        const systemPrompt     = buildSystemPrompt(agent, undefined, 'management');
        const managementPrompt = buildManagementPrompt(
          agent,
          openTrade,
          mtfData,
          'No news available in backtest',
        );

        const result = await getManagementDecision(
          systemPrompt,
          managementPrompt,
          agent.id,
        );

        if (result.success && result.data) {
          const decision = result.data as ManagementDecision;

          // Apply adjustment
          if (decision.action === 'ADJUST') {
            if (decision.newTp) openTrade.currentTp = decision.newTp;
            if (decision.newSl) openTrade.currentSl = decision.newSl;
          }

          // Force close
          if (decision.action === 'CLOSE') {
            const exitPrice = applySlippage(
              currentCandle.close,
              openTrade.direction,
              'exit',
              EXIT_SLIP_PCT,
            );
            const pnlPct    = calculatePnlPct(
              openTrade.direction,
              openTrade.entryPrice,
              exitPrice,
              openTrade.leverage,
            );

            trades.push({
              openTime:  openTrade.openedAt,
              closeTime: new Date(currentCandle.openTime),
              direction: openTrade.direction,
              entry:     openTrade.entryPrice,
              exit:      exitPrice,
              pnlPct,
              outcome:   pnlPct > 0 ? 'win' : 'loss',
              reasoning: openTrade.entryReasoning,
            });

            capitalValue = capitalValue * (1 + pnlPct / 100);
            openTrade    = null;
            state        = 'IDLE';
          }
        }
      }

      continue;
    }

    // ── Entry cycle — agent is IDLE ──
    const mtfData = buildMtfSnapshot(candles, i);
    if (!mtfData) continue;

    const regime = detectRegime(
      candles1h.slice(Math.max(0, i - 200), i)
    );
    if (!regime) continue;

    const lessons = await getRelevantLessons(
      agent.id,
      regime.regime,
      'LONG',  // placeholder — Claude decides direction
      mtfData.tf1h.indicators?.rsi ?? 50,
      mtfData.tf1h.indicators?.volume.ratio ?? 1,
      config.pair,
      new Date(currentCandle.openTime).getDay(),
    );

    const systemPrompt = buildSystemPrompt(agent);
    const entryPrompt  = buildEntryPrompt(
      agent,
      mtfData,
      regime,
      'No news available in backtest',
      lessons,
      0,       // monthlyPnl — simplified for backtest
      'NORMAL',
    );

    const claudeResult = await getEntrySignal(
      systemPrompt,
      entryPrompt,
      agent.id,
    );

    if (!claudeResult.success || !claudeResult.data) continue;

    const signal = claudeResult.data as EntrySignal;
    if (signal.action === 'NO_TRADE' || !signal.entry || !signal.tp || !signal.sl) continue;

    // Risk validation
    const portfolio    = { totalValue: capitalValue / (config.allocationPct / 100) } as any;
    const runtimeState = { cooldownUntil: null } as any;

    const validation = await validateEntrySignal(
      signal,
      agent,
      runtimeState,
      portfolio,
    );

    if (!validation.approved || !validation.positionSize) continue;

    // Place a resting entry order — it fills on a later candle only if price
    // actually trades through the entry level (see pending-entry block above).
    pendingEntry = {
      signal,
      direction:      signal.action as 'LONG' | 'SHORT',
      positionSize:   validation.positionSize,
      expiresAtIndex: i + ENTRY_EXPIRY_CANDLES,
    };

    logger.info('Backtest entry order placed', {
      index:     i,
      direction: signal.action,
      entry:     signal.entry,
      tp:        signal.tp,
      sl:        signal.sl,
    });
  }

  // Force close any trade still open at end of backtest
  if (openTrade && candles1h.length > 0) {
    const lastCandle = candles1h.at(-1)!;
    const exitPrice  = applySlippage(
      lastCandle.close,
      openTrade.direction,
      'exit',
      EXIT_SLIP_PCT,
    );
    const pnlPct     = calculatePnlPct(
      openTrade.direction,
      openTrade.entryPrice,
      exitPrice,
      openTrade.leverage,
    );

    trades.push({
      openTime:  openTrade.openedAt,
      closeTime: new Date(lastCandle.openTime),
      direction: openTrade.direction,
      entry:     openTrade.entryPrice,
      exit:      exitPrice,
      pnlPct,
      outcome:   pnlPct > 0 ? 'win' : 'loss',
      reasoning: openTrade.entryReasoning + ' [force closed at backtest end]',
    });
  }

  return trades;
}

// ─────────────────────────────────────────────
// Check if current candle hit TP or SL
// ─────────────────────────────────────────────

function checkTpSlHit(
  trade:  OpenTrade,
  candle: Candle,
): { exitPrice: number; reason: 'TP_HIT' | 'SL_HIT' } | null {
  // Stop-first tie-break: when a single candle's range covers BOTH the stop and
  // the target, we can't know which filled first intrabar, so we assume the
  // worst case (stop hit first). Awarding the win here would inflate win rate.
  // The stop fill also takes adverse slippage (it can gap through the level).
  if (trade.direction === 'LONG') {
    if (candle.low <= trade.currentSl) {
      return {
        exitPrice: applySlippage(trade.currentSl, 'LONG', 'exit', STOP_SLIP_PCT),
        reason:    'SL_HIT',
      };
    }
    if (candle.high >= trade.currentTp) {
      return { exitPrice: trade.currentTp, reason: 'TP_HIT' };
    }
  }

  if (trade.direction === 'SHORT') {
    if (candle.high >= trade.currentSl) {
      return {
        exitPrice: applySlippage(trade.currentSl, 'SHORT', 'exit', STOP_SLIP_PCT),
        reason:    'SL_HIT',
      };
    }
    if (candle.low <= trade.currentTp) {
      return { exitPrice: trade.currentTp, reason: 'TP_HIT' };
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Build multi-timeframe snapshot at index i
// Only uses candles up to i — never looks ahead
// ─────────────────────────────────────────────

function buildMtfSnapshot(
  candles: Record<string, Candle[]>,
  index1h: number,
): MultiTimeframeData | null {
  const candles1d  = candles['D']   ?? [];
  const candles1h  = candles['60']  ?? [];
  const candles4h  = candles['240'] ?? [];
  const candles15m = candles['15']  ?? [];
  const candles5m  = candles['5']   ?? [];
  const candles1m  = candles['1']   ?? [];

  // Decision time = the open of the current 1h candle. Only candles that had
  // already OPENED strictly before that instant are known to the agent — a
  // lower-TF candle opening at the cutoff has not closed yet. Slicing by
  // timestamp (not index arithmetic) keeps every timeframe aligned and
  // lookahead-free even when a feed has gaps or a ragged start.
  const cutoff = candles1h[index1h]?.openTime;
  if (cutoff === undefined) return null;

  const sliceUpTo = (arr: Candle[], n = 200): Candle[] => {
    const eligible = arr.filter(c => c.openTime < cutoff);
    return eligible.slice(-n);
  };

  const slice1h  = sliceUpTo(candles1h);
  const slice1d  = sliceUpTo(candles1d);
  const slice4h  = sliceUpTo(candles4h);
  const slice15m = sliceUpTo(candles15m);
  const slice5m  = sliceUpTo(candles5m);
  const slice1m  = sliceUpTo(candles1m);

  if (slice1h.length < 50) return null;

  const buildSnapshot = (
    c:        Candle[],
    interval: CandleInterval,
  ): TimeframeSnapshot => ({
    interval,
    candles:    c,
    indicators: calculateIndicators(c) ?? {} as any,
    regime:     detectRegime(c) ?? {} as any,
  });

  const tf5mSnap = buildSnapshot(slice5m, '5');
  const tf4hSnap = buildSnapshot(slice4h, '240');

  return {
    pair:  candles1h[index1h]?.pair ?? '',
    // Daily slice is short on backtest windows under ~200 days — fall back to 4h
    tf1d:  slice1d.length >= 50 ? buildSnapshot(slice1d, 'D') : tf4hSnap,
    tf4h:  tf4hSnap,
    tf1h:  buildSnapshot(slice1h,  '60'),
    tf15m: buildSnapshot(slice15m, '15'),
    tf5m:  tf5mSnap,
    // 1m buffer may be short early in the window — fall back to the 5m snapshot
    tf1m:  slice1m.length >= 50 ? buildSnapshot(slice1m, '1') : tf5mSnap,
  };
}

// ─────────────────────────────────────────────
// Results analyser
// ─────────────────────────────────────────────

function analyseResults(
  config: BacktestConfig,
  trades: BacktestTrade[],
): BacktestResult {
  if (trades.length === 0) {
    return emptyResult(config);
  }

  const wins   = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');

  // Reported as a percentage (0-100), not a 0-1 fraction.
  const winRate      = (wins.length / trades.length) * 100;
  const netPnlPct    = trades.reduce((sum, t) => sum + t.pnlPct, 0);
  const grossWins    = wins.reduce((sum, t) => sum + t.pnlPct, 0);
  const grossLosses  = Math.abs(losses.reduce((sum, t) => sum + t.pnlPct, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins;

  // Max drawdown
  let peak        = 0;
  let maxDrawdown = 0;
  let running     = 0;

  trades.forEach(t => {
    running += t.pnlPct;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  });

  // Average duration
  const avgDuration = trades.reduce((sum, t) => {
    const hrs = (t.closeTime.getTime() - t.openTime.getTime()) / (1000 * 60 * 60);
    return sum + hrs;
  }, 0) / trades.length;

  // Sharpe ratio (simplified — daily returns)
  const returns      = trades.map(t => t.pnlPct);
  const avgReturn    = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdDev       = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  );
  const sharpe       = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Monthly returns
  const monthlyMap: Record<string, { pnl: number; trades: number }> = {};

  trades.forEach(t => {
    const key = t.openTime.toISOString().slice(0, 7); // "2025-01"
    if (!monthlyMap[key]) monthlyMap[key] = { pnl: 0, trades: 0 };
    monthlyMap[key].pnl    += t.pnlPct;
    monthlyMap[key].trades += 1;
  });

  const monthlyReturns: MonthlyReturn[] = Object.entries(monthlyMap).map(
    ([month, data]) => ({
      month,
      returnPct: round(data.pnl),
      trades:    data.trades,
    })
  );

  return {
    config,
    totalTrades:         trades.length,
    winRate:             round(winRate, 2),
    profitFactor:        round(profitFactor),
    netPnlPct:           round(netPnlPct),
    maxDrawdownPct:      round(maxDrawdown),
    sharpeRatio:         round(sharpe),
    avgTradeDurationHrs: round(avgDuration),
    monthlyReturns,
    trades,
  };
}

// ─────────────────────────────────────────────
// Load historical candles from DB
// ─────────────────────────────────────────────

async function loadHistoricalCandles(
  pair:      string,
  startDate: Date,
  endDate:   Date,
): Promise<Record<string, Candle[]>> {
  const timeframes: CandleInterval[] = ['1', '5', '15', '60', '240', 'D'];
  const result: Record<string, Candle[]> = {};

  for (const tf of timeframes) {
    const rows = await prisma.candle.findMany({
      where: {
        pair,
        timeframe: tf,
        timestamp: {
          gte: BigInt(startDate.getTime()),
          lte: BigInt(endDate.getTime()),
        },
      },
      orderBy: { timestamp: 'asc' },
    });

    result[tf] = rows.map(r => ({
      pair,
      interval:  tf as CandleInterval,
      openTime:  Number(r.timestamp),
      open:      r.open,
      high:      r.high,
      low:       r.low,
      close:     r.close,
      volume:    r.volume,
      closeTime: Number(r.timestamp),
    }));

    logger.info(`Loaded ${result[tf].length} candles for ${pair} ${tf}`);
  }

  return result;
}

// ─────────────────────────────────────────────
// Save backtest result to DB for dashboard
// ─────────────────────────────────────────────

async function saveBacktestResult(
  agentId: string,
  config:  BacktestConfig,
  result:  BacktestResult,
): Promise<void> {
  await prisma.backtestResult.create({
    data: {
      agentId,
      config: {
        pair:           config.pair,
        startDate:      config.startDate.toISOString(),
        endDate:        config.endDate.toISOString(),
        initialCapital: config.initialCapital,
        allocationPct:  config.allocationPct,
        riskPct:        config.riskPct,
      },
      result: {
        totalTrades:         result.totalTrades,
        winRate:             result.winRate,
        profitFactor:        result.profitFactor,
        netPnlPct:           result.netPnlPct,
        maxDrawdownPct:      result.maxDrawdownPct,
        sharpeRatio:         result.sharpeRatio,
        avgTradeDurationHrs: result.avgTradeDurationHrs,
        monthlyReturns:      result.monthlyReturns as any,
        trades:              result.trades.map(t => ({
          ...t,
          openTime:  t.openTime.toISOString(),
          closeTime: t.closeTime.toISOString(),
        })),
      },
    },
  });

  logger.info('Backtest result saved', {
    agentId,
    trades:      result.totalTrades,
    winRate:     result.winRate,
    netPnl:      result.netPnlPct,
    maxDrawdown: result.maxDrawdownPct,
  });
}

function calculatePnlPct(
  direction:  'LONG' | 'SHORT',
  entry:      number,
  exit:       number,
  leverage = 10,
): number {
  const raw = direction === 'LONG'
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;

  // Return is on margin, so it's the price move × leverage. Fees are charged on
  // notional (= margin × leverage) on both entry and exit, so as a % of margin
  // the drag is feeRate × leverage per side, two sides. Slippage is already
  // baked into the fill prices passed in.
  const gross   = raw * leverage;
  const feeDrag = 2 * TAKER_FEE_PCT * leverage;

  return round(gross - feeDrag);
}

function emptyResult(config: BacktestConfig): BacktestResult {
  return {
    config,
    totalTrades:         0,
    winRate:             0,
    profitFactor:        0,
    netPnlPct:           0,
    maxDrawdownPct:      0,
    sharpeRatio:         0,
    avgTradeDurationHrs: 0,
    monthlyReturns:      [],
    trades:              [],
  };
}

function round(value: number, decimals = 2): number {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}