# ADR 46｜Agent 联邦：skill 两级词表、多候选排序、Lesson 可见性域、冲突归因、身份归一化

status: accepted
日期: 2026-06-11

---

## 上下文

Phase 13 把"单 agent + 外挂工具"升级为"多 agent 共享一张图"。本 ADR 收口三个悬决决策（TD-I skill 粒度 / Lesson 可见性 / OCC 冲突归因）与两项债务（TD-J 循环检测 / TD-K 轮询升级），并给出 A2A 评估结论。

## 决策

### D-1：skill 两级词表（TD-I，P1-G 自 Phase 3 悬决）

- **第一级（粗类目）**：spawner 声明 `required_skills`（`code` / `email` / `research` / `message-handler`…）——Phase 3 的现有词表原样成为第一级，**零迁移**
- **第二级（细标签，可选）**：AgentCard.skills 可附加细标签（`typescript` / `sql-migration`…）；spawner **不需要**了解 executor 内部能力（解 P1-G 核心矛盾），细标签只在同类目多候选**排序**时使用
- 路由匹配（GIN `&&`）只看第一级语义——细标签是排序信号，不是过滤条件

### D-2：多候选排序——advisory 排序层，不破坏 D-1（无指派）

ADR-42 D-1（禁止 assigned_agent_id）不变：FrontierScheduler 仍只做可用性门控，agent 经 SKIP LOCKED 自取。排序层用于**需要做选择的位置**（内部 delegation 选目标、claim 端建议序）：

```
score = trust_weight(trust_level) × 0.5 + success_rate × 0.5
trust_weight: trusted=1.0, paired=0.6, untrusted=0.2
success_rate = (success + 1) / (success + failure + 2)   -- Laplace 平滑；新 agent 冷启动退化为 trust 单信号（显式声明）
```

`agent_registry.trust_level`（migration 015，枚举来自 `@graph/types/core` TRUST_LEVELS——13/14 互锁的单一定义）。per-agent 历史成功率的数据源由 D-4 冲突归因开始积累；积累前 success/failure 取 0（退化行为已声明）。

### D-3：Lesson/记忆可见性域（安全语义，非建议语义）

- 三表加 `visibility TEXT NOT NULL DEFAULT 'global'`（`agent-private` / `shared` / `global`）+ `owner_principal TEXT NULL`（migration 015；默认回填 global——Phase 10 §6.3 已确认廉价）
- **检索强制**：`mem::reflect` 全部检索路径（HNSW 与 BM25 两路、三表）加过滤：
  `visibility != 'agent-private' OR owner_principal = $principal`
  private 泄漏即 bug（红线测试）。shared 与 global 在单租户 1.0 检索行为一致；区别在 post-1.0 联邦（shared 限 pairing group）——枚举先行，语义分化不需迁移
- 写侧默认 global（现行为不变）；delegation 产物标注 private/shared 由调用方传入

### D-4：OCC 冲突归因（agent 身份进入 Trail）

- Gateway events 路由从 `X-Agent-ID`（pairing 体系既有 header）取 principal，merge 进 payload 的 `_principal` 字段后写入
- 冲突时：demoted 写入者的 payload（含 `_principal`）成为 conflict_detected 行内容，winner 的身份在前驱事件中——**双方可归因**，无哈希语义改动（payload 在计算前就含归因字段）
- 归因不是裁决：ConflictResolverWorker 语义不变
- 这同时是 D-2 历史成功率与 Phase 14 审计（"这个 agent 总在制造冲突"）的数据源

### D-5：跨渠道身份归一化（same_as）

- `principal_alias(alias PRIMARY KEY, principal)` 投影表（migration 015）：`telegram:123` → `user:alice`。查询路径需要 O(1) 别名解析，纯图遍历不可行——表是**可查询投影**，建立别名同时写 `memex::identity::same_as` 审计事件入图（图是 SSOT 的审计面）
- 人与 agent 共用 principal 模型：`user:*` / `agent:*` / 渠道前缀别名统一解析
- 自动身份合并建议（Trail Discovery 统计发现）→ post-1.0；本阶段别名由用户/管理员显式建立

### D-6：A2A 评估结论

A2A 规范演进快且本实施环境无法核验当期版本——按 13-PHASE-SPEC 的评估先行设计，结论：**接口预留，最小桥推迟**。已就位的预留：self AgentCard 声明 `protocols: ['mcp','a2a']` 与 `endpoints.a2a: '/a2a/rpc'`（Phase 6 side-branch 产物）；AgentCard schema 与 A2A capability 声明结构兼容。落地条件：可核验 A2A 当期规范的环境 + 一个真实外部 A2A agent 对手盘。

### D-7：FrontierScheduler 循环检测（TD-J，ADR-42 D-6 落地）

dispatch 前对含 `spawned_by` 的候选走递归 CTE 祖先链（深度上限 10）：链中 entity 重复出现 → 该任务 `status='terminated'` + `ERR_CYCLE_DETECTED` 日志，不再等 TTL+watchdog 兜底。

### D-8：`wait_all_tasks` LISTEN/NOTIFY（TD-K）

轮询（2s）升级为 LISTEN `graph_event_ready` 事件驱动 + 10s 防漏兜底轮询。返回形状不变（`{timed_out, completed, pending}`——向后兼容）。Phase 3 选轮询的理由（stateless transport 无持久订阅）已被 Gateway 常驻进程消解。

## 后果

- P1-G/P1-H/TD-K 关账；可见性域为 post-1.0 Federated Mesh 的前置（过滤逻辑单点：`visibilityFilter`）
- 已知边界：HNSW 部分索引不能按动态 principal 过滤——过滤后置，召回补偿（Top-20 → Top-40）在 private 行占比高时才需要，单租户 1.0 不触发，记录不实现

## 关联

ADR-42（宿主：skills/路由）；ADR-41（OCC——归因不改哈希语义）；ADR-21（reflect——可见性强制点）；ADR-43（owner_principal 与 erase 级联兼容）；migration 015；TRUST_LEVELS（@graph/types/core）。
