import { describe, it, expect } from 'vitest';
import { classifyProviderError } from './classify-error.js';

describe('classifyProviderError', () => {
  it('classifies 401 as auth shouldThrow', () => {
    const result = classifyProviderError(new Error('request failed: 401 Unauthorized'));
    expect(result.reason).toBe('auth');
    expect(result.shouldThrow).toBe(true);
    expect(result.shouldFailover).toBe(false);
  });

  it('classifies 403 as auth shouldThrow', () => {
    const result = classifyProviderError(new Error('403 Forbidden'));
    expect(result.reason).toBe('auth');
    expect(result.shouldThrow).toBe(true);
    expect(result.shouldFailover).toBe(false);
  });

  it('classifies 429 as rate_limit shouldFailover', () => {
    const result = classifyProviderError(new Error('429 Too Many Requests'));
    expect(result.reason).toBe('rate_limit');
    expect(result.shouldThrow).toBe(false);
    expect(result.shouldFailover).toBe(true);
  });

  it('classifies 503 as overloaded shouldFailover', () => {
    const result = classifyProviderError(new Error('503 Service Unavailable'));
    expect(result.reason).toBe('overloaded');
    expect(result.shouldThrow).toBe(false);
    expect(result.shouldFailover).toBe(true);
  });

  it('classifies context_length as shouldThrow', () => {
    const result = classifyProviderError(new Error('context_length exceeded'));
    expect(result.reason).toBe('context_length');
    expect(result.shouldThrow).toBe(true);
    expect(result.shouldFailover).toBe(false);
  });

  it('classifies content_filter as shouldThrow', () => {
    const result = classifyProviderError(new Error('content_filter triggered'));
    expect(result.reason).toBe('content_filter');
    expect(result.shouldThrow).toBe(true);
    expect(result.shouldFailover).toBe(false);
  });

  it('classifies network timeout as shouldFailover', () => {
    const result = classifyProviderError(new Error('network timeout occurred'));
    expect(result.reason).toBe('timeout');
    expect(result.shouldThrow).toBe(false);
    expect(result.shouldFailover).toBe(true);
  });

  it('classifies unknown errors as shouldFailover', () => {
    const result = classifyProviderError(new Error('something went wrong'));
    expect(result.reason).toBe('unknown');
    expect(result.shouldThrow).toBe(false);
    expect(result.shouldFailover).toBe(true);
  });

  it('preserves original error in ClassifiedError.original', () => {
    const err = new Error('401 auth failure');
    const result = classifyProviderError(err);
    expect(result.original).toBe(err);
  });

  it('wraps non-Error values in a new Error', () => {
    const result = classifyProviderError('string error');
    expect(result.original).toBeInstanceOf(Error);
    expect(result.original.message).toBe('string error');
  });
});
