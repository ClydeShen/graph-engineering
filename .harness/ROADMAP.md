# Roadmap

## 北极星（愿景级，非阶段）

**最终产品形态：基于 MemexCore 构建一个 Hermes-agent 级别的端到端系统**——用户多次确认这是长期目标（2026-06-08）。Hermes 在这里是"交互模式与产品形态"的参照对象，不是要照搬其实现。

### MemexOS 三层架构（2026-06-09 锁定）

| 层 | 名称 | 内容 | 状态 |
|---|---|---|---|
| 产品品牌 | **MemexOS** | MemexCore + MemexShell 合称，不是独立代码层 | 命名锁定 |
| 核心运行时 | **MemexCore** | iii-engine、PostgreSQL 账本、Workers、Control Plane、Gateway HTTP（含 MCP server） | 现存，相对稳定 |
| 交互与集成层 | **MemexShell** | MemexTerminal、Dashboard 前端、onboarding TUI、packages/cli、packages/pi-extension | 后期主战场 |

**MemexShell 设计原则**：Shell 不拥有状态，所有状态在 Core 的 Graph 里。Shell 是 Gateway REST API 的纯客户端。Shell 变，Core 不动。

**如何应用**：规划新功能时优先问"这属于 MemexCore 的 API 扩展，还是 MemexShell 的新组件"。当前各阶段（05/06）仍聚焦 MemexCore 扩展，MemexShell 主体（MemexTerminal、Dashboard）是后续阶段。

### MemexShell 已确认组件

- **MemexTerminal**：内置默认 TUI，用 Pi SDK 构建（`createAgentSession` + `subscribe`）；调 Gateway REST API；安装后自动启动。Pi SDK 是实现技术，不是身份标签。与外部 Pi Terminal（MCP peer agent）语义完全不同。
- **Dashboard**：独立前端，Gateway REST 轮询（历史快照，非实时流）；图可视化（workflow 涌现、节点详情）在 Dashboard 而非 MemexTerminal。
- **Onboarding TUI**（`@clack/prompts`）：首次安装引导，配置 LLM provider；写入独立 config 文件（非 graph，非 .env）；与 ADR-22 worker 侧 `LLMProvider` 是不同层面，通过 config 文件衔接。
- **packages/cli**（connect 工具）、**packages/pi-extension**（外部 Pi Terminal 集成 artifact）。

### MCP Inspector（开发测试工具，非产品组件）

`npx @modelcontextprotocol/inspector` 用于 MCP server 完整测试，不是 MemexShell 组件。

## 01-discuss

Domain model finalization, terminology alignment, RFC ratification.

## 02-plan

Architecture planning, data model design, API contracts, ADRs.

## 03-execute

Implementation: PostgreSQL schema, event bus, agent runtime, hash chain.

## 04-external-integrations

MCP gateway, Claude Code + Pi Terminal connect CLI, distributed locking, memory crystallization. ✅ Complete.

## 04-plugs（Phase 5 前置）

Phase 5 执行前的结构性补丁：LLM provider 抽象层 SOLID 重构（`LLMApi` / `LLMProviderConfig` / `createLLMProvider()`，Pi SDK 命名对齐）+ Phase 5 T2 CommandGate 完整 54 pattern 参考（含 hermes→graph-runtime 适配）+ Phase 5 T3 阈值穿越检测 AC 修正。见 `.harness/phases/04-plugs/04-plugs-PLAN.md`。

## 05-provider-safety

Multi-provider LLM abstraction (Anthropic adapter), CommandGate safety module, agentskills.io skill export, webhook notification delivery.

## 06-extensions

MCP client (inbound tool consumption), execute_bash MCP tool, messaging gateway (Telegram + Discord), UserProfileWorker, cryptographic agent pairing. ⚠️ T6 "graph inspection TUI" 已重新定位：graph 可视化属于 MemexShell Dashboard（非独立 TUI）；MemexTerminal 是唯一 TUI 入口，属于后续 MemexShell 阶段，不在 Phase 6 范围。

---

## 未来架构改进方向（Phase 7+，待转化为 ADR / Phase Plan）

> 来源：nanobot 对比分析 + 用户确认（2026-06-09）。以下各项尚未安排具体阶段，规划时需写 ADR 或 phase plan。

### 1. LLM Provider 多提供商注册表（ADR-22 扩展）

**现状：** `OpenAICompatibleProvider` 已覆盖 Ollama / vLLM / DeepSeek / LM Studio 等 OpenAI 兼容接口。`AnthropicProvider` Phase 5 T1 补充。

**待规划：**
- **Provider 注册表**：通过 config 文件声明多个 provider（id、type、apiBase、apiKey）；Worker 按 `LLM_PROVIDER` 名称查找，不需要修改代码即可切换。参考：nanobot `providers/registry.py` 模式。
- **FallbackProvider（电路熔断）**：主 provider 失败后自动切换。错误分类：`timeout / rate_limit / overloaded` → failover；`auth / context_length / content_filter` → 直接报错不 failover。参考：nanobot `fallback_provider.py`。
- **本地 LLM 一等支持**：Ollama / vLLM / LM Studio 明确文档化配置路径（`apiBase` 指向本地端口）。

### 2. WebSocket / SSE 实时 API（新 ADR 待写）

**现状：** Gateway 是纯 REST。Dashboard 使用 REST polling（历史快照）。

**待决策：**
- MemexTerminal 实时 agent event stream（tool_execution_start、text_delta）需要 WebSocket 或 SSE。
- Dashboard 实时推送（新 Trail 写入通知）同上。
- 两者可以共用一个 event stream endpoint，也可以分开。
- 参考：nanobot WebSocket channel（`channels/websocket/` → `/ws` 端点，WebUI 直连）。
- **影响：** Gateway package 加 WS handler；Shell 层订阅方式确定后，Dashboard 和 MemexTerminal 都受益。

### 3. Types 集中管理（架构决策待写）

**现状：** 类型定义分散在各 package（`@graph/shared`、`@graph/gateway`、`@graph/workers`）。

**待规划：**
- 新建 `packages/types`（`@graph/types`）：Core 类型（`Entity`、`HyperEdge`、`Scope`、`Lesson`、`Trail`）集中定义，其他 package 只 import，不重新定义。
- **三层分工：**
  - `@graph/types/core`：iii-engine / Ledger 层类型（不依赖任何 package）
  - `@graph/types/api`：Gateway REST + WebSocket contract types（request / response schema）
  - `@graph/types/shell`：MemexShell 消费类型（Dashboard state、MemexTerminal session）
- **Pi SDK 对齐：** `packages/pi-extension` 和 MemexTerminal 的类型继承 Pi SDK 官方 `AgentSession`、`ToolResult`、`Message` 等 interface，不重新定义等价类型。Gateway REST response shapes 设计时参考 Pi SDK 期望的输入格式。

### 4. 全局 config.json（配置层分层设计待写）

**现状：** `iii-config.yaml` 只覆盖 Core 层（Worker LLMProvider 注入、iii-engine 配置）。

**待规划：**
- 系统级 `~/.memex/config.json`（参考 nanobot `~/.nanobot/config.json`）：
  - Gateway 端口、TLS 设置
  - Channel tokens（Telegram、Discord）
  - LLM provider 注册表（apiKey 通过 `${ENV_VAR}` 引用，不硬编码）
  - Dashboard 和 MemexTerminal 连接地址
  - WebSocket 开关
- **配置层分工（锁定）：**
  - `iii-config.yaml` → MemexCore：Worker LLMProvider 注入、iii-engine 参数
  - `~/.memex/config.json` → 全系统：Shell + Gateway + channel + provider 注册表
- **env var 引用：** `"apiKey": "${ANTHROPIC_API_KEY}"` 在 startup 时从环境变量解析，解析值不写回磁盘。

### 5. SKILL.md 生态兼容扩展（Phase 5 T3 基础）

Phase 5 T3 已加入 `requires.bins / requires.env / always` frontmatter 字段（nanobot 格式）。

**后续扩展：**
- **Progressive loading**：Dashboard / MemexTerminal 展示技能列表时，先加载 `name + description`，按需获取全文（减少 token 消耗）。参考：nanobot `build_skills_summary()` + `load_skills_for_context()` 两阶段策略。
- **ClawHub 格式兼容**：agentskills.io 和 ClawHub 两个 registry 共享同一 frontmatter schema，导出的 SKILL.md 可直接发布到任一 registry。

### 6. CrystallizeWorker "外科式蒸馏"原则（nanobot Dream 借鉴）

**参考：** nanobot Dream 的设计哲学——不重写整个记忆文件，而是做"最小诚实变更"。

**待应用：** 同一 `fingerprint_id` 的 Lesson 多次强化（Ebbinghaus reinforcement）时，CrystallizeWorker 的 LLM prompt 应识别已有 Lesson 内容，只追加新 insight，不重复已有要点。避免每次强化都覆盖全文。实现方式：prompt 中注入 `existing_lesson_content`，要求 LLM 输出 delta 而非全量重写。

---

## 08-context-assembly

**目标：** 将 Knapsack Slicing（ADR-13）从规格落地为可运行代码，并补充 CCR 可逆压缩路径，替代 ADR-13 补充中 Level-3 的"熔断挂起"硬截断。

**背景：** ADR-13 规定了 Knapsack Slicing 算法的规格（前驱哈希链 + token 预算裁剪），但目前系统没有任何实现——Worker 获取的 context 是未经裁剪的完整链路。随着 Scope 增长，这将成为 OOM 和 LLM 性能的主要瓶颈。

### 核心交付物

1. **Knapsack Slicing 算法实现**（`@graph/workers` 上下文组装层）
   - 沿前驱哈希链逆向追溯，按 token 权重（recency × importance）装包
   - 重要性分层：`conflict_detected` / `scope_closed` 节点权重最高；稳定的 `memory_updated` 序列可聚合
   - 参考：headroom `SmartCrusher` 的变点检测（`change_points`）+ 常量提取策略（`headroom/transforms/smart_crusher.py`）

2. **CCR 可逆压缩路径**（ADR-13 Level-3 的替代方案）
   - 当前驱链超出 W_max 时，不直接熔断挂起，而是压缩低优先级节点并缓存原始内容
   - Worker 的 system prompt 注入检索工具：`memex_retrieve(hash)` —— Worker 认为需要完整数据时主动调用
   - CCR hash 作为 `_meta` 字段写入 context，不污染图账本
   - 参考：headroom `ccr/tool_injection.py`、`ccr/response_handler.py`

3. **Wasm Tokenizer 集成**（ADR-15）
   - `@dqbd/tiktoken` 精确 token 计数用于 Knapsack 装包决策和 CCR 触发阈值
   - 复用已有 tokenizer 基础设施，补充 `countTokens(node)` 工具函数

4. **Pipeline lifecycle hooks**（Worker 扩展点）
   - 参考 headroom `hooks.py` 的 `on_pipeline_event(stage, data)` 模式
   - 定义 Worker 生命周期的可观测事件点：`context_assembled`、`context_compressed`、`llm_called`、`result_written`
   - 为 Phase 09 的记忆注入（Reflection Track）预留插槽

**与现有 ADR 的关系：** ADR-13 + ADR-13 补充（CCR 替代 Level-3）；ADR-15（Wasm Tokenizer）；ADR-22（LLM 调用接口）。

**前置条件：** Phase 07-architecture 完成（MemoryRepository seam、graph-handle 整合已就位）。

---

## 09-memory-layers

**目标：** 实现四层记忆中尚未落地的三层：Episodic、Semantic、Procedural。Working Memory（`execution_event_log`）已在 Phase 03 完成，本阶段补齐剩余三层及其检索路径。

**背景：** RFC §8 定义了四层记忆的完整架构，但 Phase 03–07 仅实现了 Working Memory。CrystallizeWorker 和 LessonSaveWorker 已在 Phase 04 完成，但 Episodic / Semantic / Procedural 三张表尚未创建，Lesson 只写入了占位表。

### 核心交付物

1. **Episodic Memory 写入**（`scope_closed` 触发）
   - `episodic_memory` 表：HNSW 向量索引 + 时序索引
   - TemplateProposalWorker 雏形：读取 Scope 完整 DAG → 提取意图摘要 + 结果摘要 → 写入 episodic

2. **Semantic Memory + supersession chains**
   - `semantic_memory` 表：`superseded_by` 自引用外键 + 部分 HNSW 索引（`WHERE superseded_by IS NULL`）
   - `supersede()` 操作：新版本写入时链接旧版本，旧版本从检索空间排除（不物理删除）
   - LLM 触发合并 hint：相似度 > 0.89 时返回"建议合并"而非强制覆盖
   - 参考：headroom `memory/` 的 supersession 实现细节（`valid_from` / `valid_until` 时间戳对）

3. **Procedural Memory 基础**（`is_anti_pattern` 双 HNSW 分区）
   - `procedural_memory` 表：正负样本双独立 HNSW 部分索引
   - 基础写入路径：TemplateProposalWorker 提取骨架写正样本，orphan node 写负样本

4. **BM25 + HNSW RRF 混合检索**（ADR-20 规格落地）
   - `ts_doc` GIN 全文索引 + `pgvector` HNSW 余弦相似度
   - Reciprocal Rank Fusion（RRF k=60）合并两路结果
   - Reflection Track 触发接口（`mem::reflect`，ADR-21 规格）

**与现有 ADR 的关系：** ADR-20（混合检索）；ADR-21（Reflection Track 触发规格）；ADR-22（Embedding Provider）。

**前置条件：** Phase 08-context-assembly 完成（Pipeline lifecycle hooks 中 Reflection Track 插槽已预留）。

---

## 10-trail-discovery

**目标：** 实现 Trail Discovery（工作流涌现）——从历史 Scope 中自动提取可复用的执行模式，写入 Procedural Memory，使系统"越用越聪明"。同时完成 Ebbinghaus reinforcement 闭环和 CrystallizeWorker 外科式蒸馏优化。

**背景：** 这是 Memex 最核心的差异化能力。Phase 09 完成了 Procedural Memory 的基础写入，Phase 10 建立完整的涌现闭环：正负样本 → 骨架模板 → 冷启动注入 → 强化/衰减 → 蒸馏更新。

### 核心交付物

1. **TemplateProposalWorker（完整版）**
   - 被 `scope_closed` 触发，启动独立 Context Window
   - **正样本**：识别低冲突、短耗时收敛路径 → 提取抽象接口边骨架 → 写 `procedural_memory(is_anti_pattern=FALSE)`
   - **负样本（success correlation）**：追溯 orphan node 之后的收敛路径 → "失败→修正"因果对打包 → 写 `is_anti_pattern=TRUE`
   - 参考：headroom `cli/learn.py` 的 success correlation 逻辑（失败后做了什么修正才成功）

2. **Skeleton Graph 冷启动注入**
   - 新 Scope 冷启动时：嵌入向量 → Top-20 ANN → 三信号重排 → 拍入黄金骨架
   - 反面程序记忆并行注入 System Prompt（"禁止重蹈的坑"）

3. **PatternDiscoveryWorker**（ADR-25 跨域拓扑算法）
   - 定期扫描 Trail Mesh，提取跨 Scope 的通用拓扑结构
   - 更新 `semantic_memory` 跨域知识（如 "explore → hypothesize → validate → converge" 普适模式）

4. **Ebbinghaus reinforcement 闭环**
   - `success_count` / `reinforcement_count` 更新路径：Scope 再次命中某 Lesson → `+1` → 检索权重提升
   - 30 天衰减周期：`last_used_at` 配合衰减扫描（`graph::memory::decay` 定时触发）
   - **反馈驱动调参**：参考 headroom `compression_feedback.py` 的 `retrieval_rate → suggested_items` 模式，将 Lesson 的命中率映射到 Knapsack 中的 token 分配权重

5. **CrystallizeWorker 外科式蒸馏**（ROADMAP Phase 7+ item #6 落地）
   - 同一 `fingerprint_id` 多次强化时，prompt 注入 `existing_lesson_content`
   - LLM 输出 delta 而非全量重写，避免每次强化覆盖已有要点

**与现有 ADR 的关系：** ADR-25（跨域拓扑算法）；ADR-39（Pattern Discovery 调度）；ADR-36（Knowledge Entity 写时机）。

**前置条件：** Phase 09-memory-layers 完成（Episodic + Procedural 表已就位，BM25+HNSW 检索可用）。
