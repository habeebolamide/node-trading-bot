
// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

import type { Candle } from "../types/market.types.js";

export interface KeyLevel {
  price:    number;
  type:     'resistance' | 'support';
  strength: number;       // 1-5 — how many times price respected this level
  source:   'swing' | 'volume_node' | 'round_number' | 'recent_extreme';
  touched:  number;       // how many candles touched this level
  lastSeen: number;       // openTime of last candle that touched it
}

/** A price zone that lines up across two or more timeframes — the strongest
 *  structure on the chart and the kind of level a trader rests a limit at. */
export interface ConfluenceZone {
  price:       number;        // zone center
  low:         number;        // zone lower bound
  high:        number;        // zone upper bound
  type:        'resistance' | 'support';
  timeframes:  string[];      // which timeframes contributed (e.g. ['15m','1h','4h'])
  strength:    number;        // 1-5 — more aligned timeframes = stronger
  touched:     number;        // total touches across contributing levels
  source:      KeyLevel['source'];
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

// Level selection per side. A pure nearest-first slice evicts strong but
// distant zones the moment price moves away from them — that's why a demand
// zone 3% below spot vanishes from the prompt until price has already fallen
// to it. We instead keep BOTH the nearest levels (near-term actionable
// structure) AND the strongest levels regardless of distance (so a major
// zone stays visible even when far from price).
const NEAREST_KEEP   = 3;  // always keep the N nearest levels per side
const STRONGEST_KEEP = 4;  // always keep the M strongest levels per side, distance-independent

// Cross-timeframe confluence. Slightly wider than ZONE_THRESHOLD because a
// level rarely prints at the exact same price on 15m and 4h — we want
// "roughly the same zone" to merge.
const CONFLUENCE_THRESHOLD = 0.004;  // 0.4%

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

  // Split into supports and resistances — keep nearest AND strongest so a
  // major zone far from spot is never evicted just for being far.
  const resistances = selectSide(clustered, currentPrice, 'resistance');
  const supports    = selectSide(clustered, currentPrice, 'support');

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
// Select levels for one side — keep the union of the NEAREST_KEEP nearest
// and the STRONGEST_KEEP strongest. Returned nearest-first for display.
// This is the fix for distance-based eviction: a strong zone survives the
// cut on strength even when several weaker levels sit between it and price.
// ─────────────────────────────────────────────

function selectSide(
  levels: KeyLevel[],
  currentPrice: number,
  side: 'support' | 'resistance',
): KeyLevel[] {
  const onSide = levels.filter(l =>
    side === 'resistance' ? l.price > currentPrice : l.price < currentPrice,
  );
  if (onSide.length === 0) return [];

  const byDistance = (a: KeyLevel, b: KeyLevel) =>
    Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
  const byStrength = (a: KeyLevel, b: KeyLevel) =>
    (b.strength - a.strength) || (b.touched - a.touched);

  const nearest  = [...onSide].sort(byDistance).slice(0, NEAREST_KEEP);
  const strongest = [...onSide].sort(byStrength).slice(0, STRONGEST_KEEP);

  // Union, deduped by price.
  const seen = new Set<string>();
  const union: KeyLevel[] = [];
  for (const l of [...nearest, ...strongest]) {
    const key = l.price.toFixed(5);
    if (seen.has(key)) continue;
    seen.add(key);
    union.push(l);
  }

  return union.sort(byDistance);
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
    if (!c) continue;

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
  const first = sorted[0]!;
  const clusters: KeyLevel[][] = [];
  let   currentCluster: KeyLevel[] = [first];

  for (let i = 1; i < sorted.length; i++) {
    const prev    = sorted[i - 1];
    const current = sorted[i];
    if (!prev || !current) continue;
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
      ?? cluster[0]?.source
      ?? 'swing';

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
// Cross-timeframe confluence zones
// A level that prints on the 15m, 1h AND 4h is one fat zone a trader marks
// once — not three weak separate levels. findKeyLevels runs each timeframe in
// isolation, so that confluence is invisible to the model. This merges levels
// across timeframes by price proximity and surfaces only the zones where ≥2
// timeframes agree, ranked by how many timeframes line up (strongest first).
// ─────────────────────────────────────────────

export function findConfluenceZones(
  byTf: Array<{ tf: string; candles: Candle[] }>,
  currentPrice: number,
): ConfluenceZone[] {
  // Gather every level from every timeframe, tagged with its source timeframe.
  const tagged: Array<KeyLevel & { tf: string }> = [];
  for (const { tf, candles } of byTf) {
    if (candles.length < 20) continue;
    const r = findKeyLevels(candles);
    for (const l of [...r.resistances, ...r.supports]) tagged.push({ ...l, tf });
  }
  if (tagged.length === 0) return [];

  // Cluster across all timeframes by price proximity.
  const sorted = [...tagged].sort((a, b) => a.price - b.price);
  const clusters: Array<Array<KeyLevel & { tf: string }>> = [];
  let current: Array<KeyLevel & { tf: string }> = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur  = sorted[i]!;
    const diff = Math.abs(cur.price - prev.price) / prev.price;
    if (diff <= CONFLUENCE_THRESHOLD) {
      current.push(cur);
    } else {
      clusters.push(current);
      current = [cur];
    }
  }
  clusters.push(current);

  const zones: ConfluenceZone[] = [];
  for (const cluster of clusters) {
    const tfs = [...new Set(cluster.map(l => l.tf))];
    if (tfs.length < 2) continue;   // confluence requires ≥2 timeframes agreeing

    const prices  = cluster.map(l => l.price);
    const low     = Math.min(...prices);
    const high    = Math.max(...prices);
    const center  = round(prices.reduce((s, p) => s + p, 0) / prices.length);
    const touched = cluster.reduce((s, l) => s + l.touched, 0);

    const source =
      cluster.find(l => l.source === 'swing')?.source ??
      cluster.find(l => l.source === 'volume_node')?.source ??
      cluster[0]!.source;

    zones.push({
      price:      center,
      low:        round(low),
      high:       round(high),
      type:       center > currentPrice ? 'resistance' : 'support',
      timeframes: tfs,
      strength:   Math.min(5, tfs.length + 1),   // 2 TFs → 3★, 3 TFs → 4★, 4+ → 5★
      touched,
      source,
    });
  }

  // Strongest (most aligned) first, then nearest to price.
  return zones.sort((a, b) =>
    (b.strength - a.strength) ||
    (Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)),
  );
}

export function formatConfluenceZonesForPrompt(
  zones: ConfluenceZone[],
  currentPrice: number,
): string {
  if (zones.length === 0) return 'No multi-timeframe confluence zones detected.';

  const fmt = (z: ConfluenceZone): string => {
    const stars = '★'.repeat(z.strength) + '☆'.repeat(5 - z.strength);
    const dist  = ((z.price - currentPrice) / currentPrice) * 100;
    const band  = z.low === z.high ? `${z.price}` : `${z.low}–${z.high}`;
    return `  ${band} [${stars}] — aligned on ${z.timeframes.join(', ')} (${dist >= 0 ? '+' : ''}${dist.toFixed(2)}% away)`;
  };

  const resistances = zones.filter(z => z.type === 'resistance').map(fmt).join('\n');
  const supports    = zones.filter(z => z.type === 'support').map(fmt).join('\n');

  return `
These zones line up across MULTIPLE timeframes — the strongest structure on
the chart, and they stay listed even when far from current price. Prefer them
for pullback-limit entries, invalidation (SL), and targets (TP).

RESISTANCE CONFLUENCE (above price):
${resistances || '  None'}

SUPPORT CONFLUENCE (below price):
${supports || '  None'}
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