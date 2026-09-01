/**
 * Typed error hierarchy (CLAUDE.md — "Errors").
 *
 * Throw one of these, never a bare string, and never swallow: if you catch,
 * either handle or rethrow. The three kinds map to three handling policies,
 * which the queue/worker layer keys off (see @tip/events retry policy):
 *
 *   RetryableError   — transient I/O (network hiccup, upstream 5xx). Retry.
 *   FatalError       — data corruption / bad config. Do not retry; alert a human.
 *   ValidationError  — bad input. Reject the input; do not retry.
 */

export abstract class DomainError extends Error {
  /** Machine-readable code for logs/metrics; defaults to the class name. */
  readonly code: string;
  /** Structured context attached at throw time. Never put secrets here. */
  readonly context: Readonly<Record<string, unknown>>;

  protected constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = new.target.name;
    this.context = Object.freeze({ ...context });
    // Restore prototype chain across the TS/ES class-extends-Error boundary.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Transient failure — safe to retry (the queue will, with backoff). */
export class RetryableError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/** Unrecoverable — data corruption or misconfiguration. Alert; never retry. */
export class FatalError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/** Bad input — reject it. Not the system's fault; retrying won't help. */
export class ValidationError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
  }
}

/** True when the error signals the operation is worth retrying. */
export function isRetryable(err: unknown): boolean {
  return err instanceof RetryableError;
}
