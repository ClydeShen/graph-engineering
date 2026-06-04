# ADR 24｜Agent 接入协议：HTTP Gateway（控制面 HTTP 层）

status: accepted  
日期: 2026-06-01

---

## 上下文

系统的核心执行循环依赖外部 Agent（Claude Code、Pi、任意自定义 Agent）向图运行时提交任务意图并接收组装好的上下文。然而所有现有 ADR（01-23）均从首个 `plan_created` 事件之后开始定义行为——**任务是如何到达系统的，完全未定义**。

这是 Phase 1 的硬性阻断缺口：

- iii-engine 是推送型事件总线（Worker 订阅事件），不原生支持 Agent 提交事件后同步等待上下文返回的请求-响应模式。
- 外部 Agent 种类各异：Claude Code 通过 Bash 或 MCP 工具调用，Pi 通过 SDK，自定义 Agent 通过 HTTP。
- MCP 协议目前由 Anthropic 主导，与厂商存在耦合；将 MCP 作为主协议会阻断非 Claude 生态的 Agent。

---

## 决策

**Phase 1：HTTP REST Gateway（首选，通用基线）**

在 iii-engine 服务进程内集成一个轻量 HTTP 服务器（Hono 或 Fastify），暴露以下最小 REST 接口：

### 接口规范

```
POST /v1/scopes
  Body:    { "intent": string }
  Response: { "scope_id": string, "plan_hash": string, "context": AssembledContext }

POST /v1/scopes/{scope_id}/events
  Body:    {
             "event_type": EventType,   -- plan_created/task_spawned/memory_updated/conflict_detected
             "entity_id":  string,      -- UUIDv4
             "predecessor_hash": string,-- 前驱 version_hash（根节点用 scope_id）
             "payload":    object
           }
  Response: { "version_hash": string, "context": AssembledContext | null }
           -- context=null 表示 scope_closed 已被触发，Scope 已终止

GET /v1/scopes/{scope_id}
  Response: { "scope_id": string, "status": "active"|"closed", "context": AssembledContext }
```

`AssembledContext` = Knapsack 切片后的完整上下文载荷，直接作为 Agent 下一轮调用的 System Prompt / Execution Context。

### 执行流程

```
外部 Agent
  │
  ├─ POST /v1/scopes { intent }
  │    └─ 控制面：三阶段筑巢（ADR 05） + 注入 plan_created
  │    └─ Knapsack 切片（ADR 13）组装初始上下文
  │    └─ 返回 { scope_id, context }
  │
  ├─ Agent（LLM）处理 context，决定下一步
  │
  ├─ POST /v1/scopes/{scope_id}/events { event_type, entity_id, ... }
  │    └─ 写入 execution_event_log（OCC，ADR 06）
  │    └─ 若 conflict_detected：唤醒 ConflictResolverWorker（ADR 18）
  │    └─ 看门狗检查（ADR 19）
  │    └─ Knapsack 重新切片，返回新 context
  │
  └─ 重复直至 context=null（scope_closed）
```

### Gateway = 控制面 HTTP 层（非无状态代理）

Gateway 不是纯粹的请求转发代理。它持有两项控制面权限，与控制面守护线程的 DDL 权限互补：

| 权限 | 持有者 | 执行场景 |
|------|--------|---------|
| **DDL 权限**（建表/索引） | 控制面守护线程（独占连接池） | Scope 筑巢（ADR 05） |
| **基础设施事件直写权限** | Gateway HTTP 层 | 看门狗终审后写入 `scope_closed`；Context OOM 时写入 `context_oom_throttled` |

具体实现：Gateway 在每次 `POST /v1/scopes/{id}/events` 的处理路径末尾**内联执行看门狗 SQL**（ADR 19 第三级 B-Tree 终审），COUNT=0 时直接在同一请求的数据库事务中写入 `scope_closed` 事件，无需跨服务 RPC。这保证了 `scope_closed` 的即时性与原子性，同时避免将 scope_closed 写入权限下放给 Worker（ADR 12）。

### Zod/Regex 铁闸（输入验证 — Phase 1 强制执行）

所有 Gateway 入口在触碰数据库前必须通过以下静态验证层：

```typescript
// UUID v4 格式（entity_id、scope_id）
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// SHA-256 哈希格式（predecessor_hash、version_hash）
const HASH_HEX64 = /^[0-9a-f]{64}$/;

// ZERO_HASH 哨兵（plan_created 根节点的 predecessor_hash）
const ZERO_HASH = '0'.repeat(64);

// Zod schema 示例（event POST body）
const EventBodySchema = z.object({
  event_type: z.enum(['task_spawned', 'memory_updated', 'conflict_detected']),
  entity_id:  z.string().regex(UUID_V4),
  predecessor_hash: z.string().regex(HASH_HEX64),
  payload:    z.record(z.unknown())
});
```

校验失败 → HTTP 400，返回结构化错误（错误字段名 + 失败原因），**不触碰数据库**。这是系统对外暴露面的第一道防线，防止格式非法输入进入 OCC 层制造幽灵事件。

### 认证与安全（Phase 1 最小实现）

- 本地部署默认无认证（监听 127.0.0.1）
- 生产部署通过 `iii-config.yaml` 配置 `gateway.api_key` Bearer Token
- Worker 数据库权限与 ADR 05 保持一致：Gateway 进程使用业务账户（SELECT/INSERT + 基础设施事件直写），无 DDL 权限

### Agent 端使用示例（Claude Code via Bash）

```bash
# 启动新 Scope
curl -s -X POST http://localhost:3000/v1/scopes \
  -H "Content-Type: application/json" \
  -d '{"intent": "analyze codebase for performance bottlenecks"}' \
  | jq .

# 提交任务分解事件
curl -s -X POST http://localhost:3000/v1/scopes/$SCOPE_ID/events \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "task_spawned",
    "entity_id": "550e8400-e29b-41d4-a716-446655440000",
    "predecessor_hash": "abc123...",
    "payload": {
      "status": "pending",
      "task_description": "Profile database query latency",
      "assigned_worker": "QueryAnalyzerWorker"
    }
  }' | jq .
```

---

## Phase 2：MCP Adapter — 按事件类型拆分的认知转译接口（延期，不阻塞 Phase 1）

### 设计原则：认知转译 > 1:1 HTTP 映射

**拒绝方案**：1:1 HTTP Gateway 映射（`scope_start` / `scope_event` / `scope_query`）

此方案要求 LLM 在每次调用时精确维护数据库状态机的心智模型：手动填写 `predecessor_hash`（上一次返回的 `version_hash`）、选择正确的 `event_type` 枚举、处理 OCC 冲突返回码。认知负担极高，生产环境中会导致频繁 400 错误和死锁式重试。

**采用方案**：按事件类型拆分的认知转译工具（Semantic Tool per Event Type）

MCP Adapter 不是 HTTP 的薄包装，而是在 HTTP Gateway 上层实现**认知转译层**：每个 MCP 工具对应一个具体的业务动作，接受 LLM 可以自然表达的语义参数，Adapter 内部完成 `predecessor_hash` 追踪、`entity_id` 生成、OCC 错误处理。

```typescript
// MCP Adapter Tool 定义（Phase 2 实现，按事件类型拆分）

{
  name: "start_task_scope",
  description: "Create a new execution scope for a task intent. Returns scope_id and initial context.",
  inputSchema: {
    intent: z.string()  // 自然语言意图描述
  },
  handler: async ({ intent }) => {
    // 内部：POST /v1/scopes { intent }
    // 返回：AssembledContext + scope_id（存储在 Adapter session state）
  }
}

{
  name: "spawn_task",
  description: "Spawn a sub-task within the current scope.",
  inputSchema: {
    task_description: z.string(),
    assigned_worker:  z.string().optional()
  },
  handler: async ({ task_description, assigned_worker }) => {
    // Adapter 内部：生成 entity_id，读取 session state 中的 predecessor_hash
    // 内部：POST /v1/scopes/{scope_id}/events { event_type: "task_spawned", ... }
    // 返回：新 entity_id + 更新后的 AssembledContext
  }
}

{
  name: "complete_task",
  description: "Mark a previously spawned task as completed with its result.",
  inputSchema: {
    task_entity_id: z.string(),  // 由 spawn_task 返回的 entity_id
    result:         z.unknown()  // 业务结果，写入 payload
  },
  handler: async ({ task_entity_id, result }) => {
    // 内部：POST /v1/scopes/{id}/events { event_type: "memory_updated", status: "completed", ... }
    // 返回：更新后的 AssembledContext（若 scope_closed 则 context=null）
  }
}

{
  name: "report_conflict",
  description: "Report a conflict detected during task execution.",
  inputSchema: {
    conflicting_entity_id: z.string(),
    conflict_details:      z.string()
  },
  handler: async ({ conflicting_entity_id, conflict_details }) => {
    // 内部：POST /v1/scopes/{id}/events { event_type: "conflict_detected", ... }
    // 返回：更新后的 AssembledContext + 冲突解决指引
  }
}

{
  name: "get_scope_context",
  description: "Retrieve the current execution context for the active scope.",
  inputSchema: {},
  handler: async () => {
    // 内部：GET /v1/scopes/{scope_id}
    // 返回：当前 AssembledContext
  }
}
```

### Adapter Session State 管理

Adapter 在 MCP 会话生命周期内维护：
- `active_scope_id`：当前 Scope 的 ID
- `entity_predecessor_map`：`Map<entity_id, predecessor_hash>`，自动追踪每个实体的版本链
- OCC 冲突自动重试（基于 Gateway 返回的 `version_hash` 更新 predecessor_hash 后重试一次）

LLM 完全不感知 `predecessor_hash` 和 `version_hash`——这是系统不变量，由 Adapter 内部维护，不暴露到认知界面。

### 为何不是 1:1 映射

LLM 在生产环境中无法稳定维护"数据库状态机"心智模型：
- `predecessor_hash` 需要准确追踪上一次写入的哈希值，多步骤后极易丢失
- OCC 冲突返回码（409）需要 LLM 实现补偿逻辑，超出工具调用的自然认知边界
- 语义工具（`spawn_task`、`complete_task`）与 LLM 的"做什么"输出自然对齐，1:1 HTTP 工具与底层存储原语对齐，后者对 LLM 是错误的抽象层级

---

## Phase 3：多 Agent 协调层（延期，不阻塞 Phase 1/2）

多个异构 Agent（Claude、Codex、Pi、第三方 A2A 系统）并发接入时，需要基于能力（skills）的任务路由、Agent 注册、以及跨协议（MCP/A2A）统一接入。

**完整规范见 ADR 42。** 本 ADR 不重复该内容。

---

## 拒绝的方案

### 直接 iii-sdk 函数调用

- iii-engine 是推送型异步总线，不原生支持同步请求-响应
- 外部 Agent（Claude Code）不是 TypeScript/Node 进程，无法直接调用 iii-sdk
- 将 Agent 注册为 Worker 会破坏 Agent 与 Worker 的角色边界（ADR 05）

### WebSocket 流式连接

- 增加有状态连接管理复杂度
- Phase 1 任务规模不需要流式推送
- 可在 Phase 3 作为性能优化补充

---

## 拒绝的方案（补充）

### MCP 1:1 HTTP 映射（`scope_event` 单工具方案）

- LLM 需要手动维护 `predecessor_hash` 追踪和 OCC 补偿逻辑，认知负担超过工具调用的可靠性阈值
- 生产环境实测：LLM 在多步交互后 `predecessor_hash` 错误率高，导致频繁 400 + 无法进行的重试循环（"死锁"式卡死）
- 语义工具按"做什么"设计，与 LLM 自然输出对齐，是正确的认知抽象层级

---

## 后果

- 任何能发 HTTP 请求的 Agent（CLI、Python、TypeScript、Bash）均可零配置接入
- 整个 Agent-Graph 执行循环闭环：外部意图 → Scope 创建 → 上下文组装 → Agent 推理 → 事件写入 → 循环
- Gateway 内联看门狗 SQL，scope_closed 在同一请求路径内原子触发，零额外 RPC
- Zod/Regex 铁闸在数据库层之前拦截格式非法输入，400 错误定位即时清晰
- MCP Adapter 按事件类型拆分的认知转译工具：LLM 不感知 predecessor_hash、version_hash、OCC 冲突补偿逻辑
- 系统 Phase 1 不依赖任何特定 Agent 框架（Pi、Claude Code、自定义均等价）

---

## 关联 ADR

- **ADR 04** — ZERO_HASH 偏函数唯一索引：Gateway 接受 `predecessor_hash = ZERO_HASH` 作为 plan_created 根节点
- **ADR 05** — Worker 权限隔离：Gateway 使用业务账户（SELECT/INSERT + 基础设施事件直写），无 DDL 权限
- **ADR 12** — 法定事件枚举：Gateway Zod 拒绝非枚举事件类型，返回 400
- **ADR 13** — Knapsack Slicing：每次 event POST 后重新切片，context 即时返回
- **ADR 18** — 收敛节点写回：`_meta.convergence_gate` 由 ConflictResolverWorker 写入，Gateway 不剥离（MCP Adapter session state 管理冲突实体的 predecessor_hash 更新）
- **ADR 19** — 拓扑收敛看门狗：Gateway 内联看门狗 SQL，`scope_closed` 时 context 返回 null，通知 Agent Scope 已终止
- **ADR 42** — 多 Agent 协调层：AgentCard 注册、基于 skills 的任务路由、MCP Server 层、跨协议（MCP/A2A）接入
