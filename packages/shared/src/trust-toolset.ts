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

// Tools that reach the exec/disk boundary need the explicit trust upgrade.
// Phase 20 adds capability_install (writes skills to disk after approval) and
// browser (drives the containerized browser backend).
const PAIRED_DENIED = new Set(['execute_bash', 'capability_install', 'browser']);

/**
 * Is `tool` permitted for a principal at `trust`?
 *   trusted   → everything
 *   paired    → everything except the exec/disk boundary set above
 *   untrusted → WEBHOOK_SAFE_TOOLS only
 */
export function isToolAllowed(trust: TrustLevel, tool: string): boolean {
  if (trust === 'trusted') return true;
  if (trust === 'paired') return !PAIRED_DENIED.has(tool);
  return (WEBHOOK_SAFE_TOOLS as readonly string[]).includes(tool);
}
