
// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

import { Candle } from "../types/market.types";

export interface KeyLevel {
  price:    number;
  type:     'resistance' | 'support';
  strength: number;       // 1-5 — how many times price respected this level
  source:   'swing' | 'volume_node' | 'round_number' | 'recent_extreme';
  touched:  number;       // how many candles touched this level
  lastSeen: number;       // openTime of last candle that touched it
}

export interface KeyLevelsResult {
  resistances:  KeyLevel[];
  supports:     KeyLevel[];
  currentPrice: number;
  nearestResistance: number | null;
  nearestSupport:    number | null;
  distanceToResistance: string | null;  // e.g. "+1.2%"
  distanceToSupport:    string | null;  // e.g. "-0.8%"
}

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const ZONE_THRESHOLD   = 0.003;  // 0.3% — prices within this % are the same level
const MAX_LEVELS       = 5;      // max levels to return each side
const LOOKBACK_SWING   = 5;      // candles each side to confirm a swing point
const MIN_TOUCHES      = 2;      // minimum touches to consider a level significant

// ─────────────────────────────────────────────
// Main export
// Call with the 1h or 4h candle array
// Returns clean levels Gemini can reason about
// ─────────────────────────────────────────────

export function findKeyLevels(candles: Candle[]): KeyLevelsResult {
  if (candles.length < 20) {
    return emptyResult(candles.at(-1)?.close ?? 0);
  }

  const currentPrice = candles.at(-1)!.close;

  // Find levels from multiple methods
  const swingLevels     = findSwingLevels(candles);
  const volumeNodes     = findVolumeNodes(candles);
  const roundNumbers    = findRoundNumbers(currentPrice);
  const recentExtremes  = findRecentExtremes(candles);

  // Merge all levels
  const allLevels = [
    ...swingLevels,
    ...volumeNodes,
    ...roundNumbers,
    ...recentExtremes,
  ];

  // Cluster levels that are very close together
  const clustered = clusterLevels(allLevels, currentPrice);

  // Split into supports and resistances
  const resistances = clustered
    .filter(l => l.price > currentPrice)
    .sort((a, b) => a.price - b.price)   // nearest first
    .slice(0, MAX_LEVELS);

  const supports = clustered
    .filter(l => l.price < currentPrice)
    .sort((a, b) => b.price - a.price)   // nearest first
    .slice(0, MAX_LEVELS);

  const nearestResistance = resistances[0]?.price ?? null;
  const nearestSupport    = supports[0]?.price    ?? null;

  return {
    resistances,
    supports,
    currentPrice,
    nearestResistance,
    nearestSupport,
    distanceToResistance: nearestResistance
      ? formatDistance(currentPrice, nearestResistance)
      : null,
    distanceToSupport: nearestSupport
      ? formatDistance(currentPrice, nearestSupport)
      : null,
  };
}

// ─────────────────────────────────────────────
// Method 1 — Swing highs and lows
// A swing high = candle whose high is higher than
// N candles on each side
// A swing low = candle whose low is lower than
// N candles on each side
// ─────────────────────────────────────────────

function findSwingLevels(candles: Candle[]): KeyLevel[] {
  const levels: KeyLevel[] = [];
  const n = LOOKBACK_SWING;

  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];

    // Check swing high
    const isSwingHigh = candles
      .slice(i - n, i)
      .concat(candles.slice(i + 1, i + n + 1))
      .every(other => other.high <= c.high);

    if (isSwingHigh) {
      levels.push({
        price:    round(c.high),
        type:     'resistance',
        strength: 1,
        source:   'swing',
        touched:  1,
        lastSeen: c.openTime,
      });
    }

    // Check swing low
    const isSwingLow = candles
      .slice(i - n, i)
      .concat(candles.slice(i + 1, i + n + 1))
      .every(other => other.low >= c.low);

    if (isSwingLow) {
      levels.push({
        price:    round(c.low),
        type:     'support',
        strength: 1,
        source:   'swing',
        touched:  1,
        lastSeen: c.openTime,
      });
    }
  }

  return levels;
}

// ─────────────────────────────────────────────
// Method 2 — High volume nodes
// Candles with above-average volume at specific
// price levels — price tends to respect these
// ─────────────────────────────────────────────

function findVolumeNodes(candles: Candle[]): KeyLevel[] {
  const levels: KeyLevel[] = [];

  const avgVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
  const highVolCandles = candles.filter(c => c.volume > avgVolume * 2);

  highVolCandles.forEach(c => {
    const currentPrice = candles.at(-1)!.close;
    const midpoint     = (c.high + c.low) / 2;

    levels.push({
      price:    round(midpoint),
      type:     midpoint > currentPrice ? 'resistance' : 'support',
      strength: 2,
      source:   'volume_node',
      touched:  1,
      lastSeen: c.openTime,
    });
  });

  return levels;
}

// ─────────────────────────────────────────────
// Method 3 — Round numbers
// Price tends to react at psychological levels —
// whole numbers and half numbers near current price
// ─────────────────────────────────────────────

function findRoundNumbers(currentPrice: number): KeyLevel[] {
  const levels: KeyLevel[] = [];

  // Determine the step size based on price magnitude
  const magnitude = Math.pow(10, Math.floor(Math.log10(currentPrice)) - 1);
  const step      = magnitude;

  // Find round numbers within 5% of current price
  const range     = currentPrice * 0.05;
  const lowerBound = currentPrice - range;
  const upperBound = currentPrice + range;

  // Round to nearest step
  let level = Math.round(lowerBound / step) * step;

  while (level <= upperBound) {
    if (Math.abs(level - currentPrice) / currentPrice > 0.001) {
      levels.push({
        price:    round(level),
        type:     level > currentPrice ? 'resistance' : 'support',
        strength: 1,
        source:   'round_number',
        touched:  0,
        lastSeen: 0,
      });
    }
    level += step;
  }

  return levels;
}

// ─────────────────────────────────────────────
// Method 4 — Recent extremes
// The highest high and lowest low of the last
// 20, 50, and 100 candles — significant because
// traders remember these levels
// ─────────────────────────────────────────────

function findRecentExtremes(candles: Candle[]): KeyLevel[] {
  const levels: KeyLevel[] = [];
  const currentPrice = candles.at(-1)!.close;
  const lookbacks    = [20, 50, 100];

  lookbacks.forEach(lb => {
    const slice = candles.slice(-lb);
    if (slice.length < lb) return;

    const high = Math.max(...slice.map(c => c.high));
    const low  = Math.min(...slice.map(c => c.low));

    if (high > currentPrice) {
      levels.push({
        price:    round(high),
        type:     'resistance',
        strength: lb === 100 ? 3 : lb === 50 ? 2 : 1,
        source:   'recent_extreme',
        touched:  1,
        lastSeen: slice.at(-1)!.openTime,
      });
    }

    if (low < currentPrice) {
      levels.push({
        price:    round(low),
        type:     'support',
        strength: lb === 100 ? 3 : lb === 50 ? 2 : 1,
        source:   'recent_extreme',
        touched:  1,
        lastSeen: slice.at(-1)!.openTime,
      });
    }
  });

  return levels;
}

// ─────────────────────────────────────────────
// Cluster nearby levels into single zones
// Levels within ZONE_THRESHOLD % of each other
// are merged — price doesn't distinguish between
// 0.09340 and 0.09355, both are the same zone
// ─────────────────────────────────────────────

function clusterLevels(levels: KeyLevel[], currentPrice: number): KeyLevel[] {
  if (levels.length === 0) return [];

  // Sort by price
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters: KeyLevel[][] = [];
  let   currentCluster: KeyLevel[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev    = sorted[i - 1];
    const current = sorted[i];
    const diff    = Math.abs(current.price - prev.price) / prev.price;

    if (diff <= ZONE_THRESHOLD) {
      // Same zone — add to current cluster
      currentCluster.push(current);
    } else {
      clusters.push(currentCluster);
      currentCluster = [current];
    }
  }
  clusters.push(currentCluster);

  // Merge each cluster into a single level
  return clusters.map(cluster => {
    // Use the most touched price as the representative level
    const avgPrice  = cluster.reduce((sum, l) => sum + l.price, 0) / cluster.length;
    const maxStrength = Math.min(5, cluster.reduce((sum, l) => sum + l.strength, 0));
    const touches   = cluster.reduce((sum, l) => sum + l.touched, 0);
    const lastSeen  = Math.max(...cluster.map(l => l.lastSeen));

    // Prefer swing and volume node sources over round numbers
    const source = cluster.find(l => l.source === 'swing')?.source
      ?? cluster.find(l => l.source === 'volume_node')?.source
      ?? cluster[0].source;

    return {
      price:    round(avgPrice),
      type:     avgPrice > currentPrice ? 'resistance' : 'support',
      strength: maxStrength,
      source,
      touched:  touches,
      lastSeen,
    };
  });
}

// ─────────────────────────────────────────────
// Format key levels for Claude/Gemini prompt
// Gives the AI what a trader sees when they
// draw levels on their chart
// ─────────────────────────────────────────────

export function formatKeyLevelsForPrompt(levels: KeyLevelsResult): string {
  if (levels.resistances.length === 0 && levels.supports.length === 0) {
    return 'No significant key levels detected.';
  }

  const formatLevel = (l: KeyLevel): string => {
    const stars    = '★'.repeat(l.strength) + '☆'.repeat(5 - l.strength);
    const sourceLabel = {
      swing:          'swing point',
      volume_node:    'high volume node',
      round_number:   'psychological level',
      recent_extreme: 'recent extreme',
    }[l.source];

    return `  ${l.price} [${stars}] — ${sourceLabel}`;
  };

  const resistanceLines = levels.resistances.map(formatLevel).join('\n');
  const supportLines    = levels.supports.map(formatLevel).join('\n');

  const nearestR = levels.nearestResistance
    ? `Nearest resistance: ${levels.nearestResistance} (${levels.distanceToResistance} away)`
    : 'No resistance above';

  const nearestS = levels.nearestSupport
    ? `Nearest support: ${levels.nearestSupport} (${levels.distanceToSupport} away)`
    : 'No support below';

  return `
Current price: ${levels.currentPrice}
${nearestR}
${nearestS}

RESISTANCE LEVELS (above current price):
${resistanceLines || '  None identified'}

SUPPORT LEVELS (below current price):
${supportLines || '  None identified'}

★★★★★ = very strong level (multiple confluences)
★★★☆☆ = moderate level
★☆☆☆☆ = weak level (single touch)
  `.trim();
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function formatDistance(from: number, to: number): string {
  const pct = ((to - from) / from) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function round(value: number, decimals = 5): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function emptyResult(currentPrice: number): KeyLevelsResult {
  return {
    resistances:          [],
    supports:             [],
    currentPrice,
    nearestResistance:    null,
    nearestSupport:       null,
    distanceToResistance: null,
    distanceToSupport:    null,
  };
}