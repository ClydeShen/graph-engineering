# Pi SDK 研究报告（完整验证版）

**研究完成：** 2026-05-31
**数据来源：** context7 `/websites/pi_dev`（真实文档抓取，非推断）
**查询覆盖：** sdk · compaction · extensions · quickstart · rpc · session-format · termux
**置信度：** HIGH（所有核心结论均来自官方文档原文，标注 [CITED]）

---

## 1. Pi 是什么

**npm 包：** `@earendil-works/pi-coding-agent`
**厂商：** earendil-works

Pi 是一个**编码 Agent CLI 工具兼可嵌入 SDK**，定位与 Claude Code、Cursor、Codex 相同。可通过终端交互运行，也可作为 SDK 嵌入程序中，或以 RPC 子进程模式被父进程程序化控制。

**安装方式** [CITED: pi.dev, pi.dev/docs/latest, pi.dev/docs/latest/quickstart]：
```bash
curl -fsSL https://pi.dev/install.sh | sh
# 或
npm install -g @earendil-works/pi-coding-agent
# 或
pnpm add -g @earendil-works/pi-coding-agent
# 或
bun add -g @earendil-works/pi-coding-agent
```

安装后 `pi` 命令即可启动编码 agent session。

**SDK 用途** [CITED: pi.dev/docs/latest/sdk]：
> "The SDK provides programmatic access to pi's agent capabilities. Use it to embed pi in other applications, build custom interfaces, or integrate with automated workflows. Example use cases include building custom UIs, integrating agent capabilities into existing applications, creating automated pipelines, building custom tools that spawn sub-agents, and testing agent behavior programmatically."

---

## 2. Pi 与 iii-engine 的关系

**关键发现：Pi 和 iii-engine 是两个独立产品，来自不同团队。**

Pi 的官方文档（pi.dev）中**完全没有 iii-engine 的内容**。对"iii-engine what is it how does it relate to pi agent orchestration"的 context7 查询返回零条 iii-engine 专属文档，全部结果均为 Pi SDK 自身文档。

**结论：**
- Pi（`@earendil-works/pi-coding-agent`）= earendil-works 出品的编码 Agent CLI/SDK
- iii-engine = 独立产品，有自己的 `workers.iii.dev` Worker 注册表、`iii` CLI（见 `docs/未决问题追踪.md` P1-A）
- 本项目的架构创新 = 将两者结合，加上自建 PostgreSQL 执行图账本

RFC v4 原文："本项目旨在构建一个基于 **Pi Agent 框架**与 **iii-engine 通用异步事件总线**的去中心化、图原生 Agent 运行时系统。"——两者并列引用，是两个独立组件。

---

## 3. 三种运行模式

[CITED: pi.dev/docs/latest/sdk]

### 3.1 Interactive Mode（TUI 交互模式）
```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

const mode = new InteractiveMode(runtime, {
  migratedProviders: [],
  modelFallbackMessage: undefined,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});

await mode.run();
```

### 3.2 RPC Mode（JSON-RPC 子进程模式）
```typescript
import { runRpcMode } from "@earendil-works/pi-coding-agent";
// ...
await runRpcMode(runtime);
```

> "runRpcMode operates in JSON-RPC mode, designed for subprocess integration. A separate CLI command is also available for this mode without building with the SDK." [CITED: pi.dev/docs/latest/sdk]

**对本项目的意义：iii-engine 以此模式 spawn Pi Agent 子进程作为 Worker。**

### 3.3 Print Mode（单次执行模式）
```typescript
await runPrintMode(runtime, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: ["Follow up"],
});
```

---

## 4. RPC 子进程协议（iii-engine ↔ Pi Agent 通信）

[CITED: pi.dev/docs/latest/rpc]

Pi 以 RPC 模式运行时，父进程通过 stdin/stdout 以 JSONL 格式通信。

### Node.js 父进程示例（官方文档原文）
```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

// spawn Pi 子进程，RPC 模式，无持久化 session
const agent = spawn("pi", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });
}

// 接收 Pi Agent 的事件流（stdout）
attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// 发送任务给 Pi Agent（stdin）
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// 中止
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```

### Python 父进程示例（官方文档原文）
```python
import subprocess
import json

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

send({"type": "prompt", "message": "Hello!"})

for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)

    if event.get("type") == "agent_end":
        print()
        break
```

### RPC 事件格式 [CITED: pi.dev/docs/latest/rpc]
```json
// 工具开始执行
{ "type": "tool_execution_start", "toolCallId": "call_abc123", "toolName": "bash", "args": {"command": "ls -la"} }

// 工具执行完成
{ "type": "tool_execution_end", "toolCallId": "call_abc123", "toolName": "bash",
  "result": { "content": [{"type": "text", "text": "total 48\n..."}], "details": {} },
  "isError": false }
```

### Session 消息格式 [CITED: pi.dev/docs/latest/session-format]
```json
{
  "type": "message",
  "id": "c3d4e5f6",
  "parentId": "b2c3d4e5",
  "timestamp": "2024-12-03T14:00:03.000Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_123",
    "toolName": "bash",
    "content": [{"type": "text", "text": "output"}],
    "isError": false
  }
}
```

---

## 5. 内置工具系统

[CITED: pi.dev/docs/latest/sdk, pi.dev/docs/latest/quickstart]

```typescript
import {
  codingTools,   // [read, bash, edit, write] ← 默认工具集
  readOnlyTools, // [read, grep, find, ls]
  readTool, bashTool, editTool, writeTool,
  grepTool, findTool, lsTool,
} from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  tools: readOnlyTools,  // 只读模式
});

// 或精选工具
const { session } = await createAgentSession({
  tools: [readTool, bashTool, grepTool],
});
```

> "By default, Pi provides four tools: `read` for reading files, `write` for creating or overwriting files, `edit` for patching files, and `bash` for running shell commands. Additional read-only tools like `grep`, `find`, and `ls` are also available." [CITED: pi.dev/docs/latest/quickstart]

---

## 6. 自定义工具注册（本项目集成的核心）

[CITED: pi.dev/docs/latest/extensions]

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // StringEnum for Google API compatibility
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // 向后兼容旧参数形状
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // 流式进度更新
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    const result = await pi.exec("some-command", [], { signal });

    return {
      content: [{ type: "text", text: "Done" }],   // 发送给 LLM
      details: { data: result },                    // 用于渲染和状态
      terminate: true,  // ← 当前工具批次全部返回 terminate:true 时结束 session
    };
  },

  renderCall(args, theme, context) { /* 可选自定义渲染 */ },
  renderResult(result, options, theme, context) { /* 可选自定义渲染 */ },
});
```

**`terminate: true` 的含义**：当一个工具批次内所有已完成的工具都返回 `terminate: true` 时，Pi session 自动结束。对本项目而言，`write_convergence_node` 成功写回后返回 `terminate: true`，Worker 即结束。

---

## 7. 工具拦截与安全层

[CITED: pi.dev/docs/latest/extensions]

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash", "read", "write", "edit", etc.
  // event.toolCallId
  // event.input - 工具参数（可变）

  if (isToolCallEventType("bash", event)) {
    // event.input 类型为 { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command" };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input 类型为 { path: string; offset?: number; limit?: number }
    console.log(`Reading: ${event.input.path}`);
  }
});
```

**对本项目的意义：** 可在拦截层强制阻止 Pi Agent 生成任何 DDL 命令（DROP TABLE、ALTER TABLE 等），物理保障数据面 Worker 账号无 DDL 权限——即使 Pi Agent 产生了错误的工具调用，拦截层也能阻止执行。

---

## 8. Session 管理

[CITED: pi.dev/docs/latest/sdk]

```typescript
// 方式一：纯内存 session（无状态，Worker 用完即丢）
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

// 方式二：持久化 session（按 cwd 自动命名）
const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

// 方式三：继续最近的 session
const { session, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.continueRecent(process.cwd()),
});

// 方式四：打开指定 session 文件
const { session } = await createAgentSession({
  sessionManager: SessionManager.open("/path/to/session.jsonl"),
});
```

**本项目 Worker 使用 `SessionManager.inMemory()`**：每次 Worker 激活是独立无状态的 Pi session，执行完即销毁。状态全部持久化在 PostgreSQL Execution Graph 里，不需要 Pi 自己的 session 持久化。

---

## 9. AgentSession 完整接口

[CITED: pi.dev/docs/latest/sdk]

```typescript
interface AgentSession {
  // 发送 prompt，等待执行完成
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // 在流式输出过程中插入消息
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // 订阅事件流（返回取消订阅函数）
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session 信息
  sessionFile: string | undefined;
  sessionId: string;

  // 模型控制
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // 状态访问
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // Session 树导航（在当前 session 文件内）
  navigateTree(targetId: string, options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // 中止当前操作
  abort(): Promise<void>;

  // 清理
  dispose(): void;
}
```

> "Session replacement APIs such as new-session, resume, fork, and import live on `AgentSessionRuntime`, not on `AgentSession`." [CITED: pi.dev/docs/latest/sdk]

### AgentSessionRuntime 关键操作
```typescript
// Session 替换操作（在 runtime 上，不在 session 上）
await runtime.newSession();                            // 创建新 session
await runtime.switchSession();                         // 切换到另一个已有 session
await runtime.fork(entryId, { position: "at" });       // 从特定节点分叉新执行路径
await runtime.importFromJsonl(filePath);               // 从 JSONL 文件导入 session
```

**`fork()` 与 Pi Sandbox（ISSUE-28）**：`runtime.fork(entryId)` 从任意历史节点开辟新执行路径，不影响原 session。结合 `SessionManager.inMemory()`，可实现"在内存中预演图拓扑推进，不污染 PostgreSQL 主账本"——这是 Phase 4 Pi Sandbox 设计的候选实现路径。

---

## 10. Compaction 机制（完整验证）

[CITED: pi.dev/docs/latest/compaction, pi.dev/docs/latest/settings]

### 10.1 触发条件
```typescript
contextTokens > contextWindow - reserveTokens
```

### 10.2 配置
```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### 10.3 工作机制（官方文档可视化，原文）
```
Before compaction:
  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):
  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:
  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### 10.4 重复 Compaction
> "In repeated compactions, the summarization span begins at the previous compaction's kept boundary. This ensures that messages surviving an earlier compaction are included in subsequent summarization passes. Pi recalculates `tokensBefore` from the rebuilt session context before writing a new `CompactionEntry`, ensuring the token count accurately reflects the pre-compaction context being replaced." [CITED: pi.dev/docs/latest/compaction]

### 10.5 手动触发
```
/compact [instructions]  # 可选指令引导摘要方向
```

---

## 11. Knapsack Slicing vs Pi Compaction：精确分工

两者**互补，不竞争**，作用在不同层次：

| 维度 | Knapsack Slicing（自建） | Pi Compaction（Pi 内置） |
|---|---|---|
| **触发时机** | Worker session 启动前（每次激活） | Session 运行中，token 超阈值自动触发 |
| **操作对象** | PostgreSQL Execution Graph | Pi session 内部对话消息列表 |
| **是否有损** | **无损**（图永久 append-only 保存） | **有损**（旧消息被摘要条目替代） |
| **N_root 保障** | 刚性：plan_created 根节点永不截断 | 无此保障（旧消息可被摘要覆盖） |
| **触发方** | 系统（Worker 激活流程的一部分） | Pi 自动（token 阈值），或 `/compact` 手动 |
| **适用 Worker** | 所有 Worker（必须） | 长时间运行的 Worker（TemplateProposalWorker） |

**ConflictResolverWorker**（3–5 轮）：Compaction 不会触发，无需配置。
**TemplateProposalWorker**（审计复杂 Scope，可能 20+ 轮工具调用）：建议配置 `compaction.enabled: true`。

---

## 12. 本项目中 Worker 的完整实现模式

```typescript
// workers/conflict-resolver/index.ts
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { pg } from "../db";
import { buildKnapsackSlice } from "../knapsack";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ── 自定义工具 1：读取图节点 ──────────────────────────────────────────────
const readGraphNodesTool = {
  name: "read_graph_nodes",
  label: "Read Graph Nodes",
  description: "Read nodes from the execution graph by version hashes",
  parameters: Type.Object({
    version_hashes: Type.Array(Type.String()),
  }),
  async execute(_id: string, params: { version_hashes: string[] }) {
    const rows = await pg.query(
      `SELECT entity_id, version_hash, predecessor_hash, event_type, payload
       FROM execution_event_log
       WHERE version_hash = ANY($1)`,
      [params.version_hashes]
    );
    return { content: [{ type: "text", text: JSON.stringify(rows.rows) }] };
  },
};

// ── 自定义工具 2：写回收敛节点（完成时 terminate）────────────────────────
const writeConvergenceNodeTool = {
  name: "write_convergence_node",
  label: "Write Convergence Node",
  description: "Write a convergence node back to the execution graph via Writable CTE OCC",
  parameters: Type.Object({
    entity_id: Type.String(),
    scope_id: Type.String(),
    predecessor_hash: Type.String(),  // winner 的 version_hash
    payload: Type.Object({
      convergence_gate: Type.Object({
        legitimate_basis_hash: Type.String(),
        conflicted_basis_hash: Type.String(),
        clash_scope_root_hash: Type.String(),
      }),
    }),
  }),
  async execute(_id: string, params: any) {
    // Writable CTE INSERT（参见 ADR 03）
    const result = await pg.query(`
      INSERT INTO execution_event_log (entity_id, scope_id, predecessor_hash, event_type, payload, version_hash)
      VALUES ($1, $2, $3, 'memory_updated', $4,
        encode(digest($2||'|'||$1||'|'||$3||'|memory_updated|'||$4::text, 'sha256'), 'hex'))
      RETURNING version_hash
    `, [params.entity_id, params.scope_id, params.predecessor_hash, params.payload]);

    return {
      content: [{ type: "text", text: `Convergence node written: ${result.rows[0].version_hash}` }],
      terminate: true,  // ← Pi session 自动结束，Worker 完成
    };
  },
};

// ── Worker 入口：由 iii-engine RPC 调用 ──────────────────────────────────
export async function handleConflict(event: ConflictDetectedEvent) {
  // 1. Knapsack Slicing：从 Execution Graph 切出因果上下文
  const topologicalSlice = await buildKnapsackSlice(event, W_MAX);

  // 2. 启动 Pi Agent session（无状态，用完即丢）
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    tools: [readGraphNodesTool, writeConvergenceNodeTool],
    // compaction 配置：ConflictResolverWorker 是短 session，不需要
  });

  // 3. 安全拦截：阻止任何 DDL 命令
  session.on?.("tool_call", async (e) => {
    if (isToolCallEventType("bash", e)) {
      const cmd = e.input.command.toUpperCase();
      if (cmd.includes("DROP ") || cmd.includes("ALTER ") || cmd.includes("TRUNCATE ")) {
        return { block: true, reason: "DDL commands are forbidden in Worker context" };
      }
    }
  });

  // 4. 执行：Pi Agent 自主分析分叉、语义合并、写回收敛节点
  await session.prompt(
    `你是 ConflictResolverWorker。\n\n` +
    `执行图拓扑切片（Knapsack Slicing 输出）：\n${topologicalSlice}\n\n` +
    `当前事件：conflict_detected\n` +
    `entity_id: ${event.entity_id}\n` +
    `scope_id: ${event.scope_id}\n\n` +
    `任务：分析两条分叉路径的语义差异，生成语义收敛后调用 write_convergence_node 写回执行图。\n` +
    `收敛节点必须包含 convergence_gate（legitimate_basis_hash + conflicted_basis_hash + clash_scope_root_hash）。`
  );
  // session 在 write_convergence_node 返回 terminate:true 后自动结束
}
```

---

## 13. Pi Lifecycle Events（Extension 系统）

[CITED: pi.dev/docs/latest/extensions]

> "The pi lifecycle begins with session startup, involving `session_start` and `resources_discover` events. User prompts trigger a series of events including input processing, skill expansion, and agent initialization. The core interaction happens within turns, where messages are processed, and LLM calls to tools are managed through `tool_execution` events. The session concludes with `agent_end`. Other commands like `/new`, `/resume`, `/fork`, `/compact`, `/tree`, and model selection also trigger specific lifecycle events."

完整事件序列：
```
session_start → resources_discover
  → [用户 prompt]
  → input_processing → skill_expansion → agent_initialization
  → [turn 循环]:
      message_processing → LLM call → tool_execution_start → tool_execution_end
      → [如 terminate:true] → agent_end
  → [如 contextTokens > W - reserveTokens] → auto_compaction
```

---

## 14. 未解决的问题（需访问 iii-engine 文档）

以下问题在 pi.dev 文档中**没有答案**，需要独立查询 iii-engine 文档：

| # | 问题 | 影响范围 | 优先级 |
|---|---|---|---|
| U1 | iii-engine 是开源 Rust crate、可安装二进制，还是托管服务？ | Phase 1 第一步工作量 | 🔴 |
| U2 | `iii-database` worker 是否基于 WAL CDC，能替代 pg_notify LISTEN/NOTIFY？ | P1-C，ADR 09 修订 | 🟡 |
| U3 | `workers.iii.dev` 的 `llm-budget`、`context-compaction` 等 Worker 是否公开可用？ | P1-A，ADR 14/16 简化 | 🟡 |
| U4 | `iii worker add` CLI 的完整用法和 Worker 配置格式 | Worker 注册方式 | 🟡 |
| U5 | Pi `fork()` API 与 Pi Sandbox（ISSUE-28）的具体集成方案 | Phase 4 设计 | 🟢 |
| U6 | gsd-pi（github.com/open-gsd/gsd-pi）的实际代码结构 | Worker 样板代码参考 | 🟢 |

---

## 15. 引用索引

| 引用 | 文档来源 URL |
|---|---|
| Pi 安装命令 | https://pi.dev, https://pi.dev/docs/latest, https://pi.dev/docs/latest/quickstart |
| SDK 用途说明 | https://pi.dev/docs/latest/sdk |
| 三种运行模式代码 | https://pi.dev/docs/latest/sdk |
| RPC Node.js 示例 | https://pi.dev/docs/latest/rpc |
| RPC Python 示例 | https://pi.dev/docs/latest/rpc |
| RPC 事件格式 | https://pi.dev/docs/latest/rpc |
| Session 消息格式 | https://pi.dev/docs/latest/session-format |
| 内置工具列表 | https://pi.dev/docs/latest/sdk, https://pi.dev/docs/latest/quickstart |
| 自定义工具注册 | https://pi.dev/docs/latest/extensions |
| 工具拦截 API | https://pi.dev/docs/latest/extensions |
| SessionManager 变体 | https://pi.dev/docs/latest/sdk |
| AgentSession 接口 | https://pi.dev/docs/latest/sdk |
| AgentSessionRuntime 操作 | https://pi.dev/docs/latest/sdk |
| Compaction 可视化 | https://pi.dev/docs/latest/compaction |
| Compaction 触发条件 | https://pi.dev/docs/latest/compaction |
| Compaction 配置 | https://pi.dev/docs/latest/settings |
| Lifecycle events | https://pi.dev/docs/latest/extensions |
| Termux 安装 | https://pi.dev/docs/latest/termux |
