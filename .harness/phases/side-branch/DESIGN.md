# MCP/A2A 桥接层架构设计

**状态:** 讨论完成，待输出 ADR 草案  
**日期:** 2026-06-05  
**影响:** Phase 3 范围扩展，需包含本文所列新组件

---

## 一、背景与范围

Phase 3 原定目标为 CrossScopePatternDiscoveryWorker。本设计扩展其范围，增加跨协议 Agent 衔接层（MCP Server + AgentCard 路由），使外部 Agent（Claude、Codex、Pi 等）能以标准协议接入 graph-os 的因果账本。

本文不改变 ADR 01–37 任何已锁定决策。所有新增组件在现有事件模型和账本语义之上叠加，不引入新的事件类型。

---

## 二、锁定决策

### D-1：方式 B（技能路由，禁止显式指派）

`task_spawned` payload 中只允许声明 `required_skills[]`，禁止声明 `assigned_agent_id`。

所有任务分发主权交由 FrontierScheduler 集中裁决。FrontierScheduler 查询 `agent_registry`，按 skill 匹配可用 executor，通过 SKIP LOCKED 原子性派发。

**违禁字段:** `assigned_agent_id`、`preferred_agent`、任何显式指向特定 Agent 实例的字段。

**原因:** 显式指派破坏物理平等性，阻止 D-10 OLAP cron 发现跨 Agent 的拓扑规律，引入中央协调者反模式。

---

### D-2：AgentCard 通用化

系统内所有参与者——内部 Worker（Discovery、Frontier、Episodic 等）和外部 Agent（Claude、Codex、Pi、第三方 A2A 系统）——统一在 `agent_registry` 表中注册 AgentCard，声明自身能接受的 skills。

AgentCard 最小结构（兼容 A2A 协议规范）：

```json
{
  "agent_id": "uuid-v4",
  "name": "Codex",
  "description": "Code generation and review agent",
  "skills": ["typescript", "code-review", "sql-migration"],
  "protocol": "mcp",
  "endpoint": "https://...",
  "version": "1.0"
}
```

---

### D-3：三协议并存

| 协议 | 适用对象 | 传输 |
|---|---|---|
| MCP (Model Context Protocol) | Claude、Codex、Pi 等 LLM Agent | SSE + HTTP |
| A2A (Agent2Agent) | 原生支持 A2A 的第三方系统 | JSON-RPC |
| iii WebSocket | 内部 Worker 进程 | WebSocket (现有) |

三种协议统一写入同一因果账本，共享相同的事件类型（ADR 12 五种规范事件）。

---

### D-4：Pull 为主，SSE Push 为可选优化

外部 Agent 的任务获取主模型为 Pull：

```
Agent → claim_next_task(skills=[...]) → SKIP LOCKED → 返回任务或空
```

SSE Push 为延迟优化（ADR 09 Pulse-Fetch 向外延伸）：

```
PostgreSQL NOTIFY → graph-os MCP SSE → Agent 收到信号 → 立即 claim_next_task()
```

Push 信号不携带任务内容，仅作触发。Agent 仍需主动 claim，SKIP LOCKED 保证原子性。

---

### D-5：账本即协调者，无中央守护进程

状态写入账本（PostgreSQL），不写入进程内存。

- 执行方崩溃（token 耗尽、进程死亡）不丢失状态——已写入的 `memory_updated` 事件不随进程消失
- Watchdog（ADR 19）检测心跳超时的 claimed 任务，重新投队
- 新 executor 通过 ReadOnlyGraphHandle（ADR 35 D-8）组装上下文，从上次写入点继续
- 进程崩溃 ≠ 状态丢失

**禁止的设计模式:** 全局唯一守护进程、中央状态服务器、进程内任务状态缓存。

---

### D-6：循环依赖是设计错误

若 Agent A 等待 Agent B 的结果，而 B 执行途中试图将任务派回给 A（A 此时被阻塞无法 claim），形成死锁。

该情况不是运行时可恢复的场景。

**处理方式:**
1. FrontierScheduler 在 dispatch 时检测 `spawned_by` 链，拒绝向正在等待某任务的 Agent 派发其依赖任务
2. Task TTL + Watchdog 作为兜底，超时后标记 failed，由 spawning agent 处理 error 状态

**设计约束:** Agent 之间的任务依赖必须形成有向无环图（DAG）。

---

### D-7：Claude 内部子 Agent 调度不由 graph-os 管理

Claude 自行管理其子 Agent（subagent）的并行调度和状态。graph-os 只看到 Claude 发出的 `spawn_subtask` 调用，不感知 Claude 内部如何分配这些任务给其子 session。

Fan-out 模式（Claude 并行派发多个子任务）天然映射到 ADR 34 `spawned_by` 拓扑：

```
scope_root (Claude)
  ├── task_id_1 → memory_updated (executor A 写)
  ├── task_id_2 → memory_updated (executor B 写)
  └── task_id_3 → memory_updated (executor C 写)
```

Fan-in（等待全部完成）建议通过服务端聚合工具实现：

```
wait_all_tasks(task_ids=[id_1, id_2, id_3], timeout_s=300)
```

graph-os 内部 LISTEN/NOTIFY 监听账本事件，全部完成后一次性返回，避免 Claude 做 N 轮轮询。

---

## 三、新增组件（Phase 3 范围）

### 3.1 MCP Server 层

包装 HTTP Gateway（ADR 24），暴露 SSE transport 和以下 MCP tools：

| Tool | 语义 |
|---|---|
| `spawn_subtask(required_skills, payload)` | 写 task_spawned 事件，返回 task_id |
| `claim_next_task(skills)` | SKIP LOCKED 原子抢占，返回任务或空 |
| `get_task_status(task_id)` | 查询账本，返回任务状态 |
| `complete_task(task_id, result)` | 写 memory_updated 事件，标记完成 |
| `wait_all_tasks(task_ids, timeout_s)` | 服务端聚合，全部完成后返回 |
| `register_agent(agent_card)` | 写入 agent_registry |
| `query_context(scope_id)` | 读取因果链上下文摘要 |

### 3.2 `agent_registry` 表 Schema（草案）

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
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX idx_agent_registry_skills ON agent_registry USING GIN (skills);
```

### 3.3 新端点

| 端点 | 协议 | 说明 |
|---|---|---|
| `GET /.well-known/agent-card.json` | HTTP | graph-os 自身的 A2A AgentCard |
| `POST /v1/agents/register` | HTTP | 注册外部 Agent |
| `GET /mcp/sse` | SSE | MCP 事件推送（Pulse-Fetch 外延） |
| `POST /mcp/messages` | HTTP | MCP tool 调用入口 |

### 3.4 graph-os 自身 AgentCard（草案）

```json
{
  "name": "graph-os",
  "description": "Causal execution graph runtime. Routes tasks, assembles context, persists cognitive state.",
  "skills": ["task-routing", "context-assembly", "memory-retrieval", "pattern-discovery"],
  "protocols": ["mcp", "a2a"],
  "endpoints": {
    "mcp": "/mcp/messages",
    "a2a": "/a2a/rpc",
    "agent_card": "/.well-known/agent-card.json"
  }
}
```

---

## 四、不改变的 ADR

以下 ADR 在本设计中保持不变：

- **ADR 12**: 5 种规范事件类型——A2A/MCP 任务路由不引入新事件
- **ADR 20**: PostgreSQL 四层记忆架构——agentmemory 接 Claude，不接 graph-os
- **ADR 24**: HTTP Gateway——MCP Server 在其之上叠加，不替换
- **ADR 31**: FrontierScheduler——扩展 skill 匹配逻辑，核心不变
- **ADR 34**: spawned_by hyperedge——天然支持递归任务拓扑
- **ADR 35**: D-8 ReadOnlyGraphHandle——executor 接续时的上下文组装机制

---

## 五、待决问题（Phase 3 规划前需确认）

1. **ADR 编号**: 新 MCP Server 层是新增 ADR 38，还是扩展 ADR 24 + ADR 31？
2. **skills 粒度标准**: 粗粒度（`"code"`）vs 细粒度（`"typescript,sql-migration"`）的路由精确性权衡
3. **FrontierScheduler 循环依赖检测**: 实现复杂度评估——是 Phase 3 必须还是 Phase 4 优化？
4. **wait_all_tasks 超时语义**: 部分完成时返回什么？全部超时是 error 还是 partial result？
