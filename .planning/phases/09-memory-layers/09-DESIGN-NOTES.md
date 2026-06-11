# Phase 9: Memory Layers — 设计笔记（标本对比分析）

**来源：** nanobot vs hermes-agent 对比分析会话，2026-06-10
**状态：** 预规划输入 — 供 `/gsd:discuss-phase 09` / `gsd-planner` 消化，尚未转化为 D-xx 决策
**关联：** `.harness/ROADMAP.md` 09-memory-layers 章节、ROADMAP "未来架构改进方向（Phase 7+）" item #6（CrystallizeWorker 外科式蒸馏）

---

## 背景

对比了两个标本项目在"长期记忆管理"上的实现路径：

- **nanobot**（hermes-agent 前身 prototype）：单一硬编码 `MemoryStore`（`agent/memory.py`）—— `SOUL.md`/`USER.md`/`memory/MEMORY.md`/`memory/history.jsonl`，cursor-based append-only history，由受保护的 "Dream" cron job 周期性触发一个受限工具集的 LLM session 来重写这些文件；另有独立的 `Consolidator` 做 token 预算触发的会话级摘要。
- **hermes-agent**（成熟版）：抽象成 `MemoryProvider` ABC 插件接口，8 个可选后端（holographic/mem0/honcho/hindsight/openviking/supermemory/byterover/retaindb）。holographic provider 暴露两层工具：`memory`（始终在 context 中的轻量记忆）vs `fact_store`（深度结构化记忆，`probe`/`related`/`reason`/`contradict` 等图遍历式查询动作）。

**核心结论：两者的记忆系统都是"外挂在无状态 agent 循环上的文件/DB补丁"，执行历史与记忆存储是两套分裂的系统。Memex 的 Trail Mesh 天然就是记忆基底——这是结构性优势，Phase 9 实现时必须保住这个优势，不能退化成"图之外再加一层文件式记忆"。**

---

## 与 Phase 9 直接相关的差异化设计点

### 1. Lesson = 已经是"两层记忆"的上层，不需要再抽象 Provider

hermes 的 `memory`(轻量常驻) vs `fact_store`(深度结构化) 两层划分，在 Memex 中已经天然对应：

- **Lesson**（Crystallization 产物，confidence-weighted）≈ hermes 的 `memory` 工具——常驻、轻量、高置信度
- **Episodic/Semantic/Procedural 表的全量查询**（BM25+HNSW）≈ hermes 的 `fact_store`——深度、按需、组合检索

→ Phase 9 不需要引入 `MemoryProvider` 式的可插拔后端抽象。这是 hermes 为了支持第三方记忆产品（mem0等）做的横向扩展，Memex 没有这个需求；引入会增加一层不必要的间接性，违反 CLAUDE.md "Simplicity First"。

### 2. 借鉴 holographic 的查询动作语义命名

holographic provider 的 `fact_store` 暴露 `probe`(实体全量回忆) / `related`(结构邻接) / `reason`(多实体交集组合查询) / `contradict`(矛盾检测) / `update`/`remove`/`list`。这些本质上都是图遍历操作，且命名对 LLM 很直觉。

→ Phase 9 的检索接口（`mem::reflect` / Reflection Track 触发接口，ADR-21）设计查询动作时，可以参考这套**面向LLM的语义命名**，而不是泛化的 `query(filter)`。例如 Semantic Memory 的"找到与多个实体同时关联的事实"对应 `reason`，"找结构邻接"对应 `related`。

### 3. `contradict` 检测 → Semantic Memory supersession 的触发条件之一

hermes holographic 的 `contradict` action 专门用于记忆卫生：扫描已存事实之间的矛盾声明。

→ Phase 9 的 `semantic_memory` supersession chain（`superseded_by` 自引用外键）目前的触发条件是"相似度 > 0.89 → 建议合并"。应该补充第二条触发路径：**矛盾检测**——新写入的语义记忆与已有记忆在事实层面冲突（而非仅仅相似）时，同样应触发 supersession 流程而不是任由两者共存。这与"相似度合并"是互补的两种 supersession 触发器：
- 相似度高 → 合并/精炼（refinement）
- 矛盾 → 取代（contradiction-driven supersession）

具体检测机制（LLM判断 vs embedding距离的某种组合）留给 Phase 9 规划阶段决定。

### 4. CrystallizeWorker 外科式蒸馏（已在 ROADMAP item #6，Phase 10 落地）—— Phase 9 应预留接口

ROADMAP "未来架构改进方向" item #6 已经记录了这一点（同一 `fingerprint_id` 强化时注入 `existing_lesson_content`，输出 delta 而非全量重写），并安排在 Phase 10。

→ **Phase 9 的关联点**：`semantic_memory`/`procedural_memory` 表结构设计时，应确保"获取某条记忆当前内容"是一个轻量、明确的查询路径（而不需要遍历整条 supersession chain 拼接），这样 Phase 10 的"注入 existing_lesson_content"才能高效实现。这是个**表结构前向兼容性**要求，不是新功能。

### 5. 时间触发 vs 事件触发——Phase 9 检索路径应保持事件驱动

nanobot 的 Dream 是 cron 时间触发；hermes 的 `Consolidator` 是 token 预算触发。两者都不是"因果事件触发"。

→ Memex 现有设计（`scope_closed` 触发 Episodic 写入，Phase 08 预留的 `onContextCompressed` 等 pipeline hooks 触发 Reflection Track）已经是事件驱动，**这是相对两个标本的结构性优势，Phase 9 规划时不要引入额外的"定时扫描"机制替代事件触发**——除非是 Phase 10 的 Ebbinghaus 30天衰减扫描这类必须周期性运行的维护任务（那是另一类问题，时间触发在那里是合理的）。

---

## 与其他阶段相关的差异化点（交叉引用，非 Phase 9 范围）

以下几点在对比分析中浮现，但更贴近其他阶段，记录于此供后续阶段规划时检索：

- **执行权限/沙箱边界作为图事件**：每次 `WorkspaceScope` 切换（restricted↔full）应作为 Trail Mesh 上的 Association 记录，便于 Crystallization 学习"这类任务总需要 full access"。→ 关联 `execute_bash`/McpClientWorker 类 Worker，Phase 6 已交付的范围之外的后续加固。
- **跨渠道身份归一化用 Entity 别名关系表达**：hermes 用硬编码规则（如 WhatsApp 别名展开）解决"同一用户多个渠道ID"问题；Memex 可以用图上 Entity 的多 Snapshot/别名 Association 表达，并由 Trail Discovery 统计发现。→ 关联 MemexShell 多渠道阶段（晚于 Phase 10）。
- **定时任务作为图 Entity，执行历史并入 Trail Mesh**：若 Memex 未来实现 cron/定时任务，应让"定时触发的 turn"和"手动触发的 turn"用同一套 Trail 记录，而不是像 nanobot/hermes 那样维护独立的 `action.jsonl`/`output/{job_id}/`。→ 尚无对应阶段，记录备查。
- **环境变量两段式过滤（黑名单挡密钥+白名单放行）**：hermes `code_execution_tool.py` 的 `_SECRET_SUBSTRINGS` + `_SAFE_ENV_PREFIXES` 模式，是 `execute_bash` 类工具的低成本加固项。→ 关联 Phase 6 `execute_bash`，可作为独立的小型安全加固任务。

---

## 不采纳的点

- **不引入 `MemoryProvider` 式可插拔后端抽象**（见上文第1点）——YAGNI，Memex 没有"支持第三方记忆产品"的需求。
- **不引入 Ebbinghaus 之外的"trust score"静态信任分**（mem0/holographic 的做法）——Memex 的 confidence-weighted reinforcement（Phase 10）已经覆盖同等需求，且是动态的，比静态 trust score 更优。
