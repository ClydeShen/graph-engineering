# ADR 37: Pattern Discovery Schedule

**Status:** Accepted  
**Date:** 2026-06-01  
**Supplements:** ADR 25 (Cross-Domain Topology Pattern Discovery Algorithm), ADR 28 (Scheduling Spec and Operational Determinism)

## Context

ADR 25 defines the WL graph kernel algorithm for cross-domain topology pattern extraction (Workflow Emergence). It specifies what is computed but not when or how often the computation runs, nor how it interacts with the operational OLTP execution bus during burst completions. Pattern discovery is CPU-intensive (WL graph kernel iterations over all completed Scope topologies) and potentially token-intensive (if LLM-assisted clustering is added in Phase 2). Running it inline on every `scope_completed` event during burst completions would compete with operational Workers for the `Max_Parallelism = 4` slots, potentially starving OLTP execution. An explicit schedule and corpus guard are required before Phase 1 to prevent resource contention and to define graceful cold-start behavior.

## Decision

Cross-Scope topological pattern extraction (Workflow Emergence) is a scheduled, offline OLAP operation physically isolated from the online OLTP execution bus. `graph::patterns::discover` runs on a cron schedule (default: every 6 hours) with a minimum corpus guard of 10 unanalyzed completed Scopes. Inline `scope_completed` event triggering is permanently abolished for Phase 1.

## Mechanism

### Scheduled Worker Registration

```typescript
sdk.registerFunction(
  "graph::patterns::discover",
  async (data: PatternDiscoveryTrigger) => {
    await patternDiscoveryWorker.onRunning(ctx);
  }
);

// Cron configuration in iii-config.yaml:
// scheduled_workers:
//   - function_id: graph::patterns::discover
//     schedule: "0 */6 * * *"   # every 6 hours
//     base_priority: 1           # lowest priority — yields to operational Workers
```

### Corpus Guard

```typescript
async function discoverPatterns(ctx: WorkerExecutionContext): Promise<WorkerResult> {
  // Corpus guard: minimum N unanalyzed completed Scopes before running
  const corpusCount = await ctx.graph.query<{ count: number }>(
    `SELECT COUNT(*) AS count 
     FROM scopes 
     WHERE status = 'completed' 
       AND analyzed_for_patterns = false`,
  );

  if (corpusCount[0].count < MIN_CORPUS_THRESHOLD) {
    // Not enough data — skip this run, log, and wait for next schedule tick
    await ctx.graph.write({
      event_type: 'memory_updated',
      entity_id: PATTERN_DISCOVERY_ENTITY_ID,
      payload: {
        entity_type: 'knowledge',
        knowledge_type: 'domain_fact',
        event: 'pattern_discovery_skipped',
        reason: 'corpus_below_threshold',
        corpus_count: corpusCount[0].count,
        threshold: MIN_CORPUS_THRESHOLD,
      },
      predecessor_hash: ctx.currentVersionHash,
    });
    return WorkerResult.skip('Corpus below threshold');
  }

  // Run OLAP extraction — reads from graph, writes Pattern entities
  const completedScopes = await ctx.graph.query(
    `SELECT scope_id, topology_json, intent_embedding 
     FROM scopes 
     WHERE status = 'completed' AND analyzed_for_patterns = false
     ORDER BY closed_at ASC`
  );

  // WL graph kernel computation (ADR 25 algorithm)
  const patterns = await wlGraphKernel.extractPatterns(completedScopes);

  // Write extracted patterns as Knowledge entities
  for (const pattern of patterns) {
    await ctx.graph.write({
      event_type: 'memory_updated',
      entity_id: pattern.entityId,
      payload: {
        entity_type: 'knowledge',
        knowledge_type: 'domain_fact',
        pattern_type: 'cross_scope_topology',
        topology_embedding: pattern.embedding,
        source_scope_ids: pattern.sourceScopeIds,
        occurrence_count: pattern.occurrenceCount,
        topology_description: pattern.description,
      },
      predecessor_hash: ctx.currentVersionHash,
    });
    ctx = ctx.advanceVersionHash(writeResult.version_hash);
  }

  // Mark analyzed Scopes
  await ctx.graph.query(
    `UPDATE scopes SET analyzed_for_patterns = true 
     WHERE scope_id = ANY($1)`,
    [completedScopes.map(s => s.scope_id)]
  );

  return WorkerResult.completed();
}

const MIN_CORPUS_THRESHOLD = 10; // Phase 1 fixed value; configurable via iii-config.yaml
```

### OLAP/OLTP Isolation

| Property | OLTP (operational) | OLAP (pattern discovery) |
|----------|-------------------|--------------------------|
| Trigger | `graph::frontier::changed` event (ADR 31) | Cron schedule (every 6 hours) |
| Priority | `base_priority` per task type | `base_priority = 1` (lowest) |
| Competes for `Max_Parallelism` | Yes | Yes — but lowest priority yields first |
| Subscribes to `scope_completed` | N/A | **No** — cron only, never inline |
| Token intensity | Moderate (per-task LLM calls) | High (WL kernel over all Scopes) |
| CPU intensity | Moderate | High (graph traversal) |

The ADR 31 frontier scheduler's `base_priority * 10` formula ensures pattern discovery (`base_priority = 1`, `dynamic_score ≤ 10 + 20 = 30`) yields to any operational Worker with `base_priority ≥ 4` (`dynamic_score ≥ 40`). At `Max_Parallelism = 4`, pattern discovery only runs when all 4 slots are otherwise idle.

### Cold-Start Behavior

Phase 1 corpus starts empty. The system operates as a capable single-session agent before patterns emerge:

```
Scopes 0–9 complete:  
  → Pattern discovery runs every 6 hours
  → Corpus guard returns WorkerResult.skip()
  → No patterns written — system runs in single-session mode

Scope 10+ complete:
  → Corpus guard passes
  → WL kernel extracts first cross-Scope patterns
  → Patterns written to graph as Knowledge entities (knowledge_type='domain_fact')
  → Workers can now query patterns during cold-start context assembly (ADR 30 Stable tier)

Expected timeline: first meaningful patterns after ~10 completed multi-step Scopes
```

This is graceful degradation by design. The system does not require pattern discovery to function — pattern-augmented cold starts are an optimization that becomes available as the corpus grows.

### Rejected Approach: Inline Trigger on `scope_completed`

Permanently abolished for Phase 1. The rejection reasoning:

During burst completions (e.g., 8 Scopes complete in rapid succession after a long research task fans out), inline triggering would enqueue 8 pattern discovery Workers. With `Max_Parallelism = 4`, all 4 slots would be consumed by OLAP work, leaving zero capacity for new OLTP tasks (user-initiated tasks, sub-Worker spawning, conflict resolution). The user-visible effect: the system becomes unresponsive to new work during the post-burst pattern extraction window.

Cron scheduling eliminates this pathology by decoupling pattern discovery from the operational event stream entirely. The 6-hour window means at most one pattern discovery run competes for OLTP slots per period, and its `base_priority = 1` ensures it yields immediately if any OLTP work arrives.

## Consequences

### Positive
- OLAP (pattern extraction) and OLTP (task execution) are physically isolated — burst completions do not starve operational Workers.
- Cold-start graceful degradation: the system is fully functional as a single-session agent before patterns emerge.
- Corpus guard prevents low-quality pattern extraction on trivially small datasets.
- Cron schedule is configurable via `iii-config.yaml` — production deployments can tune to 1 hour or 24 hours based on workload characteristics.

### Negative / Trade-offs
- Pattern discovery is delayed by up to 6 hours after a new batch of Scopes completes. For rapid prototyping or testing, this delay requires either lowering the cron interval or manually triggering `graph::patterns::discover`.
- The `MIN_CORPUS_THRESHOLD = 10` means new deployments have no cross-Scope pattern recommendations until 10 Scopes complete. This is intentional (quality guard) but may feel like a cold-start penalty.
- `analyzed_for_patterns` flag on the `scopes` table is a mutable field in an otherwise immutable system. This is acceptable because it is a processing metadata flag (not part of the execution history record) and is idempotent (setting it twice has no effect).

## References
- ADR 25 — WL graph kernel algorithm (the computation that this ADR schedules)
- ADR 28 — `Max_Parallelism` and scheduling spec (priority formula; pattern discovery uses `base_priority = 1`)
- ADR 29 — Knowledge entity types (patterns are written as `domain_fact` Knowledge entities)
- ADR 30 — Context Assembly Strategy (Stable tier includes pattern Knowledge entities for cold-start augmentation)
- ADR 31 — Frontier Scheduler (priority SQL; pattern discovery's `dynamic_score` always yields to operational Workers)
