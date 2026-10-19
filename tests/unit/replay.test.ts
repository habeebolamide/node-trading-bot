import { it, expect } from 'vitest';
import { parseInput, digest } from '../../packages/replay/src/contracts.js';
import { seededCandles } from '../../packages/replay/src/generator.js';
import {
  walkForward,
  compareReports,
} from '../../packages/replay/src/experiments.js';
import { replayFixture } from '../fixtures/replay.js';
it('reproduces seeded warm-up candles without future availability', () => {
  const a = seededCandles(42, 'bybit:LINEAR_PERPETUAL:BTC/USDT', '15m', 0, 500);
  expect(digest(a)).toBe(
    digest(seededCandles(42, a[0]!.marketKey, '15m', 0, 500)),
  );
  expect(digest(a)).not.toBe(
    digest(seededCandles(43, a[0]!.marketKey, '15m', 0, 500)),
  );
  expect(
    a.every(
      (c) => c.availableAt === c.closeTime && c.observedAt === c.closeTime,
    ),
  ).toBe(true);
});
it('rejects shuffled observations, duplicate trade IDs and data that looks into the future', () => {
  const input = replayFixture();
  [input.dataset.events[0], input.dataset.events[1]] = [
    input.dataset.events[1]!,
    input.dataset.events[0]!,
  ];
  expect(() => parseInput(input)).toThrow('order');
  const dupe = replayFixture();
  dupe.dataset.events.splice(2, 0, dupe.dataset.events[1]!);
  expect(() => parseInput(dupe)).toThrow('Duplicate');
  const future = replayFixture();
  const price = future.dataset.events.find((e) => e.kind === 'PRICE')!;
  if (price.kind === 'PRICE') price.eventTime = price.observedAt + 1;
  expect(() => parseInput(future)).toThrow('Future');
});
it('rejects overlapping outcome windows and mismatched A/B datasets or seeds', () => {
  expect(() =>
    walkForward({
      training: { start: 0, end: 10 },
      tests: [{ start: 9, end: 20 }],
      holdout: { start: 20, end: 30 },
    }),
  ).toThrow('overlap');
  expect(
    compareReports(
      { inputHash: 'a', datasetHash: 'same', seed: 42 },
      { inputHash: 'b', datasetHash: 'same', seed: 42 },
    ).comparable,
  ).toBe(true);
  expect(() =>
    compareReports(
      { inputHash: 'a', datasetHash: 'same', seed: 42 },
      { inputHash: 'b', datasetHash: 'different', seed: 42 },
    ),
  ).toThrow('identical');
});
it('requires exchange sequence for distinct trades at the same source timestamp', () => {
  const input = replayFixture(),
    first = input.dataset.events.find((e) => e.kind === 'PRICE')!;
  if (first.kind !== 'PRICE') throw Error('Fixture');
  first.sequence = 1;
  input.dataset.events.splice(2, 0, {
    ...first,
    tradeId: 'same-ms-second',
    sequence: 2,
  });
  expect(() => parseInput(input)).not.toThrow();
  const second = input.dataset.events[2];
  if (second?.kind === 'PRICE') delete second.sequence;
  expect(() => parseInput(input)).toThrow('sequence');
});
it('uses half-open outcome windows so a shared boundary never belongs to training and holdout/test together', async () => {
  const { inWindow } = await import('../../packages/replay/src/experiments.js');
  expect(inWindow(10, { start: 0, end: 10 })).toBe(false);
  expect(inWindow(10, { start: 10, end: 20 })).toBe(true);
});
