/**
 * CCR (Compressed Context Retrieval) — reversible context compression.
 *
 * Graph → Context is a ONE-WAY projection; this module never writes to the graph.
 * The in-process CcrStore is an in-memory side structure (D-05), not a graph write.
 *
 * When knapsackSlice() drops events beyond the W_max budget, this module:
 *   1. Formats a <<ccr:HASH N_dropped>> sentinel appended to the context slice (D-04)
 *   2. Caches dropped event payloads in an invocation-scoped Map (D-05)
 *   3. Provides the Anthropic `memex_retrieve` tool definition (D-03, D-12)
 *   4. Provides system-prompt CCR retrieval instructions (D-03 directional channel)
 *   5. Provides the closure-based execute() handler for `memex_retrieve` tool calls
 *
 * @see ADR 13 supplement (CCR: Level-3 degradation replacement)
 * @see D-03, D-04, D-05, D-12 in 08-CONTEXT.md
 */

import type { EventLogNode } from '@shared/types';
import { contentFingerprint } from '@shared/content-fingerprint';

/** Canonical tool name for the CCR retrieval tool (D-12). */
export const MEMEX_RETRIEVE_TOOL_NAME = 'memex_retrieve';

/** Anthropic tool definition shape (provider == "anthropic" from headroom tool_injection.py). */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * In-process invocation-scoped store for dropped event payloads (D-05).
 *
 * Each createCcrStore() call returns an independent Map — no shared module-global state.
 * Follows the per-call factory pattern from packages/gateway/src/knapsack-graph.ts (eventCache).
 */
export interface CcrStore {
  set(hash: string, events: EventLogNode[]): void;
  get(hash: string): EventLogNode[] | undefined;
}

/**
 * Create an invocation-scoped CCR store (D-05).
 *
 * Returns a fresh Map per call — two stores from separate calls never share state,
 * preventing cross-scope leakage between concurrent Worker invocations.
 *
 * Pure function — exported for independent unit testing.
 */
export function createCcrStore(): CcrStore {
  const store = new Map<string, EventLogNode[]>();
  return {
    set(hash: string, events: EventLogNode[]): void {
      store.set(hash, events);
    },
    get(hash: string): EventLogNode[] | undefined {
      return store.get(hash);
    },
  };
}

/**
 * Build the CCR sentinel object for a non-empty dropped event array (D-04).
 *
 * Sentinel format: { _ccr_dropped: "<<ccr:HASH N_dropped>>" }
 * HASH = contentFingerprint(dropped event version_hashes joined by '|')
 *
 * Returns null when dropped is empty — no sentinel on the happy path
 * (keeps the zero-drop case free of CCR machinery, D-05 invocation-scoping invariant).
 *
 * Pure function — exported for independent unit testing.
 */
export function buildCcrSentinel(
  dropped: EventLogNode[]
): { sentinel: { _ccr_dropped: string }; hash: string } | null {
  if (dropped.length === 0) return null;

  // Reuse contentFingerprint (SHA-256 from @shared) per D-04 "Claude's Discretion" note —
  // do not call node:crypto directly; match existing hash conventions.
  const hash = contentFingerprint(dropped.map((e) => e.version_hash).join('|'));
  return {
    sentinel: { _ccr_dropped: `<<ccr:${hash} ${dropped.length}_dropped>>` },
    hash,
  };
}

/**
 * Create the Anthropic `memex_retrieve` tool definition (D-12).
 *
 * Ports the "provider == anthropic" branch of headroom's tool_injection.py
 * lines 75-102 to TypeScript, replacing "headroom_retrieve" with "memex_retrieve".
 *
 * Pure function — exported for independent unit testing.
 */
export function createMemexRetrieveTool(): AnthropicToolDefinition {
  return {
    name: MEMEX_RETRIEVE_TOOL_NAME,
    description:
      'Retrieve original uncompressed content that was compressed to save tokens. ' +
      "Use this when you need more data than what's shown in the compressed context. " +
      'The hash is provided in compression markers like [N items compressed... hash=HASH].',
    input_schema: {
      type: 'object',
      properties: {
        hash: {
          type: 'string',
          description: "Hash key from the compression marker (e.g. 'HASH' from hash=HASH)",
        },
        query: {
          type: 'string',
          description:
            'Optional search query to filter results. If provided, only returns items matching the query. ' +
            'If omitted, returns all original items.',
        },
      },
      required: ['hash'],
    },
  };
}

/**
 * Create CCR system-prompt instructions for directional guidance (D-03).
 *
 * Ports headroom's create_system_instructions() from tool_injection.py
 * lines 133-165, replacing CCR_TOOL_NAME with 'memex_retrieve'.
 *
 * Returns '' for an empty hashes array — no instructions injected when nothing
 * was dropped (keeps the happy path free of CCR machinery).
 *
 * Pure function — exported for independent unit testing.
 */
export function createMemexRetrieveInstructions(hashes: string[]): string {
  if (hashes.length === 0) return '';

  const hashList =
    hashes.length <= 5 ? hashes.join(', ') : `${hashes.slice(0, 5).join(', ')} ...`;

  return (
    `\n## Compressed Context Available\n\n` +
    `Some events have been compressed to reduce context size. If you need\n` +
    `the full uncompressed data, you can retrieve it using the \`${MEMEX_RETRIEVE_TOOL_NAME}\` tool.\n\n` +
    `**How to retrieve:**\n` +
    `- Call \`${MEMEX_RETRIEVE_TOOL_NAME}(hash="<hash>")\` to get all original items\n` +
    `- Call \`${MEMEX_RETRIEVE_TOOL_NAME}(hash="<hash>", query="search terms")\` to search within\n\n` +
    `**Available hashes:** ${hashList}\n`
  );
}

/**
 * Create the execute() handler for the `memex_retrieve` tool call (D-03 routing).
 *
 * Returns a closure over the invocation-scoped CcrStore. This resolves open
 * question 1 from 08-PATTERNS.md: `memex_retrieve` routing is this closure-based
 * handler, returned for the calling Worker/Gateway to register against its own
 * tool dispatch. No new global tool registry is created in Phase 08.
 *
 * Query filter: simple substring match on the raw EventLogNode.payload TEXT —
 * no JSON parsing required (payload is already TEXT per EventLogNode.payload JSDoc).
 * T-08-04: no cross-scope data exposure (store is populated only from this
 * invocation's own dropped events). T-08-05: unknown hash returns empty items,
 * no error thrown (Map.get is O(1)).
 */
export function createMemexRetrieveExecute(
  store: CcrStore
): (input: { hash: string; query?: string }) => Promise<{ items: EventLogNode[] }> {
  return async (input: { hash: string; query?: string }) => {
    const all = store.get(input.hash) ?? [];
    if (input.query === undefined || input.query === '') {
      return { items: all };
    }
    const filtered = all.filter((event) => event.payload.includes(input.query!));
    return { items: filtered };
  };
}
