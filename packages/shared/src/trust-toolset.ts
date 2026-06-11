/**
 * Trust level → tool allowlist mapping (ADR-47 D-7, ADR-46 interlock).
 *
 * Defense-in-depth layer: the boundary is the execution container (D-4), this
 * mapping keeps untrusted third-party content (inbound webhooks) away from
 * file/exec/graph-write tools entirely.
 */

import type { TrustLevel } from '@graph/types/core';

/** Read-only / coordination tools safe for untrusted principals. */
export const WEBHOOK_SAFE_TOOLS = [
  'wait_all_tasks',
  'get_agent_card',
  'search_memory',
] as const;

const PAIRED_DENIED = new Set(['execute_bash']);

/**
 * Is `tool` permitted for a principal at `trust`?
 *   trusted   → everything
 *   paired    → everything except execute_bash (explicit upgrade required)
 *   untrusted → WEBHOOK_SAFE_TOOLS only
 */
export function isToolAllowed(trust: TrustLevel, tool: string): boolean {
  if (trust === 'trusted') return true;
  if (trust === 'paired') return !PAIRED_DENIED.has(tool);
  return (WEBHOOK_SAFE_TOOLS as readonly string[]).includes(tool);
}
