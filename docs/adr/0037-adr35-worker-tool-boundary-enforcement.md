# ADR 35: Worker/Tool Boundary Enforcement

**Status:** Accepted  
**Date:** 2026-06-01  
**Supplements:** ADR 29 (Worker / Tool / Knowledge / Connector Boundary Definitions)

## Context

ADR 29 defines the conceptual boundary between Workers (graph write capability, ADR 27 lifecycle) and Tools (stateless, no graph writes). However, ADR 29's boundary is enforced only by naming convention (`graph::` prefix vs `tool::` prefix) and documentation. A developer could write a Tool that calls `graph.write()` via an `any` cast, violating the boundary without compile-time error. The object-capability model requires that the capability simply not exist in the Tool context — not merely that it is undocumented. This ADR establishes two-layer physical isolation before Phase 1 implementation begins.

## Decision

Worker/Tool boundary enforcement is implemented via two physical layers: (1) compile-time TypeScript abstract classes and interface segregation (the `write()` method does not exist on `ToolExecutionContext`), and (2) runtime dependency injection (the control plane injects `ReadOnlyGraphHandle` into Tool sandboxes, where calling `write()` throws `SecurityException` even via `any` cast). The capability simply does not exist in the Tool context.

## Mechanism

### Layer 1 — Compile-Time (TypeScript ABCs and Interface Segregation)

**Worker abstract base class (has lifecycle hooks + graph write capability):**

```typescript
abstract class Worker {
  // ADR 27 four-phase lifecycle — required implementation
  abstract onScheduled(ctx: WorkerExecutionContext): Promise<void>;
  abstract onRunning(ctx: WorkerExecutionContext): Promise<WorkerResult>;
  abstract onCompleted(ctx: WorkerExecutionContext): Promise<void>;
  abstract onFailed(ctx: WorkerExecutionContext, error: Error): Promise<void>;
  abstract onConflicted(ctx: WorkerExecutionContext): Promise<void>;
}

// Worker context: full graph handle with write capability
interface WorkerExecutionContext {
  scopeId: string;
  entityId: string;
  currentVersionHash: string;
  graph: GraphHandle;          // write() IS present
  input: unknown;
}

interface GraphHandle {
  write(event: GraphWriteEvent): Promise<WriteResult>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

**Tool interface (no lifecycle hooks, no graph write capability):**

```typescript
interface Tool<TInput extends z.ZodType, TOutput extends z.ZodType> {
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  execute(
    input: z.infer<TInput>,
    ctx: ToolExecutionContext
  ): Promise<z.infer<TOutput>>;
}

// Tool context: ReadOnlyGraphHandle — write() does NOT EXIST on the type
interface ToolExecutionContext {
  graph: ReadOnlyGraphHandle;  // write() is ABSENT
}

interface ReadOnlyGraphHandle {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  // write() is not declared — TypeScript will error at compile time
  // if any code attempts ctx.graph.write(...)
}
```

At compile time, any Tool implementation that calls `ctx.graph.write()` receives a TypeScript error:

```
Property 'write' does not exist on type 'ReadOnlyGraphHandle'.
```

No `any` cast audit is required in normal development — the type system enforces the boundary.

### Layer 2 — Runtime (Dependency Injection Capability Model)

The control plane injects `ExecutionContext` at Worker/Tool spawn time. The injected objects are physically different:

**Worker sandbox injection:**
```typescript
const workerCtx: WorkerExecutionContext = {
  scopeId: event.scopeId,
  entityId: event.entityId,
  currentVersionHash: event.versionHash,
  graph: new GraphHandle(pool, scopeId),  // write() functional
  input: event.payload,
};
worker.onRunning(workerCtx);
```

**Tool sandbox injection:**
```typescript
const toolCtx: ToolExecutionContext = {
  graph: new ReadOnlyGraphHandleImpl(pool, scopeId),  // write() throws SecurityException
};
tool.execute(input, toolCtx);
```

**`ReadOnlyGraphHandleImpl` runtime enforcement:**

```typescript
class ReadOnlyGraphHandleImpl implements ReadOnlyGraphHandle {
  constructor(private pool: Pool, private scopeId: string) {}

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.pool.query(sql, params).then(r => r.rows as T[]);
  }

  // Runtime guard: if called via `any` cast at runtime
  // (TypeScript boundary bypassed by deliberate misuse)
  write(_event: unknown): never {
    throw new SecurityException(
      `Tool attempted graph write. Tools are stateless — graph writes ` +
      `require a Worker with graph:: prefix and ADR 27 lifecycle. ` +
      `Attempted write blocked by capability model.`
    );
  }
}
```

**Why `write()` appears on `ReadOnlyGraphHandleImpl` but not on `ReadOnlyGraphHandle`:**

The TypeScript interface `ReadOnlyGraphHandle` does not declare `write()`. The implementation class `ReadOnlyGraphHandleImpl` adds a private `write()` that throws, as a defense-in-depth measure against JavaScript `any` casts at runtime. This is an implementation detail invisible to Tool authors.

### Capability Model Summary

| Context | TypeScript Type | `write()` at compile time | `write()` at runtime |
|---------|----------------|--------------------------|---------------------|
| Worker | `WorkerExecutionContext` | Present, callable | Functional |
| Tool | `ToolExecutionContext` | Absent — TypeScript error | `SecurityException` thrown |

**The capability simply does not exist** in the Tool context. No call-chain analysis, no code review enforcement, no naming convention audit is required.

### `tool::` vs `graph::` Naming (ADR 29 Complement)

Naming convention from ADR 29 is preserved and now backed by physical enforcement:

```typescript
// Registration enforces type at compile time:
sdk.registerWorker("graph::search::hybrid", new HybridSearchWorker());  // Worker subclass
sdk.registerTool("tool::tokenize", tokenizeTool);                        // Tool interface
sdk.registerTool("tool::embed", embedTool);                              // Tool interface
```

The `sdk.registerWorker()` and `sdk.registerTool()` functions have different TypeScript signatures — passing a `Tool` to `registerWorker()` or a non-`Worker` to `registerWorker()` is a compile-time error.

## Consequences

### Positive
- The capability boundary is enforced at the type system level — Tool authors cannot accidentally write to the graph without a deliberate `any` cast.
- Defense-in-depth: even deliberate `any` cast bypasses are caught at runtime by `SecurityException` before any database write occurs.
- No code review process needed to enforce the Worker/Tool boundary — the compiler does it.
- The interface segregation makes the boundary self-documenting — reading `ToolExecutionContext` immediately communicates the absence of write capability.

### Negative / Trade-offs
- Two separate registration functions (`registerWorker` / `registerTool`) add surface area to the iii SDK.
- Runtime `SecurityException` in `ReadOnlyGraphHandleImpl.write()` is only reached via deliberate `any` misuse — it is a defense-in-depth measure that normal development will never trigger, but must be tested.
- Existing Tools written before this ADR (if any) must be audited to confirm they do not call `graph.write()`. This is a one-time migration cost.

## References
- ADR 27 — Worker lifecycle (the four-phase state machine that only Workers implement)
- ADR 29 — Worker / Tool / Knowledge / Connector boundary definitions (conceptual layer; this ADR adds physical enforcement)
- ADR 32 — PgQueueAdapter (dispatches to Workers, not Tools — dispatcher checks Worker registry, not Tool registry)
