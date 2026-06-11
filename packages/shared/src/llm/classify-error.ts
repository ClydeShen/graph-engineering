/**
 * classifyProviderError — pure error classification for LLM provider failover.
 *
 * Inspects error messages and HTTP status codes embedded in error strings to
 * determine whether an error should cause immediate re-throw (fatal) or trigger
 * failover to the next provider (transient).
 *
 * @see ADR 22 — LLM Provider Abstraction
 * @see FallbackProvider for the consumer of this function
 */

/** Reason a provider call failed. */
export type FailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'timeout'
  | 'context_length'
  | 'content_filter'
  | 'unknown';

/** Classification result returned by classifyProviderError. */
export interface ClassifiedError {
  reason: FailoverReason;
  /** If true, re-throw immediately — do not attempt next provider. */
  shouldThrow: boolean;
  /** If true, try the next provider in priority order. */
  shouldFailover: boolean;
  /** The original Error instance (or a wrapped Error if input was not an Error). */
  original: Error;
}

/**
 * Classify a provider error to determine failover behavior.
 *
 * Classification priority (first match wins):
 * 1. auth — 401, 403, "auth", "unauthorized", "forbidden" → shouldThrow
 * 2. context_length — "context_length", "context window", "too many tokens", "maximum context" → shouldThrow
 * 3. content_filter — "content_filter", "content_policy", "safety" → shouldThrow
 * 4. rate_limit — 429, "rate_limit", "rate limit", "too many requests" → shouldFailover
 * 5. overloaded — 503, "overloaded", "service unavailable" → shouldFailover
 * 6. timeout — "timeout", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "network" → shouldFailover
 * 7. unknown — anything else → shouldFailover
 */
export function classifyProviderError(err: unknown): ClassifiedError {
  const original = err instanceof Error ? err : new Error(String(err));
  const msg = original.message.toLowerCase();

  // Priority 1: auth (fatal)
  if (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('auth')
  ) {
    return { reason: 'auth', shouldThrow: true, shouldFailover: false, original };
  }

  // Priority 2: context_length (fatal)
  if (
    msg.includes('context_length') ||
    msg.includes('context window') ||
    msg.includes('too many tokens') ||
    msg.includes('maximum context')
  ) {
    return { reason: 'context_length', shouldThrow: true, shouldFailover: false, original };
  }

  // Priority 3: content_filter (fatal)
  if (
    msg.includes('content_filter') ||
    msg.includes('content_policy') ||
    msg.includes('safety')
  ) {
    return { reason: 'content_filter', shouldThrow: true, shouldFailover: false, original };
  }

  // Priority 4: rate_limit (transient)
  if (
    msg.includes('429') ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  ) {
    return { reason: 'rate_limit', shouldThrow: false, shouldFailover: true, original };
  }

  // Priority 5: overloaded (transient)
  if (
    msg.includes('503') ||
    msg.includes('overloaded') ||
    msg.includes('service unavailable')
  ) {
    return { reason: 'overloaded', shouldThrow: false, shouldFailover: true, original };
  }

  // Priority 6: timeout (transient)
  if (
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('network')
  ) {
    return { reason: 'timeout', shouldThrow: false, shouldFailover: true, original };
  }

  // Priority 7: unknown (transient — try next provider)
  return { reason: 'unknown', shouldThrow: false, shouldFailover: true, original };
}
