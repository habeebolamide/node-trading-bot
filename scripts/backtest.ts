// ─────────────────────────────────────────────
// Run a backtest of the real bot (LLM + prompt + data) over historical candles.
//
//   nvm use 22
//   npm run backtest -- BTCUSDT 2025-04-01 2025-04-30 \
//        [--agent=<id>] [--capital=10000] [--alloc=100] [--risk=1]
//
// Requires candles already in the DB for the window (run `npm run backfill`
// first) and API keys for the LLM. Costs real API spend — this calls the model
// once per idle 1h candle. Start with a short window.
//
// Known v1 simplifications (documented so results aren't over-read):
//   • performance mode fixed to NORMAL, monthlyPnl fixed to 0
//   • news is stubbed ("no news in backtest")
//   • decisions run on the 1h cadence
// ─────────────────────────────────────────────

import 'dotenv/config'; // must be first — populates process.env before the LLM client module initialises
import { runBacktest } from '../backtest/index.js';
import type { Agent, LearnedRule } from '../types/agent.types.js';
import type { BacktestConfig, BacktestResult } from '../types/risk.types.js';
import { prisma } from '../lib/prisma.js';

function parseFlag(name: string): string | undefined {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit?.split('=')[1];
}

// Map a raw DB agent row to the prompt-facing Agent shape. Mirrors
// AgentRuntime's constructor/toPromptAgent without importing the live runtime
// (which would pull in the websocket/execution engine as a side effect).
function toPromptAgent(row: any): Agent {
  const learnedRules: LearnedRule[] = row.learnedRules
    ? (typeof row.learnedRules === 'string' ? JSON.parse(row.learnedRules) : row.learnedRules)
    : [];

  return {
    id:                row.id,
    name:              row.name,
    pair:              row.pair,
    allocationPercent: row.allocationPercent ?? 10,
    riskPercent:       row.riskPercent ?? 1.0,
    tradingStyle:      row.tradingStyle ?? 'swing',
    mode:              row.mode ?? 'paper',
    status:            row.status ?? 'active',
    learnedRules,
    createdAt:         row.createdAt,
    updatedAt:         row.updatedAt,
    leverage:          row.leverage ?? 10,
    maxMarginPct:      row.maxMarginPct ?? 1.0,
  };
}

function fmt(n: number, sign = false): string {
  const s = n.toFixed(2);
  return sign && n > 0 ? `+${s}` : s;
}

function printReport(result: BacktestResult) {
  const r = result;
  const expectancy = r.totalTrades > 0 ? r.netPnlPct / r.totalTrades : 0;

  console.log('\n──────────────────────────────────────────────');
  console.log(`  BACKTEST RESULT — ${r.config.pair}`);
  console.log(`  ${r.config.startDate.toISOString().slice(0, 10)} → ${r.config.endDate.toISOString().slice(0, 10)}`);
  console.log('──────────────────────────────────────────────');
  console.log(`  Trades              ${r.totalTrades}`);
  console.log(`  Win rate            ${fmt(r.winRate)}%`);
  console.log(`  Net P&L             ${fmt(r.netPnlPct, true)}%   (after fees + slippage)`);
  console.log(`  Expectancy / trade  ${fmt(expectancy, true)}%`);
  console.log(`  Profit factor       ${fmt(r.profitFactor)}`);
  console.log(`  Max drawdown        ${fmt(r.maxDrawdownPct)}%`);
  console.log(`  Sharpe (annualised) ${fmt(r.sharpeRatio)}`);
  console.log(`  Avg duration        ${fmt(r.avgTradeDurationHrs)} hrs`);

  if (r.monthlyReturns.length) {
    console.log('\n  Monthly:');
    for (const m of r.monthlyReturns) {
      console.log(`    ${m.month}   ${fmt(m.returnPct, true).padStart(8)}%   (${m.trades} trades)`);
    }
  }
  console.log('──────────────────────────────────────────────');
  console.log('  Note: NORMAL mode, no news, 1h cadence (v1 simplifications).\n');
}

async function main() {
  const [pair, startStr, endStr] = process.argv.slice(2).filter(a => !a.startsWith('--'));

  if (!pair || !startStr || !endStr) {
    console.error('Usage: npm run backtest -- <PAIR> <START yyyy-mm-dd> <END yyyy-mm-dd> [--agent=<id>] [--capital=] [--alloc=] [--risk=]');
    process.exit(1);
  }

  const startDate = new Date(startStr);
  const endDate   = new Date(endStr);
  if (Number.isNaN(+startDate) || Number.isNaN(+endDate) || +endDate <= +startDate) {
    console.error(`Invalid date range: ${startStr} → ${endStr}`);
    process.exit(1);
  }

  const agentId = parseFlag('agent');
  const row = agentId
    ? await prisma.agent.findUnique({ where: { id: agentId } })
    : (await prisma.agent.findFirst({ where: { pair } })) ?? (await prisma.agent.findFirst());

  if (!row) {
    console.error(agentId ? `No agent with id ${agentId}` : `No agent found for ${pair} (and no agents exist).`);
    process.exit(1);
  }

  const agent = toPromptAgent(row);

  const config: BacktestConfig = {
    agentId:        agent.id,
    pair,
    startDate,
    endDate,
    initialCapital: Number(parseFlag('capital') ?? 10000),
    allocationPct:  Number(parseFlag('alloc') ?? 100),
    riskPct:        Number(parseFlag('risk') ?? agent.riskPercent),
  };

  console.log(`\nRunning backtest with agent "${agent.name}" (${agent.tradingStyle}, ${agent.leverage}x)…`);
  console.log('This calls the live LLM per candle and will incur API cost.\n');

  const result = await runBacktest(agent, config);
  printReport(result);
}

main()
  .catch(err => {
    console.error('Backtest failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
