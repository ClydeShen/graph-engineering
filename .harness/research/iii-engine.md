# iii-engine 研究报告

**研究完成：** 2026-05-31
**数据来源：** context7 `/iii-hq/iii`（官方仓库，3188 代码片段）、`/websites/iii_dev`（官方网站文档）、WebFetch 直接访问 iii.dev / workers.iii.dev / github.com/iii-hq/iii、WebSearch 交叉验证
**置信度：** HIGH（核心结论来自官方仓库文档和 Context7 抓取的原文，标注 [CITED]）

---

## 1. iii-engine 是什么

**仓库：** `https://github.com/iii-hq/iii`
**组织：** iii-hq（独立团队，与 earendil-works/Pi 无关联）
**产品名：** iii（读作"three i"）
**当前稳定版：** 0.16.1（发布于 2026-05-29）

[CITED: github.com/iii-hq/iii] iii 是一个**后端执行引擎**，将 API、后台任务、工作流、队列和状态统一为单一运行时。核心抽象为三个 Primitive：

| Primitive | 描述 |
|-----------|------|
| **Worker** | 通过 WebSocket 连接到引擎的进程，注册 Functions 和 Triggers |
| **Function** | 命名处理器，格式 `service::name`，接收 payload 返回结果 |
| **Trigger** | 将事件源绑定到 Function 的声明（HTTP、cron、队列、状态变更、流等） |

**语言组成** [CITED: github.com/iii-hq/iii]：
- Rust: 74.7%（引擎核心）
- TypeScript: 14.1%（SDK / Console）
- Python: 4.7%（SDK）

**许可证** [CITED: github.com/iii-hq/iii]：
- 引擎运行时：Elastic License 2.0（**非开源**，但可自托管）
- SDK / CLI / Console / Docs：Apache 2.0（开源）

**定位澄清：** iii-engine 不是"Rust async event bus crate"，而是一个完整的后端运行时系统，内置事件总线、队列、状态、定时等能力。项目文档中使用的"iii-engine"仅为非正式称谓，官方产品名是 **iii**。

---

## 2. 安装与启动

### 安装 CLI [CITED: iii.dev/docs/install]

```bash
curl -fsSL https://install.iii.dev/iii/main/install.sh | sh
```

验证：

```bash
iii --version
```

**版本兼容性注意** [CITED: iii.dev/docs/install]：引擎和 SDK 包可以有不同的 patch 版本，但必须保持在同一 minor 版本线（如 `0.16.x`）。

### 初始化项目并启动 [CITED: iii.dev/docs/quickstart]

```bash
iii project init quickstart --template quickstart
cd quickstart
iii --config config.yaml
```

引擎启动后监听：
- `ws://localhost:49134`（WebSocket，Worker 连接用）
- `http://localhost:3111`（REST API）
- `http://localhost:3112`（Stream API，如配置了 iii-stream）
- `:9464`（Prometheus metrics，如配置了 iii-observability）

也可使用默认配置直接启动（开发测试用）：

```bash
iii --use-default-config
```

### 完整 config.yaml 示例 [CITED: context7.com/iii-hq/iii/llms.txt]

```yaml
# iii-config.yaml — complete development configuration
port: ${III_PORT:49134}   # engine WebSocket port for SDK connections

workers:
  # Worker Manager — internal SDK bridge (required)
  - name: iii-worker-manager
    config:
      port: 49134

  # HTTP REST API
  - name: iii-http
    config:
      port: 3111
      host: 127.0.0.1
      default_timeout: 30000
      cors:
        allowed_origins: ['localhost']
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]

  # Persistent key-value state
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: ./data/state_store

  # Durable message queues
  - name: iii-queue
    config:
      queue_configs:
        default:
          max_retries: 5
          concurrency: 10
          type: standard
      adapter:
        name: builtin
        config:
          store_method: file_based
          file_path: ./data/queue_store

  # Cron scheduler (7-field: second minute hour day month weekday year)
  - name: iii-cron
    config:
      adapter:
        name: kv

  # Real-time WebSocket streams
  - name: iii-stream
    config:
      port: 3112
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: ./data/stream_store

  # Observability (traces, logs, metrics)
  - name: iii-observability
    config:
      enabled: true
      exporter: memory
      logs_enabled: true

  # Run external worker processes alongside the engine
  - name: iii-exec
    config:
      watch: [./workers/python]
      exec:
        - uv run python workers/python/main.py
```

### 生产环境部署 [CITED: iii.dev/docs/using-iii/deployment]

```bash
# 生成 Docker 资产
iii project generate-docker
# 生成 Dockerfile、docker-compose.yml、.env

# 启动
docker compose up
```

支持 Caddy / Nginx 反向代理做 TLS 终止，跨三个端口（49134、3111、3112）。云托管功能（`iii cloud`）**暂未上线**。

---

## 3. iii-engine 与 Pi Agent 的集成方式

### Worker 连接机制 [CITED: github.com/iii-hq/iii，iii.dev/docs/creating-workers/workers]

Workers 通过 WebSocket 连接到引擎。连接字符串通过 `III_URL` 环境变量传入：

```typescript
import { registerWorker } from "iii-sdk";
const worker = registerWorker(process.env.III_URL, {
  workerName: "my-worker",
});
```

**Pi Agent 集成方式：**

iii 本身**不直接 spawn Pi 子进程**。集成路径有两条：

**路径 A：iii-exec worker 托管**（同机部署场景）[CITED: iii.dev/docs/how-to/configure-engine]

`iii-exec` worker 负责 spawn 外部进程并监控文件变化。配置格式：

```yaml
- name: iii-exec
  config:
    watch:
      - ./workers/pi-worker          # 目录变更时自动重启
    exec:
      - node workers/pi-worker/index.js   # 最后一条命令为长驻进程
```

`iii-exec` 按顺序执行 `exec` 列表，每条命令须正常退出后才执行下一条，最后一条作为长驻 Worker 进程保持运行。

**路径 B：Pi Worker 独立进程连接**（任意位置部署）

Pi Worker 作为独立 Node.js 进程运行，自行连接 `ws://localhost:49134`：

```typescript
// pi-worker/index.ts
import { registerWorker } from "iii-sdk";
import { spawn } from "node:child_process";

const iii = registerWorker(process.env.III_URL ?? "ws://localhost:49134", {
  workerName: "pi-agent-worker",
});

iii.registerFunction("pi::run-task", async (payload) => {
  // spawn pi --mode rpc --no-session
  const pi = spawn("pi", ["--mode", "rpc", "--no-session"]);
  // JSONL stdin/stdout 通信（见 pi-sdk.md）
  ...
});
```

**关键澄清：** iii 引擎本身不知道"Pi Agent"的存在。Pi 仅是 Worker Function 内部 spawn 的一个子进程（通过 Node.js `child_process.spawn`），iii 只看到"一个注册了函数的 Worker"。

### Worker 生命周期 [CITED: iii.dev/docs/creating-workers/workers]

Worker 状态机：`connecting → connected → available/busy → disconnected`

当 Worker 的 WebSocket 关闭时，引擎自动清理其注册的 Functions 和 Triggers，取消进行中的调用。

---

## 4. Worker 订阅契约格式

### iii.worker.yaml Manifest [CITED: github.com/iii-hq/iii，docs/how-to/developing-sandbox-workers.mdx]

每个 Worker 目录根部放置 `iii.worker.yaml` 文件：

**Python Worker 示例：**
```yaml
name: my-worker
runtime:
  kind: python
  entry: worker.py
resources:
  memory: 2048
  cpus: 2
scripts:
  setup: "apt-get update && apt-get install -y build-essential"
  install: "pip install -r requirements.txt"
  start: "python worker.py"
env:
  MY_API_KEY: sk-abc123
  LOG_LEVEL: debug
```

**TypeScript Worker 示例：**
```yaml
name: my-worker
runtime:
  kind: typescript
  package_manager: npm
  entry: src/index.ts
resources:
  memory: 2048
  cpus: 2
scripts:
  install: "npm install"
  start: "npx tsx src/index.ts"
env:
  MY_API_KEY: sk-abc123
```

### 函数注册接口 [CITED: iii.dev/docs/creating-workers/workers]

```typescript
// TypeScript SDK
import { registerWorker } from "iii-sdk";
const worker = registerWorker(process.env.III_URL, {
  workerName: "my-worker",
});

// 注册函数
worker.registerFunction("service::function-name", async (payload) => {
  return { result: "value" };
});

// 注册 Trigger（声明事件绑定）
worker.registerTrigger({
  type: "durable:subscriber",          // 触发器类型
  function_id: "service::function-name",
  config: { topic: "event.topic" },
});
```

```rust
// Rust SDK
use iii_sdk::{register_worker, InitOptions, RegisterFunction, TriggerAction, TriggerRequest};

let iii = register_worker("ws://localhost:49134", InitOptions::default());

iii.register_function(
    RegisterFunctionMessage::with_id("service::name".into()),
    |payload| async move { Ok(json!({ "result": "value" })) },
);
```

### 核心 Trigger 类型 [CITED: github.com/iii-hq/iii，docs/architecture/trigger-types.mdx]

| Trigger Type | 描述 |
|---|---|
| `http` | HTTP 请求触发 |
| `durable:subscriber` | 持久化队列订阅（保证至少一次投递） |
| `subscribe` | pub/sub 话题订阅（轻量，非持久化） |
| `cron` | 定时触发（7-field 表达式） |
| `queue` | 队列消费触发 |
| `state` | 状态变更触发 |
| `stream` | 流事件触发（join/leave） |
| `log` | 日志条目触发 |
| `engine::workers-available` | Worker 连接/断开发现 |
| `engine::functions-available` | Function 注册/注销发现 |

### WebSocket 消息类型 [CITED: engine/README.md via WebFetch]

引擎使用 JSON over WebSocket，已知核心消息类型：
- `registerfunction` — Worker 注册函数
- `invokefunction` — 调用函数
- `invocationresult` — 调用结果返回

---

## 5. iii-database change feeds

### 已确认 [CITED: workers.iii.dev]

注册表中存在 `database` worker（v0.2.2），描述为：

> "query, execute, transactions, prepared statements, and change feeds"

支持 PostgreSQL、MySQL、SQLite。

### 未确认 [NOT FOUND]

change feeds 的底层机制**无法从公开文档中确认**：
- 是否基于 WAL CDC（logical replication slot）
- 是否基于 `pg_notify` / `LISTEN`
- 是否基于轮询

workers.iii.dev 的 `/workers/database` 详情页返回 404，context7 也未检索到 `database` worker 的触发器配置 schema 文档。

**项目决策影响（ADR 09）：**

在无法确认 `database` worker change feeds 机制的情况下，本项目应**维持自建 LISTEN/NOTIFY + HWM 机制**（ADR 09 现有设计）。理由：
1. `database` worker 是二进制发行版，底层机制不透明
2. 项目的 Execution Graph 是 append-only 账本，需要精确的 HWM 语义，不适合依赖黑盒 CDC
3. `pg_notify` + `LISTEN` 已经是 PostgreSQL 原生机制，延迟低，无额外依赖

---

## 6. workers.iii.dev 预制 Worker 完整清单

[CITED: workers.iii.dev，2026-05-31 抓取，版本 0.16.1]

### Engine Workers（内置，随引擎分发）

| Worker | 版本 | 功能 |
|---|---|---|
| `iii-worker-manager` | 0.16.1 | 内部 SDK 桥（必须项，监听 49134） |
| `iii-http` | 0.16.1 | 暴露 Functions 为 HTTP 端点 |
| `iii-state` | 0.16.1 | 分布式 KV 状态，支持响应式变更触发 |
| `iii-pubsub` | 0.16.1 | 基于话题的消息分发 |
| `iii-queue` | 0.16.1 | 异步任务队列，支持重试 |
| `iii-stream` | 0.16.0 | 持久化流，实时订阅 |
| `iii-cron` | 0.16.0 | cron 表达式调度（7-field 格式） |
| `iii-exec` | 0.16.1 | 执行 shell 命令作为引擎启动项 |
| `iii-sandbox` | 0.13.0 | Spawn 短暂 microVM（隔离代码执行） |
| `iii-bridge` | 0.16.1 | 通过 WebSocket 连接远程服务 |
| `configuration` | 0.16.1 | 配置文件系统适配器 |
| `iii-observability` | 0.13.0 | OpenTelemetry 集成 |

### Binary Workers（独立二进制，可跨平台安装）

| Worker | 版本 | 功能 |
|---|---|---|
| `console` | 0.1.5 | Web 浏览器和引擎检查器 |
| `shell` | 0.3.5 | Unix shell 和文件系统操作 |
| `image-resize` | 0.1.2 | 图片调整大小 |
| `iii-directory` | 0.5.2 | 引擎内省和注册表代理 |
| `database` | 0.2.2 | PostgreSQL/MySQL/SQLite 支持 |
| `iii-lsp` | 0.1.1 | IDE 自动补全和悬停提示 |
| `mcp` | 0.5.5 | MCP HTTP 桥 |

### Bundle Workers

| Worker | 版本 | 功能 |
|---|---|---|
| `harness` | 0.4.7 | （描述未公开） |

### 关键否定结论 [NOT FOUND]

以下 Worker **不在公开注册表中**（截至 2026-05-31）：
- `llm-budget` — 不存在
- `context-compaction` — 不存在
- `approval-gate` — 不存在
- `turn-orchestrator` — 不存在

**结论：** 这些名称可能来自 `harness` bundle 的内部实现，或是项目文档中对某种集成模式的非正式命名，**不是公开可通过 `iii worker add` 直接安装的独立 Worker**。

### 与本项目相关的可用 Worker

| Worker | 项目用途 | 安装命令 |
|---|---|---|
| `iii-queue` | Hyper-edge 事件路由到 Worker | 内置 |
| `iii-cron` | Ebbinghaus 衰减扫描调度（ADR 20/P2-E） | 内置 |
| `iii-state` | Worker 间共享状态 | 内置 |
| `database` | PostgreSQL 查询接口（可选） | `iii worker add database` |
| `iii-exec` | Spawn Pi Agent 子进程 | 内置 |
| `harness` | 未知（需调查 `harness` bundle 内容） | `iii worker add harness` |

---

## 7. HWM 机制

### iii-engine 没有内置 HWM [NOT FOUND]

在官方文档、Context7 抓取的 3188 个代码片段、config.yaml 示例中，均**未找到任何"High Water Mark"、"last_processed_event_id"或类似机制**的内置支持。

iii 的持久化层选项（`iii-state`、`iii-queue`）是通用 KV 存储和消息队列，不提供 append-only event log 的游标追踪语义。

**结论：** HWM 机制必须**自建**，作为 PostgreSQL 表字段维护（如 `bus_state.last_processed_event_id`）。这与 ADR 09 的现有设计一致，无需变更。

### 事件投递保证

iii 提供两种订阅语义 [CITED: github.com/iii-hq/iii]：
- `durable:subscriber`：持久化队列，至少一次投递，Worker 离线时消息排队
- `subscribe`：轻量 pub/sub，Worker 离线时消息丢失

本项目应使用 **`durable:subscriber`** 作为 Hyper-edge 事件的投递机制，配合自建 HWM 实现 exactly-once 语义（通过 PostgreSQL 事务中的幂等检查）。

---

## 8. gsd-pi 仓库分析

**仓库：** `https://github.com/open-gsd/gsd-pi`

[CITED: WebFetch github.com/open-gsd/gsd-pi]

gsd-pi 是一个**本地优先编码 Agent 平台**，与 Pi 编码 Agent 无关联（名称重合，实质不同）。

| 属性 | 值 |
|---|---|
| 主要语言 | TypeScript (94.2%) |
| 定位 | meta-prompting、spec-driven development 系统 |
| 核心目录 | `src/`（运行时）、`packages/`（CLI/Agent/TUI/RPC）、`native/`（原生引擎二进制）、`studio/`（桌面应用） |

**关键结论：** gsd-pi 仓库中**未发现"iii-engine"相关内容**（WebFetch 明确报告："This term does not appear in the provided documentation"）。该仓库与本项目架构无直接关联，不作为 Worker 样板参考来源。

---

## 9. RBAC 和安全

[CITED: github.com/iii-hq/iii，docs/workers/iii-worker-manager.mdx]

`iii-worker-manager` 支持在第二监听端口（如 49135）上配置 RBAC：

```yaml
- name: iii-worker-manager
  config:
    host: 0.0.0.0
    port: 49135
    rbac:
      auth_function_id: my-project::auth-function
      on_trigger_registration_function_id: my-project::on-trigger-reg
      on_function_registration_function_id: my-project::on-function-reg
      expose_functions:
        - match("engine::*")
        - match("*::public")
```

Auth 函数在 WebSocket upgrade 时调用，可基于 header token 控制 Worker 权限。适合 Phase 1 中控制 Pi Agent Worker 的图写入权限。

---

## 10. 未解决问题

| # | 问题 | 状态 |
|---|------|------|
| U-1 | `database` worker change feeds 底层机制（WAL / pg_notify / 轮询） | [UNVERIFIED] — workers.iii.dev/database 返回 404，无公开文档 |
| U-2 | `harness` bundle (v0.4.7) 的内容 — 是否包含 llm-budget 等组件 | [UNVERIFIED] — 描述未公开，需 `iii worker add harness` 后检查 |
| U-3 | iii-engine Control Plane 专属 DDL 线程的具体实现 | [UNVERIFIED] — 官方文档未提及此术语，可能是项目内部推断 |
| U-4 | `iii-exec` 在 Windows 上的进程生命周期管理行为 | [UNVERIFIED] — 文档主要面向 Linux/macOS |
| U-5 | `database` worker 与 pgcrypto（SHA-256 计算）的兼容性 | [UNVERIFIED] — 无相关文档 |
| U-6 | `iii` 在 Windows 上的原生安装方式（PowerShell 脚本） | [UNVERIFIED] — 官方仅记录 curl 脚本；Phase 1 建议用 Docker 绕开，但原生安装路径待查 |

---

## 11. 跨平台支持（Windows / macOS / Linux）

**查询来源：** `ctx7 docs /websites/iii_dev`（2026-05-31 补充验证）+ 系统性跨平台分析

项目需求 NF6 要求系统在三个平台无修改运行。以下逐项分析各组件的跨平台行为。

---

### 11.1 iii 安装

| 平台 | 安装方式 | 状态 |
|------|---------|------|
| macOS / Linux | `curl -fsSL https://install.iii.dev/iii/main/install.sh \| sh` | [CITED: iii.dev/docs/install] ✅ |
| Windows | curl 脚本依赖 `sh`，Windows 原生不可用 | [UNVERIFIED] ⚠️ |
| 全平台（推荐开发路径） | `iii project generate-docker` → `docker compose up` | [CITED: iii.dev/docs/using-iii/deployment] ✅ |

**Windows 安装建议（优先级排序）：**
1. **Docker**（最安全）：`iii project generate-docker` 生成完整 Docker Compose 配置，绕开平台差异
2. **WSL2**：在 WSL2 内运行 curl 脚本，与 Linux 行为完全一致
3. **PowerShell installer**：需验证 `https://install.iii.dev` 是否提供 `.ps1` 脚本 [UNVERIFIED]

**结论：Phase 1 的 Windows 开发路径以 Docker 为主，规避平台安装差异。**

---

### 11.2 iii-exec `exec` 命令解析行为 [CITED: iii.dev/docs/how-to/configure-engine]

`iii-exec` 的 `exec` 字段在不同平台的 Shell 包装方式不同：

| 平台 | Shell 包装 |
|------|-----------|
| macOS / Linux | `sh -c "<command>"` |
| **Windows** | `cmd /C "<command>"` |

**影响：** 如果 `exec` 命令包含 Unix 特有语法（`&&`、`|`、`$VAR`、单引号等），在 Windows 上会失败。

**跨平台安全的 exec 写法：**
```yaml
# ✅ 跨平台安全：使用 node 直接调用，不依赖 shell 特性
- name: iii-exec
  config:
    exec:
      - node workers/pi-worker/index.js

# ✅ 跨平台安全：npm scripts（npm 处理平台差异）
- name: iii-exec
  config:
    exec:
      - npm --prefix workers/pi-worker start

# ❌ Unix only：管道和变量
- name: iii-exec
  config:
    exec:
      - "NODE_ENV=production node workers/pi-worker/index.js"
```

---

### 11.3 Pi Agent spawn 跨平台处理 [CRITICAL]

这是**最高风险的跨平台问题**。

**根本原因：** npm 全局安装的 CLI 工具在 Windows 上生成 `.cmd` 包装脚本（`pi.cmd`）而非 Unix 可执行文件。`child_process.spawn("pi", ...)` 在 Windows 上静默失败（`ENOENT`），因为 Windows 无法直接执行 `.cmd` 文件。

**解决方案：在 Worker 初始化时设置 `shell: true`**

```typescript
// ✅ 跨平台正确：在 spawn 时加 shell: true
const pi = spawn("pi", ["--mode", "rpc", "--no-session"], {
  shell: true,    // Windows 用 cmd.exe 解析；Unix 用 /bin/sh
  stdio: ["pipe", "pipe", "pipe"],
});

// ❌ Unix only：裸 spawn 在 Windows 无法解析 .cmd
const pi = spawn("pi", ["--mode", "rpc", "--no-session"]);
```

**或者：** 封装为平台感知的工厂函数（在 Worker 库中统一处理，不在每个 call site 重复）：

```typescript
// workers/lib/spawn-pi.ts
import { spawn } from "node:child_process";
import { ChildProcess } from "node:child_process";

export function spawnPi(args: string[]): ChildProcess {
  return spawn("pi", args, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
```

**注意：** `shell: true` 的安全风险仅在 args 来自不可信用户输入时存在。本项目的 args 均为硬编码常量（`["--mode", "rpc", "--no-session"]`），无注入风险。

---

### 11.4 Worker 生命周期管理命令 [CITED: iii.dev/docs/how-to/developing-sandbox-workers]

```bash
iii worker list          # 列出所有 Worker（含 TYPE 列：Local/OCI/Binary/Config）
iii worker stop <name>   # 停止运行中的 Worker
iii worker start <name>  # 启动已停止的 Worker
iii worker remove <name> # 移除 Worker（删除 config.yaml 条目和缓存）
```

### 11.5 TriggerAction 类型 [CITED: iii.dev/docs/how-to/trigger-actions]

在 Worker Function 内部调用其他 Function 时，可指定三种 action：

| TriggerAction | 行为 |
|---|---|
| `Sync`（默认） | 同步调用，等待结果 |
| `Enqueue(queue)` | 入队异步执行，保证至少一次 |
| `Void` | 即发即忘（best-effort），用于非关键操作 |

本项目 Hyper-edge 事件发布应使用 `Enqueue` + `durable:subscriber`，确保 Worker 离线时不丢消息。

### 11.6 Rust crate (`crates/iii-engine/`) 跨平台

- `tokio`、`tokio-postgres`：完全跨平台，无平台差异
- `cargo build` / `cargo test`：三平台无修改编译
- 无平台相关风险

### 11.7 harness bundle 内容 [NOT FOUND]

`/websites/iii_dev` 的 context7 文档中**未出现 harness bundle 的任何内容**。`llm-budget`、`context-compaction`、`approval-gate`、`turn-orchestrator` 在任何 context7 查询中均未出现。这些名称来源不明，不应作为公开 Worker 规划依据。（见未解决问题 U-2）

---

## 引用索引

| # | URL | 内容摘要 |
|---|-----|---------|
| 1 | https://github.com/iii-hq/iii | 官方仓库，语言组成、目录结构、许可证、SDK、Engine README |
| 2 | https://iii.dev/docs/quickstart | 快速入门：初始化、启动、iii worker add 命令、Worker WebSocket 连接 |
| 3 | https://iii.dev/docs/install | 安装命令（curl install.sh）、版本兼容性规则 |
| 4 | https://iii.dev/docs/using-iii/deployment | 部署方式：Docker、反向代理；云托管暂未上线 |
| 5 | https://iii.dev/docs/using-iii/workers | config.yaml 声明 worker 方式；iii worker add 流程 |
| 6 | https://iii.dev/docs/creating-workers/workers | Worker 连接模式、iii.worker.yaml、WebSocket 生命周期、函数/触发器注册 |
| 7 | https://iii.dev/docs/understanding-iii/engine | 引擎职责：注册表、路由；hot-reload；语言无关路由 |
| 8 | https://workers.iii.dev/ | 完整 Worker 注册表（22 个 Worker，含版本和分类） |
| 9 | https://github.com/iii-hq/iii/blob/main/engine/Cargo.toml | 引擎依赖：tokio、axum、serde、ring/sha2、lapin（RabbitMQ）、Redis |
| 10 | https://raw.githubusercontent.com/iii-hq/iii/main/engine/config.yaml | 完整开发配置：所有内置 Worker 的 YAML 格式 |
| 11 | https://context7.com/iii-hq/iii (via ctx7) | 官方文档 3188 片段：Worker Manifest、Trigger 类型、RBAC、Exec Worker、Agentic 模式 |
| 12 | https://github.com/open-gsd/gsd-pi | gsd-pi 仓库（TypeScript 平台，非 iii-engine 相关） |
| 13 | https://github.com/iii-hq/iii/releases | 发布记录：当前稳定版 0.16.1（2026-05-29） |
| 14 | https://context7.com/websites/iii_dev (via ctx7) | iii.dev 官网文档：iii-exec Windows 行为、Worker 生命周期命令、TriggerAction 类型 |
