# Implementation Notes — Graph-Native Agent Runtime

Decisions and deviations from the spec that the implementer should know.
Updated incrementally — append only.

---

## OCC event_type column always 'memory_updated' (D1) — RESOLVED

**File:** `packages/shared/src/sql/occ-writable-cte.sql.ts`
**ADR ref:** ADR 11

All agent writes via the OCC Writable CTE store `event_type='memory_updated'` in the DB column, regardless of the `event_type` field submitted by the external agent (`task_spawned` or `memory_updated`). The submitted event_type is merged into the payload JSON before being stored.

DB column semantics:
- `plan_created` — Control Plane DDL nesting
- `memory_updated` — all agent writes (first-writer OCC winner)
- `conflict_detected` — OCC loser (causal inversion, atomic rewrite)
- `scope_closed` — Gateway inline Watchdog convergence write
- `task_spawned` — allowed by CHECK constraint but never written by any code path

Payload JSON semantics: `payload.event_type` carries the client-submitted semantic type.

**Resolution (ADR 40):** OCC_WRITE_SQL now accepts event_type as $5 parameter. `task_spawned` and `memory_updated` are stored as first-class column values. TESTING-PLAN Scenario B restored to expect `task_spawned` in row 2.

---

## context_oom_throttled stored as memory_updated (D6) — RESOLVED

**File:** `packages/gateway/src/watchdog-sql.ts` — `writeContextOomThrottled()`
**ADR ref:** ADR 24, ADR 38

When context assembly OOM is triggered (Tier 3 degradation), the Gateway writes an event with:
- `event_type = 'memory_updated'` (DB column — identification requires payload inspection)
- `payload = { scope_id, reason: 'context_oom_throttled' }` (identification field)
- `status = 'suspended'` (**not** `terminated` — see ADR 38)

`status='suspended'` blocks the Convergence Watchdog SQL (`status NOT IN ('terminated', 'archived')`), preventing a partially-converged OOM scope from receiving `scope_closed`. The original `status='terminated'` was a bug: it caused the Watchdog to treat an OOM-interrupted scope as cleanly converged. Fixed in commit after `0ca9efe`.

---

## LLMProvider/EmbeddingProvider location (D3) — DEFERRED, Phase 2 Day 0

**File:** `packages/workers/src/llm/provider.interface.ts`
**ADR ref:** REQ-21

LLMProvider and EmbeddingProvider interfaces are in the workers package. REQ-21 specifies the "iii-engine layer" abstraction should be accessible from the shared package. Move to `packages/shared/src/llm/` in Phase 2 before any other package needs to import these interfaces.

**Resolution plan (agreed 2026-06-03):** Phase 2 plan 02-01 开始前作为 Day 0 纯迁移 commit——只移动接口文件，不改语义。触发点：Phase 2 第一个 plan 的前置任务，在任何 Phase 2 LLM 调用实现之前执行。

---

## Tool write() guard is compile-time only (D4) — DEFERRED, Phase 2 Day 0

**File:** `packages/workers/src/base/tool.interface.ts`
**ADR ref:** ADR 35 D-8

The Tool ABC enforces `ReadOnlyGraphHandle` (no `write()`) at TypeScript compile time only. ADR 35 D-8 specifies a runtime `SecurityException` if a tool somehow acquires write access. This runtime guard is not implemented.

**Resolution plan (agreed 2026-06-03):** 与 D3 合并为 Phase 2 plan 02-01 的同一个 Day 0 前置 commit。
- `packages/shared/src/errors.ts` 加 `SecurityException` 类
- `ReadOnlyGraphHandleImpl.write()` 改为 `throw new SecurityException(...)`
触发点：第一个真实 LLM Tool 实现之前必须到位。

---

## Gate 1 实测发现 (2026-06-03) — FIXED

### G1-Fix-1: OCC INSERT 需直接写入分区表（非父表）

**File:** `packages/shared/src/sql/occ-writable-cte.sql.ts`
**ADR ref:** ADR 11

`OCC_WRITE_SQL` 和 `OCC_WRITE_DO_NOTHING_SQL` 原为字符串常量，INSERT 目标为父表 `execution_event_log`。PostgreSQL 要求 `ON CONFLICT (cols)` 解析的唯一约束必须存在于被 INSERT 的表上。父表无此约束（仅在每个 scope 分区上），导致 `42P10 no unique constraint matching ON CONFLICT specification`。

**修复：** 两个 SQL 改为函数，接受 `partition` 参数（`execution_event_log_scope_<scope_id_no_hyphens>`）。`occ-write.ts` 新增 `partitionTable(scopeId)` 辅助函数，在调用前计算分区名。

### G1-Fix-2: Node.js v22 启动方式

**Context:** 测试计划写的是 `node --loader tsx`，在 Node.js v22 中已弃用。
**修复：** 启动命令改为 `node --import tsx/esm packages/.../index.ts`。

### G1-Obs-1: Gateway 需 Bun 运行时

Gateway 使用 `export default { port, fetch }` Bun server API。Node.js 不自动启动 HTTP 服务器。
**处理：** Gate 1 测试用 Bun 1.3.14 运行 Gateway。Phase 2 如需纯 Node.js 可加 `@hono/node-server`。

### G1-Obs-2: OCC 冲突行为说明（因果倒置）

当第二个写入者与已存在的行（predecessor_hash 相同）冲突时，DO UPDATE 更新的是 **已存在行**（winner），将其 event_type 改为 `conflict_detected`，predecessor_hash 指向其自身旧 version_hash。这是设计中的"因果倒置"。结果：冲突后原 winner 的 event_type 丢失，但 version_hash 链保持连通。Scenario E 验证正常（返回 `demoted`，HTTP 200，无报错）。
