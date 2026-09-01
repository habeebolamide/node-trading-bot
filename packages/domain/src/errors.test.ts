import { describe, it, expect } from 'vitest';
import { RetryableError, FatalError, ValidationError, DomainError, isRetryable } from './errors.js';

describe('error hierarchy', () => {
  it('preserves instanceof across the Error boundary', () => {
    const e = new RetryableError('boom');
    expect(e).toBeInstanceOf(RetryableError);
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toBeInstanceOf(Error);
  });

  it('sets name and code to the concrete class name', () => {
    expect(new FatalError('x').name).toBe('FatalError');
    expect(new ValidationError('x').code).toBe('ValidationError');
  });

  it('freezes context', () => {
    const e = new ValidationError('bad', { field: 'entry' });
    expect(e.context.field).toBe('entry');
    expect(Object.isFrozen(e.context)).toBe(true);
  });

  it('isRetryable only true for RetryableError', () => {
    expect(isRetryable(new RetryableError('x'))).toBe(true);
    expect(isRetryable(new FatalError('x'))).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });
});
