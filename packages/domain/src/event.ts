/**
 * The canonical event envelope (§10).
 *
 * Every message that crosses the event bus is a DomainEvent. Two design points
 * that are load-bearing and easy to get wrong, so they are baked in from day one:
 *
 *  1. `id` is the idempotency key (§29). The same on-chain tx or WS frame can
 *     arrive twice (reconnect replay, at-least-once delivery); consumers dedupe
 *     on this id via the processed_event ledger.
 *
 *  2. event-time vs processing-time are BOTH first-class (§10). The whole system
 *     leans on "state as of T" (rules 21/22), so we must distinguish *when a
 *     thing happened* from *when we received it*. A watermark on the late side is
 *     an adapter concern (Task 2/3) — but the two clocks exist on the envelope
 *     itself so that concern is expressible at all.
 *
 * `type` is one of the EVENT_NAMES constants (@tip/events). `version` is the
 * payload schema version (Task 3), starting at 1; bump it when a payload shape
 * changes incompatibly so consumers can branch.
 */
export interface DomainEvent<T = unknown> {
  /** UUID v4 — unique per event, the idempotency key (§29). */
  readonly id: string;
  /** Lowercase-dotted event name from EVENT_NAMES (§10). */
  readonly type: string;
  /** Payload schema version (Task 3). Starts at 1. */
  readonly version: number;
  /** ISO-8601 — when the thing actually happened (§10 event-time). */
  readonly eventTime: string;
  /** ISO-8601 — when this system received/created the event (§10 processing-time). */
  readonly processingTime: string;
  /** Producer id, e.g. "bybit-adapter" / "helius-webhook". */
  readonly source: string;
  /** Optional trace id linking events that belong to one causal chain. */
  readonly correlationId?: string;
  /** The normalized, provider-agnostic payload (§12). */
  readonly payload: T;
}

/**
 * Fields the caller supplies; the bus fills in `id`, `processingTime`, and
 * defaults `version` to 1 when the producer publishes. Keeps producers from
 * hand-rolling ids or clocks inconsistently.
 */
export type NewDomainEvent<T = unknown> = Omit<
  DomainEvent<T>,
  'id' | 'processingTime' | 'version'
> & { readonly version?: number };
