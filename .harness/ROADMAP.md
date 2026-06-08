# Roadmap

## 北极星（愿景级，非阶段）

**最终产品形态：基于 MemexCore 构建一个 Hermes-agent 级别的端到端系统**——用户多次确认这是长期目标（2026-06-08）。Hermes 在这里是"交互模式与产品形态"的参照对象，不是要照搬其实现；MemexCore（图引擎/账本/Worker）已是现有核心，最终产品需要在其上长出一层完整的端到端交互体验（暂称 MemexShell）。

**如何应用**：下方各阶段的 dashboard 对话界面、Phase 6 graph-inspection TUI、Pi/Codex/Claude 连接器等，都不是与"未来端到端产品"竞争的设计——而是验证"用户/外部 Agent 如何与 MemexCore 交互"各个切面的垫脚石。规划新功能时，优先问"这块拼图将来能拼进端到端产品的哪个位置"，而不是孤立评估。当前阶段范围仍按下方既定阶段执行，不提前新建"端到端产品"组件（见 `[[project_memex_final_product_is_hermes_like_e2e]]`）。

## 01-discuss

Domain model finalization, terminology alignment, RFC ratification.

## 02-plan

Architecture planning, data model design, API contracts, ADRs.

## 03-execute

Implementation: PostgreSQL schema, event bus, agent runtime, hash chain.

## 04-external-integrations

MCP gateway, Claude Code + Pi Terminal connect CLI, distributed locking, memory crystallization. ✅ Complete.

## 05-provider-safety

Multi-provider LLM abstraction (Anthropic adapter), CommandGate safety module, agentskills.io skill export, webhook notification delivery.

## 06-extensions

MCP client (inbound tool consumption), execute_bash MCP tool, messaging gateway (Telegram + Discord), UserProfileWorker, cryptographic agent pairing, graph inspection TUI.
