/**
 * Signal Lifecycle (§36). Valid transitions from ACTIVE:
 *   ACTIVE → EXPIRED       (TTL elapsed with no entry)
 *   ACTIVE → INVALIDATED   (invalidator fired, or Risk Agent HIGH — change 5)
 *   ACTIVE → CONSUMED      (Trade Planner turned it into a Prediction — M6)
 *
 * The state machine is a pure validator; actual DB writes go through `transitionSignal` in
 * signal-store.ts. Reason field carried alongside for observability + attribution (§22).
 */
export type SignalState = 'ACTIVE' | 'EXPIRED' | 'INVALIDATED' | 'CONSUMED';

const ALLOWED: Record<SignalState, ReadonlySet<SignalState>> = {
  ACTIVE: new Set(['EXPIRED', 'INVALIDATED', 'CONSUMED']),
  EXPIRED: new Set(),
  INVALIDATED: new Set(),
  CONSUMED: new Set(),
};

export function canTransition(from: SignalState, to: SignalState): boolean {
  return ALLOWED[from].has(to);
}

/** Throws on invalid transitions so writers can't accidentally re-open a finalized signal. */
export function assertTransition(from: SignalState, to: SignalState): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid signal state transition: ${from} → ${to}`);
  }
}
