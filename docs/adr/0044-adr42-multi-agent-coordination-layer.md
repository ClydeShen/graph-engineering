# ADR 42｜多 Agent 协调层：AgentCard 注册、技能路由、跨协议接入

status: accepted  
日期: 2026-06-05

---

## 上下文

ADR 24 定义了单 Agent 通过 HTTP Gateway 接入系统的基线协议。随着系统演进，多个异构 Agent 需要并发接入：

- **LLM Agent**（Claude、Codex、Pi）：通过 MCP 协议接入，不原生支持 A2A
- **第三方 A2A 系统**：原生支持 Google A2A 协议（JSON-RPC + AgentCard）
- **内部 Worker**：通过 iii WebSocket 接入（ADR 29 Worker 定义）

三类参与者需要在同一因果账本中协作执行任务，而系统此前没有：

1. **Agent 能力注册机制**：系统不知道哪个 Agent 能处理什么类型的任务
2. **基于能力的任务路由**：`task_spawned` 事件无法指定执行者，FrontierScheduler 无匹配依据
3. **跨协议统一接入**：MCP 和 A2A 协议差异大，没有统一的语义桥接层

---

## 决策

### D-1：方式 B——技能路由，禁止显式 Agent 指派

`task_spawned` payload 中的 `required_skills[]` 是唯一允许的执行者声明方式。

**禁止的字段**：`assigned_agent_id`、`preferred_agent`、任何显式指向特定 Agent 实例的字段。

FrontierScheduler 查询 `agent_registry`，按 skill 集合匹配，通过 SKIP LOCKED 原子派发。派单方不得、也无法控制具体执行者。

**原因**：显式指派破坏物理平等性（多实例负载均衡失效）、阻断 D-10 OLAP cron 的跨 Agent 拓扑发现、引入中央协调者依赖。

---

### D-2：AgentCard 通用化——统一注册，统一匹配

系统内所有参与者在 `agent_registry` 表中注册 AgentCard：

| 参与者类型 | 协议 | 示例 |
|---|---|---|
| 内部 Worker | iii WebSocket | EpisodicMemoryWorker、FrontierScheduler |
| LLM Agent | MCP | Claude、Codex、Pi |
| 第三方系统 | A2A | 外部 A2A 节点 |

AgentCard 结构（兼容 Google A2A 规范）：

```json
{
  "agent_id": "uuid-v4",
  "name": "Codex",
  "description": "Code generation and review",
  "skills": ["typescript", "code-review", "sql-migration"],
  "protocol": "mcp",
  "endpoint": "https://...",
  "version": "1.0"
}
```

graph-os 自身的 AgentCard 暴露于 `GET /.well-known/agent-card.json`（A2A 协议规范要求）：

```json
{
  "name": "graph-os",
  "description": "Causal execution graph runtime",
  "skills": ["task-routing", "context-assembly", "memory-retrieval", "pattern-discovery"],
  "protocols": ["mcp", "a2a"],
  "endpoints": {
    "mcp":        "/mcp/messages",
    "a2a":        "/a2a/rpc",
    "agent_card": "/.well-known/agent-card.json"
  }
}
```

---

### D-3：三协议并存

```
外部 LLM Agent (Claude/Codex/Pi)
  └─ MCP (SSE + HTTP)  ──→  /mcp/sse
                             /mcp/messages

第三方 A2A 系统
  └─ A2A (JSON-RPC)   ──→  /a2a/rpc
                             /.well-known/agent-card.json

内部 Worker
  └─ iii WebSocket    ──→  (现有，ADR 09)
```

三种协议统一写入同一因果账本，共享 ADR 12 五种规范事件类型。协议层是接入适配器，不影响账本语义。

---

### D-4：Pull 为主，SSE Push 为可选延迟优化

**主模型（Pull）**：

```
Agent → claim_next_task(skills=[...])
      → SKIP LOCKED 原子抢占（ADR 32 D-4）
      → 返回任务 | 空
```

**优化模型（Push，可选）**：

ADR 09 Pulse-Fetch 模式向外延伸：

```
PostgreSQL NOTIFY
  → graph-os MCP SSE 推送信号
  → Agent 收到信号
  → 立即 claim_next_task()
```

Push 信号不携带任务内容，仅作触发。SKIP LOCKED 保证多 Agent 实例抢占原子性。

---

### D-5：账本即协调者，无中央守护进程

状态写入账本（PostgreSQL），不写入进程内存。

**执行方崩溃处理流程**：

1. 执行方中途死亡（token 耗尽、进程崩溃）
2. 已写入的 `memory_updated` 事件留存于账本，不随进程消失
3. Watchdog（ADR 19）检测心跳超时的 claimed 任务，重新投队
4. 新 executor 通过 ReadOnlyGraphHandle（ADR 35 D-8）组装上下文，包含前任的部分进度
5. 新 executor 从上次写入点继续，不从零开始

---

### D-6：循环依赖是设计错误，不是运行时可恢复场景

若 Agent A 等待 Agent B 的结果，B 执行途中将任务派回给 A（A 此时被阻塞无法 claim），形成死锁。

**处理层级**：

1. **调度层**：FrontierScheduler 在 dispatch 时检测 `spawned_by` 链，若存在循环依赖则拒绝派发，返回 `ERR_CYCLE_DETECTED`
2. **兜底**：Task TTL + Watchdog（ADR 19）超时后标记 failed，spawning agent 处理 error 状态

**设计约束**：Agent 间任务依赖必须形成有向无环图（DAG）。

---

## 数据库 Schema

### `agent_registry` 表

```sql
CREATE TABLE agent_registry (
  agent_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  skills          TEXT[] NOT NULL DEFAULT '{}',
  protocol        TEXT NOT NULL CHECK (protocol IN ('mcp', 'a2a', 'iii')),
  endpoint        TEXT,
  agent_card_json JSONB NOT NULL,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX idx_agent_registry_skills ON agent_registry USING GIN (skills);
CREATE INDEX idx_agent_registry_status ON agent_registry (status);
```

---

## MCP Server 层接口

在 HTTP Gateway（ADR 24）之上叠加 SSE transport，暴露以下 MCP tools：

### Agent 注册与发现

```
POST /v1/agents/register
  Body:    AgentCard (JSON)
  Response: { "agent_id": string }

GET  /.well-known/agent-card.json
  Response: graph-os 自身的 AgentCard
```

### 任务协调

```
spawn_subtask(required_skills: string[], payload: object)
  → 写入 task_spawned 事件（ADR 12）
  → 返回 { task_id: string }
  → 非阻塞，立即返回

claim_next_task(skills: string[])
  → SKIP LOCKED 原子抢占（ADR 32 D-4）
  → 返回 { task: Task } | { task: null }

get_task_status(task_id: string)
  → 查询账本当前状态
  → 返回 { status: "pending" | "claimed" | "completed" | "failed" }

complete_task(task_id: string, result: object)
  → 写入 memory_updated 事件（ADR 12）

wait_all_tasks(task_ids: string[], timeout_s?: number)
  → 服务端 LISTEN/NOTIFY 聚合
  → 全部完成后一次性返回（避免 N 轮 polling）
  → 超时返回部分结果 + 未完成列表

query_context(scope_id: string)
  → 调用 ReadOnlyGraphHandle（ADR 35 D-8）
  → 返回因果链上下文摘要
```

### MCP SSE 端点

```
GET  /mcp/sse       — 事件推送（Pulse-Fetch 外延，ADR 09）
POST /mcp/messages  — MCP tool 调用入口
```

---

## FrontierScheduler 扩展

ADR 31 FrontierScheduler 新增 skill 匹配逻辑：

```
dispatch(task):
  1. 读取 task.payload.required_skills
  2. 查询 agent_registry WHERE skills && required_skills AND status = 'active'
  3. 若无匹配 Agent → task 留队，等待符合条件的 Agent 注册/上线
  4. 若检测到循环依赖（spawned_by 链分析）→ 返回 ERR_CYCLE_DETECTED
  5. SKIP LOCKED 原子派发给第一个可用匹配 Agent
```

FrontierScheduler 核心逻辑不变（ADR 31），仅扩展匹配条件。

---

## 执行流程示例（Claude → Codex）

```
Claude (MCP)
  → spawn_subtask(required_skills=["typescript"], payload={...})
  → 立即返回 task_id_A

graph-os Gateway
  → task_spawned 事件写入账本
  → FrontierScheduler: agent_registry 匹配 "typescript" → Codex
  → PostgreSQL NOTIFY → MCP SSE → Codex 收到信号

Codex (MCP)
  → claim_next_task(skills=["typescript"])  ← SKIP LOCKED
  → 执行任务
  → complete_task(task_id_A, result)        ← memory_updated 写入账本

Claude
  → get_task_status(task_id_A)             ← 查账本，不查 Codex
  → { status: "completed" }
```

---

## 拒绝的方案

### 显式 Agent 指派（方式 A）

允许 `task_spawned.payload.assigned_agent_id` 指定执行者。

**拒绝原因**：
- 破坏物理平等性：单一 Agent 实例成为瓶颈，多实例负载均衡失效
- 阻断 D-10 发现：指定执行者后，OLAP cron 看到的拓扑结构是人工约束的，不是自然涌现的
- 引入中央协调者：由谁来决定"哪个 Codex 实例"成为新的中央决策点
- 历史上的教训：显式路由在分布式系统中总是成为耦合点

### A2A 作为内部协议

对内部 Worker 也使用 A2A JSON-RPC。

**拒绝原因**：
- 内部 Worker 已有 iii WebSocket（ADR 09），成熟稳定，无迁移收益
- A2A 协议开销（JSON-RPC + AgentCard 解析）对高频内部调用无必要
- 三协议并存是协议边界自然分工，不是妥协

---

## 后果

- 任何异构 Agent 均可通过注册 AgentCard 接入系统，无需修改核心 ADR
- FrontierScheduler 的 skill 匹配是系统唯一的任务分发决策点，可观测、可审计
- Agent 崩溃不丢任务状态——账本是唯一真相来源，Watchdog 保证最终完成
- MCP Server 层在 HTTP Gateway 之上叠加，ADR 24 原有接口不变

---

## 关联 ADR

- **ADR 09** — Pulse-Fetch：Push 信号的底层 NOTIFY 机制
- **ADR 12** — 五种规范事件：MCP tools 写入的事件类型
- **ADR 19** — Watchdog：崩溃后任务重入队机制
- **ADR 24** — HTTP Gateway：MCP Server 层叠加于其上
- **ADR 29** — Worker/Tool/Knowledge/Connector：内部 Worker 的 AgentCard 注册遵循此边界定义
- **ADR 31** — FrontierScheduler：skill 匹配扩展点
- **ADR 32** — SKIP LOCKED：claim_next_task 的原子抢占原语
- **ADR 34** — spawned_by hyperedge：DAG 循环检测的数据来源
- **ADR 35** — D-8 ReadOnlyGraphHandle：query_context 和崩溃接续的上下文组装
