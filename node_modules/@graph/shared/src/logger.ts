/**
 * Structured JSON logger — single instance shared across all components.
 *
 * Usage:
 *   import { logger } from '@shared/logger';
 *   const log = logger.child({ component: 'gateway', scope_id });
 *   log.info({ version_hash }, LOG_EVENTS.EVENT_WRITTEN);
 *
 * Log level controlled by LOG_LEVEL env var (debug | info | warn | error).
 * Default: 'info'. Set LOG_LEVEL=debug for full hash-chain visibility.
 *
 * pino chosen over iii Logger because iii Logger only works inside iii-sdk
 * registerFunction handlers — it cannot cover the Control Plane daemon or
 * the HTTP Gateway, which are independent Node.js processes.
 */

import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'graph-native-runtime' },
});

/**
 * Canonical log event names.
 * Use these as the message string so log aggregators can group by event.
 */
export const LOG_EVENTS = {
  BOOT: 'boot',
  BOOT_ERROR: 'boot.error',

  SCOPE_CREATED: 'scope.created',
  SCOPE_CLOSED: 'scope.closed',
  SCOPE_SUSPENDED_LOCKOUT: 'scope.suspended.lockout',

  EVENT_WRITTEN: 'event.written',
  OCC_CONFLICT: 'occ.conflict',

  WORKER_LIFECYCLE: 'worker.lifecycle',
  WORKER_REGISTERED: 'worker.registered',

  LLM_CALL: 'llm.call',           // every LLM call — ADR 22
  LLM_ERROR: 'llm.error',

  FRONTIER_DISPATCH: 'frontier.dispatch',
  PULSE_FETCH: 'pulse.fetch',
  PULSE_REPLAY: 'pulse.replay',
  PULSE_ERROR: 'pulse.error',

  CONTEXT_OOM: 'context.oom',     // OOM tier invoked — ADR 13 supplement
  WATCHDOG_CHECK: 'watchdog.check',
} as const;
