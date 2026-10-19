import { digest, type ReplayInput } from './contracts.js';
export type Window = { start: number; end: number };
export function walkForward(plan: {
  training: Window;
  tests: Window[];
  holdout: Window;
}) {
  const windows = [plan.training, ...plan.tests, plan.holdout];
  for (let i = 0; i < windows.length; i++)
    if (
      windows[i]!.start >= windows[i]!.end ||
      (i > 0 && windows[i]!.start < windows[i - 1]!.end)
    )
      throw Error(
        'Training, test and holdout outcome windows must not overlap',
      );
  return Object.freeze({ ...plan, id: digest(plan) });
}
// Only past candles seed each window; positions cannot cross a window boundary.
export function windowInput(input: ReplayInput, window: Window): ReplayInput {
  return { ...input, start: window.start, end: window.end };
}
export function compareReports(
  a: { inputHash: string; datasetHash: string; seed: number },
  b: typeof a,
) {
  if (a.datasetHash !== b.datasetHash || a.seed !== b.seed)
    throw Error('A/B comparisons require identical dataset and seed');
  return {
    comparable: true,
    inputs: [a.inputHash, b.inputHash],
    datasetHash: a.datasetHash,
    seed: a.seed,
  };
}

export function inWindow(time: number, window: Window) {
  return time >= window.start && time < window.end;
}
