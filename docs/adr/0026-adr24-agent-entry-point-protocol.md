# ADR 24｜Agent 接入协议：HTTP Gateway

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

### 认证与安全（Phase 1 最小实现）

- 本地部署默认无认证（监听 127.0.0.1）
- 生产部署通过 `iii-config.yaml` 配置 `gateway.api_key` Bearer Token
- Worker 数据库权限与 ADR 05 保持一致：Gateway 进程使用业务账户（SELECT/INSERT only）

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

## Phase 2：MCP Adapter（延期，不阻塞 Phase 1）

MCP Server 作为 HTTP Gateway 上层的薄包装层，将 MCP Tool Call 转译为 Gateway HTTP 请求：

```typescript
// MCP Tool 定义（延期实现）
{ name: "scope_start",  handler: (args) => POST /v1/scopes }
{ name: "scope_event",  handler: (args) => POST /v1/scopes/{id}/events }
{ name: "scope_query",  handler: (args) => GET  /v1/scopes/{id} }
```

提供原生 Claude Code MCP 工具体验，但底层仍走 HTTP Gateway，无需维护两套逻辑。

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

## 后果

- 任何能发 HTTP 请求的 Agent（CLI、Python、TypeScript、Bash）均可零配置接入
- 整个 Agent-Graph 执行循环闭环：外部意图 → Scope 创建 → 上下文组装 → Agent 推理 → 事件写入 → 循环
- MCP Adapter 作为 Phase 2 薄层，不需重写业务逻辑
- 系统 Phase 1 不依赖任何特定 Agent 框架（Pi、Claude Code、自定义均等价）

---

## 关联 ADR

- **ADR 05** — Worker 权限隔离：Gateway 使用业务账户（SELECT/INSERT），无 DDL 权限
- **ADR 12** — 法定事件枚举：Gateway 拒绝非枚举事件类型，返回 400
- **ADR 13** — Knapsack Slicing：每次 event POST 后重新切片，context 即时返回
- **ADR 19** — 拓扑收敛看门狗：`scope_closed` 时 context 返回 null，通知 Agent Scope 已终止
