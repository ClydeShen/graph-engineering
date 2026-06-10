/**
 * 3-layer prompt assembler for context assembly.
 *
 * Produces { stable, context, volatile, ccrHashes, ccrInstructions, droppedCount }
 * within the W_max token budget.
 * Graph → Context is a ONE-WAY projection — this module NEVER mutates the graph.
 *
 * Layer 1 (Stable):  System role string. Cache-eligible across Anthropic API calls.
 *                    Keep stable — do not vary per invocation (ADR 30 D-1).
 *                    NOTE: CCR instructions are a SEPARATE field (ccrInstructions),
 *                    NOT appended here, so STABLE_SYSTEM_ROLE remains byte-identical
 *                    across invocations regardless of CCR state (D-03/ADR-30-D-1).
 * Layer 2 (Context): Knapsack causal lineage projection. Budget enforced by the
 *                    knapsack's own greedy loop (Zero-LLM, ADR 30 D-2).
 *                    When events are dropped, a <<ccr:HASH N_dropped>> sentinel is
 *                    appended as the last element (D-04).
 * Layer 3 (Volatile): Current input payload. Rebuilt every invocation.
 *
 * Phase 08 CCR fields on AssembledContext:
 *   ccrHashes        — list of sentinel hashes (empty when no drops).
 *   ccrInstructions  — directional guidance for the LLM (D-03 "directional channel"),
 *                      populated only when ccrHashes.length > 0. The calling
 *                      Worker/Gateway MUST place this in a non-cached prompt section
 *                      (e.g. appended near volatile/Layer-3 content).
 *   droppedCount     — number of events dropped by knapsack (0 when no drops).
 *
 * Pipeline orchestration:
 *   runContextAssemblyPipeline() wraps assembleContext() with Worker hook calls (D-06/D-08):
 *   - onContextAssembled: always called (D-06).
 *   - onContextCompressed: called only when droppedCount > 0 (D-06).
 *   - onLLMCalled / onResultWritten: NOT called here — those fire later in the Worker's
 *     own onRunning/onCompleted (outside this pipeline function's scope, per D-08).
 *
 * @see ADR 30 (Context Assembly Strategy)
 * @see ADR 24 (Agent Entry-Point Protocol — scope_closed → context=null)
 * @see ADR 13 supplement (CCR: Level-3 degradation replacement)
 * @see D-03, D-04, D-05, D-06, D-07, D-08 in 08-CONTEXT.md
 */

import type { EventLogNode } from '@shared/types';
import { countTokens } from '@shared/tokenizer';
import { knapsackSlice, type KnapsackGraph, type KnapsackConfig } from './knapsack.js';
import {
  buildCcrSentinel,
  createMemexRetrieveInstructions,
  type CcrStore,
} from './ccr.js';
import type { Worker, PipelineContext } from '../base/worker.abstract.js';

/**
 * The 3-layer assembled context with Phase 08 CCR fields.
 * context is null when the scope is closed (signals Agent to terminate).
 */
export interface AssembledContext {
  /** Layer 1: stable system role. Anthropic prompt-cache eligible — keep constant. */
  stable: string;
  /**
   * Layer 2: causal lineage projection (newest-first, within budget).
   * null signals scope_closed — consuming Agent MUST terminate (ADR 24).
   * When CCR triggers, the last element is the sentinel { _ccr_dropped: string }
   * rather than a full EventLogNode (D-04). Consumers must type-narrow before
   * treating every element as EventLogNode (T-08-06).
   */
  context: (EventLogNode | { _ccr_dropped: string })[] | null;
  /** Layer 3: current input serialized. Rebuilt every invocation. */
  volatile: string;
  /**
   * CCR sentinel hashes present in this context (D-04, D-05).
   * Always present; empty array when no events were dropped.
   * Callers can check .length === 0 to detect the no-CCR happy path.
   */
  ccrHashes: string[];
  /**
   * CCR directional guidance for the LLM (D-03 "directional channel").
   * Present only when ccrHashes.length > 0.
   * The calling Worker/Gateway is responsible for placing this in a
   * non-cached prompt section to preserve STABLE_SYSTEM_ROLE cache eligibility.
   */
  ccrInstructions?: string;
  /**
   * Number of events dropped by knapsackSlice().
   * Always present; 0 when nothing was dropped.
   */
  droppedCount: number;
}

/**
 * System role string for Layer 1 (Stable).
 *
 * IMPORTANT: This string MUST remain stable across invocations to benefit from
 * Anthropic prompt caching. Do not embed per-request data here.
 * CCR instructions go in AssembledContext.ccrInstructions (separate field, D-03).
 * @see ADR 30 D-1
 */
export const STABLE_SYSTEM_ROLE =
  'You are a graph-native agent operating on an append-only Execution Graph. ' +
  'Your context window is a read-time projection of the graph state. ' +
  'All persistent writes occur through the GraphHandle write interface only. ' +
  'Context overflow is handled by a token-budget greedy slicer — older events ' +
  'beyond the budget are excluded from this context slice. ' +
  'Excluded events may be retrievable via the memex_retrieve tool when indicated.';

/**
 * Compute the token budgets for the three context layers.
 *
 * Pure function — no side effects. Exported for independent unit testing.
 *
 * @param wMax          Maximum token budget for the entire assembled prompt.
 * @param stableTokens  Tokens consumed by the stable system role (Layer 1).
 * @param volatileTokens Tokens consumed by the current input (Layer 3).
 * @returns forKnapsack — remaining budget available for causal lineage (Layer 2).
 */
export function computeContextBudgets(params: {
  wMax: number;
  stableTokens: number;
  volatileTokens: number;
}): { forKnapsack: number } {
  return {
    forKnapsack: Math.max(0, params.wMax - params.stableTokens - params.volatileTokens),
  };
}

/**
 * Assemble a 3-layer prompt within the W_max token budget.
 *
 * Budget allocation:
 *   stable_tokens   = countTokens(stable)
 *   volatile_tokens = countTokens(volatile)
 *   forKnapsack     = computeContextBudgets(wMax, stable_tokens, volatile_tokens).forKnapsack
 *
 * knapsackSlice enforces forKnapsack greedily — no secondary discard is needed.
 *
 * On scope_closed: returns context=null to signal Agent termination (ADR 24).
 *
 * @param graph          Read-only graph accessor.
 * @param scopeId        The active Scope UUID.
 * @param rootHash       version_hash of the most-recent event (N_current).
 * @param currentInput   The Worker's current input payload object.
 * @param wMax           Maximum token budget for the entire assembled prompt.
 * @param scopeClosed    When true, context=null is returned immediately.
 * @param knapsackConfig Optional algorithm config for knapsackSlice (D-02).
 * @param ccrStore       Optional invocation-scoped store for dropped payloads (D-05).
 *                       When omitted, CCR sentinel/instructions are still computed
 *                       (D-04 always applies) but dropped payloads are not cached.
 */
export async function assembleContext(
  graph: KnapsackGraph,
  scopeId: string,
  rootHash: string,
  currentInput: unknown,
  wMax: number,
  scopeClosed = false,
  knapsackConfig?: KnapsackConfig,
  ccrStore?: CcrStore
): Promise<AssembledContext> {
  const stable = STABLE_SYSTEM_ROLE;
  const volatile = JSON.stringify(currentInput);

  // scope_closed: signal Agent to terminate (ADR 24).
  // Gateway consumes context=null and closes the agent loop (Plan 07).
  if (scopeClosed) {
    return { stable, context: null, volatile, ccrHashes: [], droppedCount: 0 };
  }

  const stableTokens = countTokens(stable);
  const volatileTokens = countTokens(volatile);
  const { forKnapsack: contextBudget } = computeContextBudgets({ wMax, stableTokens, volatileTokens });

  // Layer 2: Knapsack causal lineage projection
  // knapsackSlice enforces the budget greedily — sum(countTokens(kept)) ≤ contextBudget by invariant.
  const { kept, dropped } = await knapsackSlice(graph, scopeId, rootHash, contextBudget, knapsackConfig);

  // --- Phase 08 CCR injection (D-04) ---
  const ccrResult = buildCcrSentinel(dropped);

  if (ccrResult === null) {
    // Happy path: no drops — return context as-is, no CCR machinery.
    return { stable, context: kept, volatile, ccrHashes: [], droppedCount: 0 };
  }

  // Drops occurred: populate the in-process store (D-05) if provided.
  if (ccrStore !== undefined) {
    ccrStore.set(ccrResult.hash, dropped);
  }

  const ccrHashes = [ccrResult.hash];
  const ccrInstructions = createMemexRetrieveInstructions(ccrHashes);

  // Append sentinel as last element — T-08-06: narrow type union distinguishes sentinel
  // from real EventLogNode (separate key _ccr_dropped, not present on EventLogNode).
  const context: (EventLogNode | { _ccr_dropped: string })[] = [
    ...kept,
    ccrResult.sentinel,
  ];

  return {
    stable,
    context,
    volatile,
    ccrHashes,
    ccrInstructions,
    droppedCount: dropped.length,
  };
}

// Local type alias for calling protected Worker hooks from outside the class (D-08).
// These hooks are intentionally `protected` on Worker (D-06) but must be invoked from
// the assembly-path orchestrator (runContextAssemblyPipeline), which is the documented
// "friend" of Worker for this purpose.
type HookCaller = {
  onContextAssembled(ctx: Readonly<PipelineContext>): Promise<void>;
  onContextCompressed(ctx: Readonly<PipelineContext>): Promise<void>;
};

/**
 * Orchestration wrapper: assembleContext() + Worker pipeline hook calls (D-06/D-08).
 *
 * Computes volatileTokens/contextLayerTokens, populates PipelineContext, calls hooks:
 *   - onContextAssembled: always called.
 *   - onContextCompressed: called only when droppedCount > 0.
 *   - onLLMCalled / onResultWritten: NOT called here — those fire later in the Worker's
 *     own onRunning/onCompleted (outside this pipeline function's scope). Phase 09
 *     callers should invoke those hooks after the LLM call and graph write respectively.
 *
 * @param worker        Worker instance whose hooks are called.
 * @param graph         Read-only graph accessor.
 * @param scopeId       The active Scope UUID.
 * @param rootHash      version_hash of the most-recent event (N_current).
 * @param currentInput  The Worker's current input payload object.
 * @param wMax          Maximum token budget for the entire assembled prompt.
 * @param opts          Optional: scopeClosed, knapsackConfig, ccrStore.
 */
export async function runContextAssemblyPipeline(
  worker: Worker,
  graph: KnapsackGraph,
  scopeId: string,
  rootHash: string,
  currentInput: unknown,
  wMax: number,
  opts?: { scopeClosed?: boolean; knapsackConfig?: KnapsackConfig; ccrStore?: CcrStore }
): Promise<AssembledContext> {
  const volatileTokens = countTokens(JSON.stringify(currentInput));

  const result = await assembleContext(
    graph,
    scopeId,
    rootHash,
    currentInput,
    wMax,
    opts?.scopeClosed ?? false,
    opts?.knapsackConfig,
    opts?.ccrStore
  );

  const contextLayerTokens = result.context != null
    ? countTokens(JSON.stringify(result.context))
    : 0;

  const pipelineCtx: PipelineContext = {
    scopeId,
    wMax,
    volatileTokens,
    contextLayerTokens,
    ccrHashes: result.ccrHashes,
    droppedCount: result.droppedCount,
  };

  // Always call onContextAssembled (D-06).
  await (worker as unknown as HookCaller).onContextAssembled(pipelineCtx);

  // Only call onContextCompressed when drops occurred (D-06).
  if (pipelineCtx.droppedCount > 0) {
    await (worker as unknown as HookCaller).onContextCompressed(pipelineCtx);
  }

  return result;
}
