import logger from '../utils/logger';
import { getEntrySignal, getManagementDecision } from '../claude/client';
import { buildEntryPrompt, buildManagementPrompt, buildSystemPrompt } from '../claude/prompts';
import { validateEntrySignal } from '../risk';
import { getRelevantLessons } from '../learning';
import { Agent } from '../types/agent.types';
import { BacktestConfig, BacktestResult, BacktestTrade, MonthlyReturn } from '../types/risk.types';
import { Candle, CandleInterval, MultiTimeframeData, TimeframeSnapshot } from '../types/market.types';
import { OpenTrade } from '../types/trade.types';
import { EntrySignal, ManagementDecision } from '../types/claude.types';
import { detectRegime } from '../markets/regime';
import { calculateIndicators } from '../markets/indicators';
import { prisma } from '../lib/prisma';


// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const MIN_CANDLES_REQUIRED = 200; // need enough history for EMA200

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

  if (candles['60'].length < MIN_CANDLES_REQUIRED) {
    throw new Error(
      `Not enough historical data. Need ${MIN_CANDLES_REQUIRED} candles, got ${candles['60'].length}`
    );
  }

  logger.info('Historical data loaded', {
    candles1h:  candles['60'].length,
    candles4h:  candles['240'].length,
    candles15m: candles['15'].length,
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

async function simulate(
  agent:   Agent,
  config:  BacktestConfig,
  candles: Record<string, Candle[]>,
): Promise<BacktestTrade[]> {
  const trades:     BacktestTrade[]  = [];
  const candles1h   = candles['60'];

  let openTrade:    OpenTrade | null = null;
  let state:        'IDLE' | 'IN_TRADE' = 'IDLE';
  let capitalValue  = config.initialCapital * (config.allocationPct / 100);

  // Start from MIN_CANDLES_REQUIRED so indicators have enough history
  for (let i = MIN_CANDLES_REQUIRED; i < candles1h.length; i++) {

    const currentCandle = candles1h[i];

    // ── Check if open trade TP/SL was hit ──
    if (state === 'IN_TRADE' && openTrade) {
      const closed = checkTpSlHit(openTrade, currentCandle);

      if (closed) {
        const pnlPct = calculatePnlPct(
          openTrade.direction,
          openTrade.entryPrice,
          closed.exitPrice,
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

        const systemPrompt     = buildSystemPrompt(agent);
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
            const exitPrice = currentCandle.close;
            const pnlPct    = calculatePnlPct(
              openTrade.direction,
              openTrade.entryPrice,
              exitPrice,
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
      candles['60'].slice(Math.max(0, i - 200), i)
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

    // Open simulated trade
    openTrade = {
      id:             `bt_${i}`,
      agentId:        agent.id,
      pair:           config.pair,
      direction:      signal.action as 'LONG' | 'SHORT',
      entryPrice:     signal.entry,
      currentTp:      signal.tp,
      currentSl:      signal.sl,
      positionSize:   validation.positionSize,
      positionValue:  validation.positionSize * signal.entry,
      unrealisedPnl:  0,
      unrealisedPct:  0,
      openedAt:       new Date(currentCandle.openTime),
      entryReasoning: signal.reasoning,
      mode:           'paper',
    };

    state = 'IN_TRADE';

    logger.info('Backtest trade opened', {
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
    const pnlPct     = calculatePnlPct(
      openTrade.direction,
      openTrade.entryPrice,
      lastCandle.close,
    );

    trades.push({
      openTime:  openTrade.openedAt,
      closeTime: new Date(lastCandle.openTime),
      direction: openTrade.direction,
      entry:     openTrade.entryPrice,
      exit:      lastCandle.close,
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
  if (trade.direction === 'LONG') {
    if (candle.high >= trade.currentTp) {
      return { exitPrice: trade.currentTp, reason: 'TP_HIT' };
    }
    if (candle.low <= trade.currentSl) {
      return { exitPrice: trade.currentSl, reason: 'SL_HIT' };
    }
  }

  if (trade.direction === 'SHORT') {
    if (candle.low <= trade.currentTp) {
      return { exitPrice: trade.currentTp, reason: 'TP_HIT' };
    }
    if (candle.high >= trade.currentSl) {
      return { exitPrice: trade.currentSl, reason: 'SL_HIT' };
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
  const slice1h  = candles['60'].slice(Math.max(0, index1h - 200), index1h);

  // Approximate indices for other timeframes
  const index4h  = Math.floor(index1h / 4);
  const index15m = index1h * 4;
  const index5m  = index1h * 12;

  const slice4h  = candles['240'].slice(Math.max(0, index4h  - 200), index4h);
  const slice15m = candles['15'].slice(Math.max(0,  index15m - 200), index15m);
  const slice5m  = candles['5'].slice(Math.max(0,   index5m  - 200), index5m);

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

  return {
    pair:  candles['60'][index1h]?.pair ?? '',
    tf4h:  buildSnapshot(slice4h,  '240'),
    tf1h:  buildSnapshot(slice1h,  '60'),
    tf15m: buildSnapshot(slice15m, '15'),
    tf5m:  buildSnapshot(slice5m,  '5'),
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

  const winRate      = wins.length / trades.length;
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
    winRate:             round(winRate, 4),
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
  const timeframes: CandleInterval[] = ['5', '15', '60', '240'];
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
): number {
  const raw = direction === 'LONG'
    ? ((exit - entry) / entry) * 100
    : ((entry - exit) / entry) * 100;

  return round(raw);
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