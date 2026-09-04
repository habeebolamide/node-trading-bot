import { describe, it, expect } from 'vitest';
import { fmtAgo, fmtWhen } from './format.js';

describe('fmtAgo', () => {
  const now = new Date('2026-09-04T12:00:00Z');

  it('under 5s → "just now"', () => {
    expect(fmtAgo(new Date(now.getTime() - 2_000), now)).toBe('just now');
  });
  it('seconds', () => {
    expect(fmtAgo(new Date(now.getTime() - 12_000), now)).toBe('12s ago');
  });
  it('minutes', () => {
    expect(fmtAgo(new Date(now.getTime() - 3 * 60_000), now)).toBe('3m ago');
  });
  it('hours', () => {
    expect(fmtAgo(new Date(now.getTime() - 5 * 3600_000), now)).toBe('5h ago');
  });
  it('days', () => {
    expect(fmtAgo(new Date(now.getTime() - 3 * 86400_000), now)).toBe('3d ago');
  });
  it('future-dated becomes "from now" (defensive; e.g. clock skew)', () => {
    expect(fmtAgo(new Date(now.getTime() + 5 * 60_000), now)).toBe('5m from now');
  });
  it('over 30 days falls through to an absolute date', () => {
    const ancient = new Date('2025-05-01T10:00:00Z');
    // Prior year → includes year — just check it isn't the "ago" string.
    expect(fmtAgo(ancient, now)).not.toContain('ago');
    expect(fmtAgo(ancient, now)).toMatch(/2025/);
  });
});

describe('fmtWhen', () => {
  const now = new Date('2026-09-04T12:00:00Z');

  it('same-day event → time + relative', () => {
    const out = fmtWhen(new Date(now.getTime() - 5 * 60_000), now);
    expect(out).toContain('5m ago');
    // Contains a colon-separated time (locale-dependent formatting, so no exact match)
    expect(out).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
  it('older-than-24h event → absolute date-time only', () => {
    const out = fmtWhen(new Date(now.getTime() - 3 * 86400_000), now);
    expect(out).not.toContain('ago');
  });
});
