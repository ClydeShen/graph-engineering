---
name: reference-specimens-directory
description: D:\Repo\specimens 是学习标本项目目录，包含6个参考代码库，供 graph-native agent runtime 研发参考
metadata: 
  node_type: memory
  type: reference
  originSessionId: 922356e0-f326-4a2b-8fe9-24b3041a650e
---

`D:\Repo\specimens` — 学习标本项目根目录。通过 `.\update.ps1` 更新并刷新 roam 索引。注册表见 `specimens.json` / `README.md`。

## 标本清单

| 标本 | 路径 | 学习重点 |
|------|------|---------|
| **agentmemory** | `specimens/agentmemory` | iii-engine 最佳实现参考：Worker/Tool/Connector 模式、Jaccard 去重、keyed mutex、session hook 生命周期、crystallize→lesson 事件链 |
| **hermes-agent** | `specimens/hermes-agent` | 目标架构愿景：通用 agent runtime，所有 worker/tool/connector 插入统一图，多模态交互层参考。**nanobot 的后继/优化版**——同源核心，但在各方面（架构整洁度、扩展性等）都比 nanobot 更成熟，优先以 hermes-agent 为准，nanobot 仅在 hermes-agent 缺失某细节时回查 |
| **iii** | `specimens/iii` | iii engine 内核：事件总线内部实现、`sdk.registerFunction` 合约、`durable:subscriber` 触发机制、Worker 路由 |
| **gsd-2** | `specimens/gsd-2` | GSD harness v2：规划/执行 harness 模式、phase 管理、skill 编排 |
| **headroom** | `specimens/headroom` | Context 压缩层：SmartCrusher 统计压缩、CCR 可逆压缩+检索工具注入、Pipeline lifecycle hooks、hierarchical memory + supersession chains、跨 agent 共享记忆、feedback 闭环驱动压缩决策 |
| **nanobot** | `specimens/nanobot` (HKUDS/nanobot) | Small-core 持久化 agent runtime：多渠道 connector 架构（WebUI/Telegram/Feishu/Slack/Discord/Teams/email 统一接入小核心）+ small-core 可扩展性哲学（MCP/extension registry 与核心解耦）。直接对应 **MemexShell 交互层**设计。**hermes-agent 的前身 prototype**——包含 hermes 的核心思路，但 hermes-agent 在各方面做了更优化的版本；两者同源，hermes-agent 是更成熟的目标参考 |

## 分析输出（已有）

- `C:\Temp\agentmemory-analysis-arch.md` — 架构 & pipeline 连线
- `C:\Temp\agentmemory-analysis-patterns.md` — 7 个设计模式（含 file:line 引用）

## Roam 索引根目录

**用法（用户 2026-06-13 强调）：查标本一律走 `roam_*` MCP 工具（roam_understand /
roam_search_symbol / roam_uses / roam_batch_get / roam_context 等），不要 grep/Read
大标本文件**（hermes-agent 单文件常 100–280KB，grep 浪费上下文）。全部标本均已 roam 索引。

全部6个标本均已建立 roam 索引（2026-06-13 用户再确认；2026-06-10 核实 `.roam/index.db` 均存在且非空）：

```
root: D:\Repo\specimens\agentmemory   (已索引, 3.8MB)
root: D:\Repo\specimens\hermes-agent  (已索引, 106MB)
root: D:\Repo\specimens\iii           (已索引, 20MB)
root: D:\Repo\specimens\gsd-2         (已索引, 51MB)
root: D:\Repo\specimens\headroom      (已索引, 59MB)
root: D:\Repo\specimens\nanobot       (已索引, 19MB)
```
