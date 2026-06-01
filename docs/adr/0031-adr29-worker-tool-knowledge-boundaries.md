# ADR 29｜Worker / Tool / Knowledge / Connector 四元边界定义

status: accepted  
日期: 2026-06-01

---

## 上下文

系统的最终形态是一个通用 Agent Runtime：Claude Code、Memory System、Gmail Worker、Browser Worker 等所有执行单元，都以统一的方式接入 Execution Graph，通过多种交互形态与用户互动，并兼容主流的 MCP connector、Skill、Plugin。

现有 ADR 01–28 定义了图存储、控制流、上下文组装、记忆层、Worker 生命周期（ADR 27）、调度规约（ADR 28）和接入协议（ADR 24），但**没有任何 ADR 正式定义以下四个核心抽象的边界**：

1. **Worker** — 执行单元的最小接口契约是什么？内部 Worker 与外部 Agent 如何统一？
2. **Tool** — Tool 与 Worker 的边界在哪里？MCP Server 是 Tool 还是 Worker？
3. **Knowledge** — 外部 Plugin/Skill/Schema 以什么形式存在于图中？
4. **Connector** — 外部系统（Claude Code、Gmail、Browser）如何接入，谁负责适配？

这四个边界的缺失会导致 Phase 1 实现时各 Worker 自行决定接入方式，破坏系统的统一性。

参考实现：agentmemory（rohitg00/agentmemory，基于 iii-engine，20k+ stars）在同类问题上的实践——Tool 是 Worker 的无状态名片，Connector 是适配器，状态层是知识的物理存储——其设计边界直接验证了本 ADR 的核心决策方向。

---

## 决策

确立四元抽象边界。所有接入系统的组件必须归属且仅归属这四类之一。

---

### 一、Worker（内部执行单元）

**定义**：在 iii-engine 内注册、有 Execution Graph 写权限（`INSERT` append-only）、遵循 ADR 27 四阶段生命周期状态机的执行单元。

**注册接口（最小契约）**：

```typescript
sdk.registerFunction(
  "graph::{domain}::{action}",      // 命名规范：graph:: 前缀 + 域名 + 动作
  async (data: WorkerInput) => {
    // Processing 阶段：纯内存计算，禁止持久化 (ADR 27)
    // Writing 阶段：单次 INSERT 到 execution_event_log
    // 返回：{ version_hash, status: "won" | "demoted" }
  }
);
```

**写权限规范**：

| 操作 | Worker 数据库账户 | 控制面账户 |
|------|-----------------|-----------|
| SELECT（读图） | ✅ | ✅ |
| INSERT（写事件） | ✅（`memory_updated`、`task_spawned`、`conflict_detected`） | ✅（`scope_closed`、`context_oom_throttled`） |
| DDL | ❌ | ✅（独占连接池，ADR 05） |

**命名规范**：

```
graph::conflict::resolve      — 冲突解决 Worker
graph::template::propose      — 模板提炼 Worker
graph::reflect::episodic      — 情节记忆反思 Worker
graph::search::hybrid         — 混合检索 Worker（只读，无写权限）
```

**内部 Worker 现有清单（命名迁移）**：

| 原称 | 标准命名 |
|------|---------|
| ConflictResolverWorker | `graph::conflict::resolve` |
| TemplateProposalWorker | `graph::template::propose` |
| ArchiveWorker | `graph::scope::archive` |
| SubScopeResultWorker | `graph::subscope::merge` |

---

### 二、Tool（无状态外部接口）

**定义**：无 Execution Graph 写权限、无生命周期状态机、单次调用返回结果的执行单元。Tool 是 Worker 的**无状态名片**——它定义调用接口，内部调用 Worker 完成实际执行。

**两种形态**：

#### 形态 A：MCP Tool（外部 Agent 调用）

```typescript
// tools-registry.ts
export const CORE_TOOLS: McpToolDef[] = [
  {
    name: "spawn_task",           // LLM 可自然理解的语义动词
    description: "...",
    inputSchema: { ... },
    // 实现：触发对应 Worker，等待返回
    handler: async (input) => sdk.trigger({ function_id: "graph::task::spawn", payload: input })
  }
];
```

MCP Tool 的接口设计原则（来自 ADR 24 Phase 2）：按**认知语义**设计（`spawn_task`、`complete_task`），不按底层存储原语设计（`post_event`）。LLM 不感知 `predecessor_hash`、`version_hash`、OCC 冲突补偿——这些由 MCP Adapter Session State 内部维护。

#### 形态 B：iii Utility Function（Worker 内部调用）

```typescript
sdk.registerFunction(
  "tool::tokenize",             // tool:: 前缀，区别于 graph:: Worker
  async (data: { text: string; model: string }) => {
    // 纯计算，无 DB 访问
    return { token_count: wasm_tokenize(data.text, data.model) };
  }
);

sdk.registerFunction(
  "tool::embed",
  async (data: { text: string }) => {
    // 调用 EmbeddingProvider（ADR 22），无图写权限
    return { embedding: await embeddingProvider.embed(data.text) };
  }
);
```

**Tool vs Worker 判断规则**：

| 特征 | Tool | Worker |
|------|------|--------|
| Graph 写权限 | ❌ | ✅ |
| ADR 27 生命周期状态机 | ❌ | ✅ |
| 可被 LLM/外部 Agent 直接调用 | ✅（MCP Tool） | ❌（经 Gateway 间接触发） |
| 可被内部 Worker 调用 | ✅（iii Utility） | ✅ |
| 命名前缀 | `tool::` | `graph::` |

**MCP Server 归类**：MCP Server 是 Tool 的**传输层封装**，不是独立抽象。MCP Server 暴露若干 MCP Tool，每个 Tool 内部触发对应 Worker。MCP Server = Tool 的 HTTP/SSE 宿主，不改变 Tool 的无状态特征。

---

### 三、Knowledge（图上的知识实体）

**定义**：Execution Graph 上 `entity_type = "knowledge"` 的 Entity，通过标准 `memory_updated` 事件写入（遵循 OCC + version chain，ADR 02/03），由多个 Worker 只读访问，代表系统中**缓慢变化的结构化事实**。

Knowledge 不是独立数据库——它是 Execution Graph 的一种节点类型，和 `task_spawned` 节点、`memory_updated` 节点共存于同一张表，统一受 append-only、version chain、scope 盐化哈希约束。

**Knowledge 的四种子类型**：

| 子类型 | `payload.knowledge_type` | 示例 |
|--------|--------------------------|------|
| `skill` | `"skill"` | Slash command 定义、SKILL.md 内容 |
| `schema` | `"schema"` | 外部 API 的 JSON Schema（Gmail API、Calendar API）|
| `plugin_doc` | `"plugin_doc"` | Plugin 的使用说明、配置规范 |
| `domain_fact` | `"domain_fact"` | 项目特定的领域事实、用户偏好 |

**写入规范**：

```typescript
// Knowledge 写入（任何有权 Worker 均可）
POST /v1/scopes/{scope_id}/events
{
  "event_type": "memory_updated",
  "entity_id": "<knowledge-entity-uuid>",    // 稳定 UUID，跨 Scope 复用
  "predecessor_hash": "<previous-version>",
  "payload": {
    "entity_type": "knowledge",
    "knowledge_type": "skill",
    "name": "recall",
    "content": "...",
    "status": "active"
  }
}
```

**与 ADR 20 四层记忆的关系**：

ADR 20 的 `procedural_memory`（模板图）是 Knowledge 的**物化视图**——高频使用的 Knowledge 经 TemplateProposalWorker 提炼后写入 `procedural_memory` 表，获得向量检索加速。Knowledge 节点是原始来源，`procedural_memory` 是查询优化。

**外部 Plugin/Skill/Connector 的接入路径**：

```
外部 Plugin 定义（YAML/JSON）
    → Connector 读取
    → 写入 Knowledge Entity（entity_type=knowledge, knowledge_type=plugin_doc）
    → 进入 Execution Graph version chain
    → 任何 Worker 在 Knapsack 切片时可读取
```

---

### 四、Connector（接入适配器）

**定义**：将外部 Agent/系统的生命周期事件映射到 iii 事件总线 topic 的适配器。Connector 本身不是 Worker，不写 Execution Graph——它只负责"翻译语言"。

**Connector 的职责边界**：

```
外部系统的语言                    系统内部的语言
─────────────────                ─────────────────
Claude Code session-start    →   agentmemory.session.started topic
Claude Code post-tool-use    →   agentmemory.observation topic
Gmail "new email received"   →   graph.event.external_trigger topic
Browser "page loaded"        →   graph.event.external_trigger topic
```

**两种实现形态**：

#### 形态 A：Hook Connector（生命周期注入）

将 Connector 逻辑嵌入外部 Agent 的 hook 机制（agentmemory 模式）：

```jsonc
// ~/.claude/settings.json（由 Connector 安装程序写入）
{
  "hooks": {
    "SessionStart": [{ "command": "node /path/to/session-start.mjs" }],
    "PostToolUse":  [{ "command": "node /path/to/post-tool-use.mjs" }],
    "Stop":         [{ "command": "node /path/to/stop.mjs" }]
  }
}
```

适用于：Claude Code、Codex、Cursor 等有 hook 机制的 Agent。

#### 形态 B：Gateway Connector（HTTP 长连接）

外部系统通过 HTTP Gateway（ADR 24）持续提交事件：

```typescript
// Gmail Connector 示例
const connector = new GatewayConnector({ gateway: "http://localhost:3000" });
gmail.on("new_email", async (email) => {
  await connector.submitEvent({
    event_type: "task_spawned",
    entity_id: generateUUID(),
    predecessor_hash: connector.currentTip(),
    payload: {
      entity_type: "external_trigger",
      source: "gmail",
      data: email
    }
  });
});
```

适用于：Gmail、Calendar、Browser、FileSystem 等无 hook 机制的系统。

**Connector 安装规范**：

每个 Connector 必须提供 `install()` 方法，负责：
1. 检测目标系统是否存在（`detect()`）
2. 写入配置文件或注册 webhook（幂等，支持 `--dry-run`）
3. 备份原有配置
4. 验证安装结果

---

### 五、外部 Agent 的定位（Claude Code 作为 Worker 的澄清）

"Claude Code 是 Worker"在宏观架构上成立，在实现层需要精确区分：

```
宏观视角（图的视角）：
  Claude Code 的每次 session、tool-use、decision
  都通过 Connector → Gateway → 写入 Execution Graph
  → 与内部 Worker 的事件共存于同一张表
  → Claude Code 的执行轨迹成为 Cognitive Trace 的一部分
  ∴ Claude Code 是图上的 "执行参与者"（participant）

实现层：
  Claude Code 运行在 iii-engine 外部，通过 HTTP Gateway 提交事件
  ≠ 注册了 sdk.registerFunction 的内部 Worker
```

统一称谓：
- **Internal Worker**：在 iii-engine 内注册的 `graph::` 函数（有 DB 连接，有生命周期状态机）
- **External Participant**：通过 Gateway 提交事件的外部 Agent（Claude Code、Pi、自定义 Agent）
- 两者在 Execution Graph 上产生的事件**格式相同**、**约束相同**

---

## 后果

- **统一接入路径**：所有外部系统（Claude Code、Memory System、Gmail、Browser）通过 Connector → Gateway 接入，事件格式完全统一
- **Tool 与 Worker 解耦**：MCP Tool 的接口设计不受底层 Worker 实现约束，认知转译层（ADR 24 Phase 2）可独立演化
- **Knowledge 在图中有完整版本链**：外部 Plugin/Skill 文档的任何更新产生新版本节点，历史可追溯，与执行事件因果关联
- **Connector 可独立发布**：每个 Connector（claude-code、gmail、browser）作为独立包发布，不依赖核心 Worker 实现
- **命名规范强制区分**：`graph::` 前缀 = Internal Worker；`tool::` 前缀 = iii Utility Function；MCP Tool 名 = 语义动词（无前缀）

---

## 关联 ADR

- **ADR 12** — 法定认知事件枚举：Knowledge 写入使用 `memory_updated`，不新增事件类型
- **ADR 20** — 四层记忆：`procedural_memory` 是 Knowledge 的物化查询视图，原始 Knowledge 在 Execution Graph
- **ADR 22** — LLM Provider 抽象：`tool::embed` 使用 `EmbeddingProvider` 接口，不持有 Provider 凭证
- **ADR 24** — HTTP Gateway：External Participant 通过 Gateway 提交事件；MCP Tool 的 HTTP/SSE 传输层
- **ADR 27** — Worker 生命周期状态机：Internal Worker 遵循四阶段状态机，Tool 不遵循
- **ADR 28** — 调度规约：`tool::` 函数不计入 `Max_Parallelism` 的 Worker 并发限制
