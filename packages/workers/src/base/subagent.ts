/**
 * Subagent scope branching — Phase 1 (in-process only).
 *
 * Creates a child Scope UUID, appends a spawned_by hyperedge recording the
 * parent→child lineage relationship in the execution graph.
 *
 * Phase 1 constraints (ADR 34 D-7):
 *  - In-process execution only. Distributed/forked execution is Phase 4.
 *  - MAX_CHILD_SCOPE_DEPTH = 3. Throws if parentDepth + 1 > MAX_CHILD_SCOPE_DEPTH.
 *  - Requires env GRAPH_AGENT_CHILD_SCOPE to be set (in-process guard).
 *  - Does NOT call the Control Plane nesting protocol — that is Gateway/Control-Plane
 *    responsibility. This function records the lineage hyperedge only.
 *
 * Hyperedge shape (ADR 34):
 *   (parent_scope_id, child_scope_id, 'scope_spawned', version_hash, timestamp)
 *   payload carries spawned_by_scope = parentScopeId
 *
 * Scope UUID is the BUSINESS TASK IDENTITY — completely independent of context
 * window size. Each child Scope gets a fresh UUID. (ADR 33 / REQ-23)
 *
 * @see ADR 34 — Subagent scope branch model (REQ-14)
 * @see ADR 33 — Scope identity orthogonality (REQ-23)
 */

import { randomUUID } from 'crypto';
import { MAX_CHILD_SCOPE_DEPTH, ZERO_HASH } from '@shared/constants.js';
import { canonicalJson } from '@shared/canonical-json.js';
import type { GraphHandle } from './graph-handle.js';

/**
 * Spawn a child Scope from a parent Scope.
 *
 * Writes a `scope_spawned` event carrying the `spawned_by_scope` payload field
 * to record the parent→child lineage in the execution graph.
 *
 * Phase 1: in-process execution only. The child scope runs in the same process.
 * Phase 4 will add distributed/forked execution via runtime.fork().
 *
 * @param graph        Parent Worker's GraphHandle (write-capable)
 * @param parentScopeId  UUID of the parent Scope
 * @param parentDepth    Nesting depth of the parent (0 = root)
 * @param input          Arbitrary input payload for the child scope
 * @returns              The child Scope UUID
 * @throws               If parentDepth + 1 > MAX_CHILD_SCOPE_DEPTH (depth guard)
 * @throws               If GRAPH_AGENT_CHILD_SCOPE env var is not set (in-process guard)
 */
export async function spawnChildScope(
  graph: GraphHandle,
  parentScopeId: string,
  parentDepth: number,
  input: unknown,
): Promise<{ childScopeId: string }> {
  // Guard 1: nesting depth limit
  const childDepth = parentDepth + 1;
  if (childDepth > MAX_CHILD_SCOPE_DEPTH) {
    throw new Error(
      `SubagentDepthExceeded: cannot spawn child at depth ${childDepth}; ` +
      `MAX_CHILD_SCOPE_DEPTH=${MAX_CHILD_SCOPE_DEPTH} (ADR 34 D-7)`,
    );
  }

  // Guard 2: in-process only (Phase 1)
  // Distributed/forked execution requires GRAPH_AGENT_CHILD_SCOPE to be set by the
  // orchestrator to signal that in-process spawning is permitted.
  // Phase 4 will remove this guard when runtime.fork() is available.
  if (!process.env['GRAPH_AGENT_CHILD_SCOPE']) {
    throw new Error(
      'SubagentEnvGuard: GRAPH_AGENT_CHILD_SCOPE env var must be set for in-process ' +
      'child scope spawning (Phase 1 only; distributed execution is Phase 4)',
    );
  }

  // Generate child Scope UUID — new business-task identity, independent of parent context size
  const childScopeId = randomUUID();

  // The child entity UUID for the scope_spawned event
  const childEntityId = randomUUID();

  // Read the current tip of the parent scope chain so the hyperedge appends correctly.
  // Using ZERO_HASH would conflict with plan_created which already owns that slot.
  const tipRows = await graph.query<{ version_hash: string }>(
    `SELECT version_hash FROM execution_event_log
     WHERE scope_id = $1 AND event_type <> 'conflict_detected'
     ORDER BY id DESC LIMIT 1`,
    [parentScopeId],
  );
  const predecessorHash = tipRows[0]?.version_hash ?? ZERO_HASH;

  // Build the spawned_by hyperedge payload.
  // Shape: (parent_scope_id, child_scope_id, 'scope_spawned', version_hash, timestamp)
  // payload carries spawned_by_scope = parentScopeId (ADR 34)
  const payloadObj = {
    spawned_by_scope: parentScopeId,  // required payload field (ADR 34 D-7)
    child_scope_id: childScopeId,
    child_depth: childDepth,
    input,
  };

  // canonical_json_text: pre-serialize with sorted keys (ADR 02 BTreeMap requirement)
  const canonical_json_text = canonicalJson(payloadObj);

  // Write the scope_spawned / spawned_by hyperedge to the execution graph
  // Uses plan_created event type as the closest canonical type for scope lifecycle events.
  // NOTE: The actual event_type is 'task_spawned' per the five canonical types (ADR 12).
  // 'scope_spawned' describes the semantic; the wire type is 'task_spawned'.
  await graph.write({
    scope_id: parentScopeId,
    entity_id: childEntityId,
    event_type: 'task_spawned',
    predecessor_hash: predecessorHash,
    canonical_json_text,
  });

  return { childScopeId };
}

