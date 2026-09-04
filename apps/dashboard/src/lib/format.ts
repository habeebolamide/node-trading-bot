/**
 * Time / number formatting for the dashboard. Every table showed raw ISO strings
 * ("2026-09-04T12:00:00.842Z") — this centralizes what the user actually reads.
 *
 * All timestamp helpers take `Date | string | number` (whatever the API returned) and
 * default to the viewer's local timezone. A monospace container is still recommended for
 * table cells so columns align.
 */

function toDate(d: Date | string | number): Date {
  return d instanceof Date ? d : new Date(d);
}

const DT = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});
const DT_YEAR = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});
const D = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const T = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const NOW_YEAR = new Date().getFullYear();

/** "Sep 4, 12:00:00" (same year) or "Sep 4, 2025, 12:00:00" (prior year). Local TZ. */
export function fmtDateTime(input: Date | string | number): string {
  const d = toDate(input);
  return d.getFullYear() === NOW_YEAR ? DT.format(d) : DT_YEAR.format(d);
}

/** "Sep 4, 2026". Local TZ. */
export function fmtDate(input: Date | string | number): string {
  return D.format(toDate(input));
}

/** "12:00:00". Local TZ. */
export function fmtTime(input: Date | string | number): string {
  return T.format(toDate(input));
}

/**
 * Compact relative age — "3m ago", "2h ago", "5d ago". For >30d falls through to fmtDateTime
 * so distant events show a real date instead of "45d ago". "just now" for <5s.
 */
export function fmtAgo(input: Date | string | number, now: Date = new Date()): string {
  const d = toDate(input);
  const diffMs = now.getTime() - d.getTime();
  const abs = Math.abs(diffMs);
  const s = Math.round(abs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ${diffMs < 0 ? 'from now' : 'ago'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ${diffMs < 0 ? 'from now' : 'ago'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ${diffMs < 0 ? 'from now' : 'ago'}`;
  const days = Math.round(h / 24);
  if (days <= 30) return `${days}d ${diffMs < 0 ? 'from now' : 'ago'}`;
  return fmtDateTime(d);
}

/**
 * Combined "friendly + precise": "12:00:00 (3m ago)" when recent, "Sep 4, 12:00:00" when old.
 * Best for tables where the user often wants BOTH the wall-clock time and the recency.
 */
export function fmtWhen(input: Date | string | number, now: Date = new Date()): string {
  const d = toDate(input);
  const s = (now.getTime() - d.getTime()) / 1000;
  if (s >= 0 && s < 24 * 3600) return `${fmtTime(d)} (${fmtAgo(d, now)})`;
  return fmtDateTime(d);
}
