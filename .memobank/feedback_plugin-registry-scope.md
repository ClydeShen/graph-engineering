---
name: plugin-registry-scope
description: plugin/registry 应用于 Tool 和 Provider，不应用于 Worker 和 HTTP 路由
metadata:
  type: feedback
---

在这个 backend 中，plugin/registry 扩展点只适合：
- **ToolRegistry** — Tools 是真正的外部能力扩展点（file-reader / code-analyzer / web-search），新增 tool 不应改 worker 代码
- **ProviderFactory** — LLMProvider / EmbeddingProvider 接口已存在，缺 factory 读 config 返回正确实例

**Why:** Workers 数量有限、每个对应一个 ADR，是核心业务逻辑不是扩展点。HTTP routes 是固定 API 契约。把 Workers 包进 WorkerPlugin 只是给 iii 的 registerFunction 加了无意义的壳。

**How to apply:** Phase 2 新增扩展时，先问"这是 Tool（外部能力）还是 Worker（业务逻辑）"。Tool → 走 ToolRegistry。Worker → 直接 registerFunction，不套 plugin 层。
