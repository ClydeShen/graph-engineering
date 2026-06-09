# 标本项目深度对比分析
**日期**: 2026-06-05  
**标本路径**: `D:\Repo\specimens`

---

## 标本概览

| 标本 | 语言 | 成熟度 | 与本项目的关系 |
|------|------|--------|----------------|
| **agentmemory** | TypeScript | 生产级（v0.15+） | 最近邻：同一 iii-engine 平台，记忆系统方向对齐 |
| **iii** | Rust + TypeScript SDK | 平台级 | 我们的底层基础设施（事件总线）的源码 |
| **hermes-agent** | Python | 生产级（Claude Code 内核） | 目标用户视角：我们要服务的 Agent 长什么样 |

---

## 维度一：Worker 注册与事件订阅机制

### iii 标准模式（标本）

```typescript
// iii SDK — 标准 Worker 注册
const iii = registerWorker('ws://localhost:49134', { otel: { ... } })

sdk.registerFunction("event::session::started", async (data) => { ... })
sdk.registerTrigger({
  type: "durable:subscriber",
  function_id: "event::session::started",
  config: { topic: "agentmemory.session.started" }
})
```

**iii Engine 内部（Rust）：** WebSocket 连接的 Worker → `FunctionsRegistry`（`DashMap<String, Function>`）→ `TriggerRegistry` → 事件到达时 dispatch。

### 我们的实现

没有使用 iii SDK。Workers 直接由 PostgreSQL `pg-listen` 驱动，手写路由逻辑，绕开了 iii-engine 的整个 WebSocket Worker 注册体系。

| 对比项 | agentmemory / iii 标准 | 我们的实现 | 评价 |
|--------|----------------------|-----------|------|
| Worker 注册 | `sdk.registerFunction(id, handler)` | PostgreSQL Pulse-Fetch + 手写路由 | **我们绕开了 SDK** |
| 触发机制 | `durable:subscriber` / `http` trigger | `pg-listen` → `PgQueueAdapter` | 等价但自制 |
| 重连/HWM | SDK 内置（maxRetries, reconnectionConfig） | 手写 Watchdog + HWM 逻辑 | 重造了轮子 |
| 函数注册表 | `DashMap<String, Function>`（Rust） | 无集中注册表，Workers 各自监听 | 缺少服务发现层 |

---

## 维度二：记忆系统对比

### agentmemory 的核心模式

```
crystallize → lesson event chain (实时流式):
  mem::crystallize (LLM digest → Crystal)
    └→ sdk.trigger("mem::lesson-save", { content: lesson })
         └→ fingerprintId dedup → reinforceLesson (confidence += 0.1×(1-c))

mem::reflect:
  BFS 度数排序 ConceptCluster → LLM → Insight → reinforceInsight

dedup: DedupMap
  sha256(sessionId:toolName:input[:500])，TTL=5min
```

### 我们的实现

```
MemorySynthesizer (2AM cron / scope_closed + ≥20 episodic) — 批量触发
BM25+HNSW RRF: rrf_score×0.6 + quality×0.3 + recency×0.1
Ebbinghaus decay: reinforcement_count=0 AND last_used < 90d → superseded
```

| 对比项 | agentmemory | 我们 | 差距 |
|--------|-------------|------|------|
| 记忆提炼链 | `crystallize → lesson` 实时事件链 | MemorySynthesizer 批处理 | **agentmemory 实时，我们批量** |
| 置信度演化 | `confidence += 0.1×(1-confidence)` 渐进上限 | Ebbinghaus reinforcement_count | 缺少渐进强化 |
| Dedup | in-memory TTL DedupMap（5min） | PostgreSQL UNIQUE constraint | 我们更持久，agentmemory 实时性更好 |
| 图聚类 | BFS ConceptCluster | union-find + WL kernel | **我们拓扑更精确** |
| 自动强化触发 | `sdk.trigger` 自动链 | 无自动链 | **缺失** |

---

## 维度三：MCP 暴露方式

### agentmemory 模式
- stdio transport，独立 npm 包
- `npx @agentmemory/mcp` 一键运行
- `agentmemory connect claude-code` → 自动写入 `~/.claude.json` mcpServers

### 我们的实现
- Streamable HTTP transport（2025-11-25 spec），Gateway 内嵌
- 需要先启动 HTTP Gateway + 知道端口
- 无 `connect` CLI

| 对比项 | agentmemory | 我们 | 评价 |
|--------|-------------|------|------|
| Transport | stdio | Streamable HTTP | 我们用更新协议，但需要 HTTP 服务 |
| 接入方式 | `npx` 一键 | 手配端口 | **缺少 connect CLI** |
| 工具数量 | 20+ memory tools | 7 任务调度工具 | 定位不同，各有侧重 |

---

## 维度四：hermes-agent（目标用户视角）

hermes-agent 揭示了消费我们系统的 Agent 实际需要什么：

```python
threshold_percent: float = 0.75   # 75% token 触发压缩
protect_first_n: int = 3
protect_last_n: int = 6
# 每轮: 模型调用 → tool dispatch → should_compress() → post-turn hooks
```

| hermes-agent 的需求 | 我们提供 | 缺口 |
|--------------------|---------|------|
| 会话内上下文压缩 | Knapsack（跨会话图投影） | hermes 是会话内，我们是跨会话 |
| 轮次预算（IterationBudget） | 无 | 缺失 |
| 每轮 post-turn hooks | scope_closed（整个 scope 才触发） | 粒度粗 |
| 错误分类/重试链 | OCC 仲裁 | hermes 有完整 retry/fallback 链 |

---

## 总体差距评分

```
维度                  对比agentmemory   对比iii    对比hermes   优先级
────────────────────────────────────────────────────────────────────
MCP 接入方式（connect）    ⚠️ 落后          N/A       ⚠️ 落后       P1（Phase 4）
Worker SDK 接入           ⚠️ 绕过iii SDK   ⚠️ 偏离    N/A          P2
实时事件传播链             ⚠️ 缺失          N/A       N/A          P2
记忆强化自动触发           ⚠️ 缺失          N/A       N/A          P3
拓扑精确性（WL kernel）    ✅ 超越          N/A       N/A          已完成
OCC 并发控制              ✅ 超越          N/A       N/A          已完成
跨域模式发现              ✅ 独有          N/A       N/A          已完成
```

---

## Phase 4 直接启示

1. **MCP `connect` CLI**：`graph-runtime connect claude-code` → 自动写 `~/.claude.json` mcpServers，仿照 agentmemory connect 模式。

2. **实时事件传播链**：`complete_task` → 自动 trigger MemorySynthesizer 单条合成，不等批处理。

3. **iii SDK 接入路径**：PgQueueAdapter 是我们自制的 iii-engine 替代。Phase 4 若要接入真实 iii-engine 实例，需要把它替换为 `sdk.registerFunction` + `durable:subscriber` 模式。

---

## ⚠️ 待讨论：灾难性偏离

用户在 2026-06-05 会话末尾发现了"灾难性的偏离"，尚未说明具体内容。下一个 session 需要优先讨论。

**背景**: 偏离可能与以下任一方向相关：
- 我们没有使用 iii SDK（`registerWorker` / `durable:subscriber`），而是自制了 pg-listen 路由层
- iii-engine 的 Workers 是通过 WebSocket 注册到引擎的独立进程，我们的 Workers 是 TypeScript 内嵌模块
- hermes-agent 的执行模型（每轮调用）与我们的模型（事件驱动批处理）存在根本性差异
