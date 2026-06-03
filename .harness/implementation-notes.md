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

## Tool write() guard — D4 STATUS CORRECTION (2026-06-03)

**File:** `packages/workers/src/base/read-only-handle.ts`
**ADR ref:** ADR 35 D-8

**RESOLVED — already implemented.** `SecurityException` class and `ReadOnlyGraphHandleImpl.write() → throw SecurityException()` are both present in `packages/workers/src/base/read-only-handle.ts`. The D4 "DEFERRED to Phase 2" entry was incorrect — the runtime guard was already in place. Confirmed by gsd-verifier during Gate 1 (2026-06-03). Phase 2 Day 0 does NOT need to implement D4; only D3 (LLMProvider move to shared) remains.

---

## Control Plane OOM status inconsistency — Phase 2 fix needed

**File:** `packages/control-plane/src/watchdog.ts` line 196
**ADR ref:** ADR 38

`handleContextOom(tier=3)` writes event with `status='terminated'` instead of `'suspended'`. This would allow Convergence Watchdog to incorrectly treat an OOM-suspended scope as converged. However, `handleContextOom` has NO callers in Phase 1 (it's wired up in Phase 2 when LLM distillation is needed). Not a Phase 1 risk; fix MUST be applied in Phase 2 when wiring up the OOM handler. Fix: change line 196 from `'terminated'` to `'suspended'`.

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

### G1-Obs-2: OCC winner 被覆写 bug — FIXED (commit 54b2b01)

**原 SQL（DO UPDATE）的问题：** `ON CONFLICT DO UPDATE` 更新的是**已存在行（winner）**，将其改为 `conflict_detected` 并释放了 predecessor_hash 槽位。导致下一个写入者能再次 won，破坏 first-writer-wins 语义。

**修复（2026-06-03）：** 改为三段 CTE：
1. `attempt` — `ON CONFLICT DO NOTHING`，winner 行永不被修改
2. `conflict` — 在 winner 之后追加新 `conflict_detected` 行（因果追加，不是因果倒置）
3. `demoted_fallback` — 两个 loser 并发争同一 conflict 槽时，计算返回 version_hash 而不插入

---

## 手动测试流程问题 (2026-06-03) — 待解决

### 测试 UX 问题
1. **curl 手动 paste**：用户在 `npm run dev` 终端看日志，需要另开终端手动粘贴 curl 命令，无法与 Claude 实时互动。
2. **临时测试文件**：`scripts/test-gate1.sh` 是临时文件，不属于正式测试结构。

### 未来测试结构决策（已确定）
- 测试文件位置：项目根目录 `tests/` 目录，命名规范 `test-gate*.sh`
- 用户可在新终端直接运行 `bash tests/test-gate1.sh`，无需其他操作
- `scripts/` 目录保留 dev 工具（dev.mjs, demo-runner.ts 等），`tests/` 专放 gate 测试

### 自动化 E2E 测试流程（Phase 2+ 起执行）
每个开发阶段完成后：
1. Claude 补全对应 `tests/test-gate*.sh`
2. 通过 **subagent + background task** 自主运行 E2E 测试
3. 等待结果，汇报 pass/fail
4. 触发 `/context-handover`

此流程从 Phase 2 Gate 2 验收起生效。
