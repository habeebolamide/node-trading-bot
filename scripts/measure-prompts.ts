import {
  buildSystemPrompt,
  buildEntryPrompt,
  buildManagementPrompt,
} from '../claude/prompts.js';
import type { Agent } from '../types/agent.types.js';
import type {
  Candle,
  Indicators,
  MultiTimeframeData,
  RegimeAnalysis,
  TimeframeSnapshot,
  CandleInterval,
} from '../types/market.types.js';
import type { OpenTrade } from '../types/trade.types.js';

const ANTHROPIC_CACHE_MIN = 1024;

function estTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function report(label: string, text: string) {
  const chars = text.length;
  const tokens = estTokens(text);
  const cacheable = tokens >= ANTHROPIC_CACHE_MIN;
  const padding = Math.max(0, ANTHROPIC_CACHE_MIN - tokens);
  console.log(
    `${label.padEnd(40)} chars=${String(chars).padStart(5)}  tokens≈${String(tokens).padStart(5)}  ` +
      `cacheable=${cacheable ? 'YES' : 'no '}` +
      (cacheable ? '' : `  paddingNeeded=${padding}`),
  );
}

// ── Mock builders ──

function mockCandle(i: number, base: number, pair: string, interval: CandleInterval): Candle {
  const drift = Math.sin(i / 3) * 100;
  const open = base + drift;
  const close = open + (Math.random() - 0.5) * 50;
  return {
    openTime: Date.now() - (50 - i) * 60_000,
    open,
    high: Math.max(open, close) + 20,
    low: Math.min(open, close) - 20,
    close,
    volume: 100 + Math.random() * 50,
    closeTime: Date.now() - (50 - i) * 60_000 + 59_999,
    pair,
    interval,
  };
}

function mockIndicators(price: number): Indicators {
  return {
    rsi: 52.3,
    ema20: price - 30,
    ema50: price - 80,
    ema200: price - 200,
    macd: { macd: 12.4, signal: 10.1, histogram: 2.3 },
    bollinger: { upper: price + 150, middle: price, lower: price - 150, width: 0.035 },
    adx: 28,
    atr: 45,
    volume: { current: 120, average: 100, ratio: 1.2, trend: 'increasing' },
  };
}

function mockRegime(): RegimeAnalysis {
  return {
    regime: 'TRENDING_BULL',
    confidence: 0.72,
    adx: 28,
    bbWidth: 0.035,
    emaSlope: 0.18,
    volumeTrend: 'increasing',
  };
}

function mockSnapshot(pair: string, interval: CandleInterval, base: number): TimeframeSnapshot {
  const candles = Array.from({ length: 50 }, (_, i) => mockCandle(i, base, pair, interval));
  return {
    interval,
    candles,
    indicators: mockIndicators(candles.at(-1)!.close),
    regime: mockRegime(),
  };
}

function mockMtf(pair: string): MultiTimeframeData {
  return {
    pair,
    tf4h: mockSnapshot(pair, '240', 67000),
    tf1h: mockSnapshot(pair, '60', 67000),
    tf15m: mockSnapshot(pair, '15', 67000),
    tf5m: mockSnapshot(pair, '5', 67000),
    tf1m: mockSnapshot(pair, '1', 67000),
  };
}

function mockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'BTC Swing',
    pair: 'BTCUSDT',
    allocationPercent: 10,
    riskPercent: 1,
    tradingStyle: 'swing',
    mode: 'paper',
    status: 'active',
    learnedRules: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    leverage: 10,
    ...overrides,
  } as Agent;
}

function mockTrade(): OpenTrade {
  return {
    id: 't1',
    agentId: 'agent-1',
    pair: 'BTCUSDT',
    direction: 'LONG',
    entryPrice: 67000,
    currentTp: 68500,
    currentSl: 66200,
    positionSize: 0.15,
    positionValue: 10050,
    unrealisedPnl: 45.2,
    unrealisedPct: 0.45,
    openedAt: new Date(Date.now() - 3 * 3600_000),
    entryReasoning: 'Breakout above 4h resistance with strong volume confirmation',
    mode: 'paper',
  } as OpenTrade;
}

const NEWS_SHORT = 'No major news detected.';
const NEWS_LONG =
  'High-impact: US CPI release in 2h — expected 3.2% YoY (prev 3.4%). ' +
  'Fed funds futures pricing 65% chance of pause. ' +
  'Mid-impact: Coinbase Q3 earnings beat — BTC ETF inflows accelerating. ' +
  'Low-impact: ETH staking yield steady at 3.8%.';

// ── Measurements ──

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`Anthropic cache minimum: ${ANTHROPIC_CACHE_MIN} tokens (Sonnet/Opus)`);
console.log('Token estimate: chars / 3.5');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log('── SYSTEM PROMPT ──');
report('system (swing, no rules)', buildSystemPrompt(mockAgent()));
report('system (scalp, no rules)', buildSystemPrompt(mockAgent({ tradingStyle: 'scalp' })));
report('system (position, no rules)', buildSystemPrompt(mockAgent({ tradingStyle: 'position' })));
report('system (auto, no rules)', buildSystemPrompt(mockAgent({ tradingStyle: 'auto' })));

const rules5 = Array.from({ length: 5 }, (_, i) => ({
  patternTag: `PATTERN_${i}`,
  rule: `Avoid trading when X condition Y appears within Z minutes of entry signal (lesson #${i + 1})`,
}));
const rules20 = Array.from({ length: 20 }, (_, i) => ({
  patternTag: `PATTERN_${i}`,
  rule: `Avoid trading when X condition Y appears within Z minutes of entry signal (lesson #${i + 1})`,
}));

report('system (swing + 5 rules)', buildSystemPrompt(mockAgent({ learnedRules: rules5 as any })));
report('system (swing + 20 rules)', buildSystemPrompt(mockAgent({ learnedRules: rules20 as any })));

console.log('\n── ENTRY PROMPT (user content) ──');
const mtf = mockMtf('BTCUSDT');
const regime = mockRegime();
report(
  'entry (no news, no lessons)',
  buildEntryPrompt(mockAgent(), mtf, regime, NEWS_SHORT, [], 0.5, 'NORMAL'),
);
report(
  'entry (news, 3 lessons)',
  buildEntryPrompt(
    mockAgent(),
    mtf,
    regime,
    NEWS_LONG,
    [
      { patternTag: 'A', ruleToAdd: 'Do not chase breakouts after 3 consecutive bull candles', frequency: 4 },
      { patternTag: 'B', ruleToAdd: 'Skip trades when RSI > 75 on 1H', frequency: 3 },
      { patternTag: 'C', ruleToAdd: 'Avoid entries within 30 min of CPI release', frequency: 2 },
    ] as any,
    -2.1,
    'CONSERVATIVE',
  ),
);

console.log('\n── MANAGEMENT PROMPT (user content) ──');
report(
  'management (typical)',
  buildManagementPrompt(mockAgent(), mockTrade(), mtf, NEWS_SHORT),
);
report(
  'management (with news)',
  buildManagementPrompt(mockAgent(), mockTrade(), mtf, NEWS_LONG),
);

console.log('\n── TOTALS (system + user) ──');
const sysSwing = buildSystemPrompt(mockAgent());
const entryTypical = buildEntryPrompt(mockAgent(), mtf, regime, NEWS_LONG, [], 0.5, 'NORMAL');
const mgmtTypical = buildManagementPrompt(mockAgent(), mockTrade(), mtf, NEWS_LONG);

console.log(
  `entry call total:      ${estTokens(sysSwing) + estTokens(entryTypical)} tokens ` +
    `(system ${estTokens(sysSwing)} + user ${estTokens(entryTypical)})`,
);
console.log(
  `management call total: ${estTokens(sysSwing) + estTokens(mgmtTypical)} tokens ` +
    `(system ${estTokens(sysSwing)} + user ${estTokens(mgmtTypical)})`,
);

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('Cost note: Anthropic caches the SYSTEM block. If system < 1024 tokens,');
console.log('cache_control silently does nothing. User prompt changes every call');
console.log('so it cannot be cached (no stable prefix).');
console.log('═══════════════════════════════════════════════════════════════════');
