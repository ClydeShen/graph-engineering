---
name: project-phase11-complete
description: Phase 11 (memex-shell) 核心完成于 2026-06-11，356 tests；TD-E/F/G/H 清账；遗留项清单
metadata: 
  node_type: memory
  type: project
  originSessionId: 436c29a8-5ba4-483c-896d-79c7a265b32f
---

Phase 11 (memex-shell) 核心实现完成（2026-06-11，commits b2d13f45 → b4167e32，356 tests，tsc clean）。

**交付**：ADR-44（0053，WS/SSE 双轨+认证+限速）；@graph/types core/shell/connector 层（TRUST_LEVELS 单一定义、ConnectorAdapter **冻结**、ChannelPrefixedSenderId）；loadMemexConfig 复活+Phase 12 槽位；TD-E（session→Scope 存图映射，advisory lock，30min 空闲滚动）；TD-G（无歧义字母表+生成限速+migration 014 持久化）；TD-H（实为 embedding-only path，改名收编）；writeInfraEvent 提升到 shared；WS 协议（ws-protocol.ts 可测核心+Bun 动态挂载）+ SSE 结构化事件 + realtime-auth；memex onboard；@graph/terminal（协议客户端+readline REPL）；GET /dashboard live-view v0；TD-F（pi-extension 真实 MCP fetch）。

**遗留项（implementation-notes Phase 11 节）**：Pi-SDK 交互模式（需活体验证）；UI-SPEC 完整 console（Next.js+G6 前端工程）；DoD G1/G2/G3 活体 E2E；memex connect 远程地址归 Phase 15。

**关键教训**：'hono/bun' import 时就要 Bun 全局——协议逻辑与运行时组装必须分文件；PowerShell regex 重写文件会毁 UTF-8（用 Write 工具）。

[[project-phase10-complete]]
[[project-product-arc-phases-12-16]]
