# ADR 11 Supplement｜Working Memory 时间窗口去重（TD-B / P1-F）

status: accepted
日期: 2026-06-11
supplements: ADR 11（Working Memory 写入语义）

---

## 上下文

版本哈希公式含 predecessor_hash——同一祖先下的重复写入被 OCC 唯一约束拦截，但**相同工具调用发生在不同前驱下**会产生不同 version_hash，结构去重失效。高频工具调用的语义重复污染账本与 Knapsack token 预算（追踪表 P1-F，原"Phase 2 补入"，Phase 10 落地）。

## 决策

1. **去重哈希**：`SHA256(scope_id|entity_id|event_type|payload_hash)`——刻意**不含** predecessor_hash（这正是要拦截的轴）+ 5 分钟 `created_at` 窗口（agentmemory 模式）。
2. **接线位置**：Gateway `processAgentTurn` 在 OCC 写入**之前**调用 `insertWorkingMemory`（`packages/workers/src/memory/working-memory.ts`）。窗口命中 → 返回 `{deduplicated: true}`，账本零写入，HTTP 200（确认已记录，非拒绝）。
3. **范围限定**：仅 `memory_updated`（工具结果的落点，高频重复源）。生命周期事件（plan_created / task_spawned / scope_closed / conflict_detected）**永不去重**——重复的 task_spawned 可能是合法重试。
4. **副作用即特性**：去重检查同时完成 Working Memory 原始观察捕获（写入 `working_memory` 表，24h TTL 04:00 cron 清理）。
5. **可观测**：窗口命中记日志事件 `working_memory.dedup`。

## 后果

- 不同前驱下的 5 分钟内语义重复被拦截——Knapsack 装包不再为重复工具调用付费
- 已知边界：5 分钟外的重复不拦（属正常重做）；恶意构造的微小 payload 差异绕过哈希（不在威胁模型内，Phase 14 处理不可信来源）

关联：ADR 11（宿主）；ADR 41（OCC 槽位语义）；`process-agent-turn.test.ts`（窗口行为测试）；gate3 集成测试 G3-5。
