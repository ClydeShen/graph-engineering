---
name: project-memex-terminal-naming
description: 三层架构命名锁定 (2026-06-09)：MemexCore / MemexShell / MemexOS；MemexTerminal = 内置 TUI，与外部 Pi agent 完全无关
metadata: 
  node_type: memory
  type: project
  originSessionId: 90d3e1f6-9a76-4f7d-a817-eb8a348a8f4a
---

## 三层架构命名（2026-06-09 锁定）

**MemexOS** = 产品整体品牌名，不是独立的代码层或进程。MemexCore + MemexShell 合在一起 = MemexOS。

**MemexCore** = 图引擎/账本/Worker 运行时。稳定核心，后期少动。
含：iii-engine, PostgreSQL Execution Graph, Workers, Control Plane, Gateway HTTP server（含 MCP server）。

**MemexShell** = 用户交互与外部集成层。后期主要在这里做文章，用来解耦。
含：MemexTerminal, onboarding TUI (clack/prompts), Dashboard 前端, packages/cli (connect 工具), packages/pi-extension。

**Shell 设计原则**：Shell 不拥有状态，所有状态在 Core 的 Graph 里。Shell 是 Graph 的消费者和触发者。

---

## MemexTerminal（内置默认终端）

- 完全内置于 MemexShell，不是外部 agent
- 用 Pi SDK 构建（createAgentSession + subscribe）——Pi SDK 是实现技术，不是身份标签
- 直接调 Gateway REST API，不经 MCP 协议
- 没有 AgentCard，不参与 FrontierScheduler skill 路由
- 安装完成后自动启动

## 外部 Pi agent（Pi Terminal）

- 用户自己安装的 Pi，通过 MCP 连入 MemexCore
- protocol='mcp'，有 AgentCard，参与 skill 路由
- 与 MemexTerminal 几乎没有直接关系——两者层面不同，不互推

**Why:** 2026-06-09 锁定三层命名；用户明确"后期大部分时候在 Shell 层做文章，用来做解耦"。

**How to apply:**
- 内置默认终端 → **MemexTerminal**
- 外部 Pi peer agent → **Pi Terminal** / external Pi agent
- 整体产品 → **MemexOS**；核心引擎 → **MemexCore**；交互层 → **MemexShell**

[[project_memex_final_product_is_hermes_like_e2e]]
[[project_terminology_alignment_needed]]
