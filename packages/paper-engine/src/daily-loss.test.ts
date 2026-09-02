import { describe, it, expect } from 'vitest';
import { utcDayStart, utcDayEnd } from './daily-loss.js';

describe('utc day boundaries', () => {
  it('utcDayStart zeroes the time', () => {
    expect(utcDayStart(new Date('2026-06-01T13:45:12Z')).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
  it('utcDayEnd is exactly 24h after start', () => {
    const now = new Date('2026-06-01T13:45:12Z');
    expect(utcDayEnd(now).getTime() - utcDayStart(now).getTime()).toBe(24 * 3600_000);
    expect(utcDayEnd(now).toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });
});
