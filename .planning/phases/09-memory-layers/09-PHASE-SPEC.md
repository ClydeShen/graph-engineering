# Phase 09: memory-layers — Phase Spec

**写入：** 2026-06-11
**用途：** 固化本阶段的 DoD 验收门与前向铺路契约。规划已完成（4 plans，checker PASS），本文档不重开已定决策（见 `09-CONTEXT.md` D-01~D-13），只补充执行验收与跨阶段契约。
**基线：** `.harness/ROADMAP.md` §09-memory-layers + 技术债轨道 TD-A；`09-CONTEXT.md`；ADR-43 D-4。

---

## 1. 目标与定位

激活三层休眠记忆（Episodic / Semantic / Procedural）的写入与混合检索路径。本阶段是 Phase 10 Trail Discovery 的**语料生产线**——Phase 10 的全部价值建立在本阶段产出的记忆行之上，因此写入路径的**数据质量约束**（embedding 非空、provenance 非空、事件可溯源）比功能数量更重要。

## 2. 设计要点（已定，列出供执行时对照）

- 决策集：`09-CONTEXT.md` D-01~D-13（TPW 替换 EpisodicMemoryWorker、全量 DAG 读取、inline embedding、suggestedMerge 不自动 supersede、cold_start 唯一触发、shouldReflect opt-out）。
- ADR-43 D-4：migration 012 含三表 `source_scope_id` + `erased_at`（已验证在 09-01-PLAN）。
- 事件驱动不变量（09-DESIGN-NOTES §5）：所有写入由 `scope_closed` / pipeline hooks 触发，**不引入任何定时扫描**。
- 不引入 `MemoryProvider` 抽象（09-DESIGN-NOTES §1，YAGNI 已拍板）。

## 3. 范围 Spec

**In scope：** migration 012；TemplateProposalWorker（episodic 写入 + orphan 负样本）；SemanticMemoryWorker supersession hint；`mem::reflect`（cold_start）+ assemble.ts/processAgentTurn 生产路径接线；EpisodicMemoryWorker 删除与触发清理。

**Out of scope（已显式排除，规划后续阶段时不回填到 09）：**
- 矛盾驱动 supersession、`conflict_detected`/`macro_planning` 触发、Ebbinghaus 闭环、正样本骨架提取 → Phase 10
- 加密、erase 工作流（ADR-43 D-2 第二步）→ Phase 14
- `probe`/`related`/`reason` 命名查询动作 → Phase 10+ 的 LLM tool 层

## 4. DoR（已满足，记录备查）

- [x] Phase 08 DoD：pipeline hooks（`onContextAssembled` / `PipelineContext`）在生产路径
- [x] ADR-43 accepted（commit 19199ca9），D-4 约束进入 09-01-PLAN
- [x] 4 plans 经 checker 验证 PASS；wave 顺序：01 → 02+03 并行 → 04
- [x] ADR-20/21 补充规范归档（RRF SQL 模板、reflect 触发规格）

## 5. DoD — 完成定义（可观测门）

执行完成 ≠ 任务打勾，以下每条是可独立验证的门：

| # | 门 | 验证方式 |
|---|---|---|
| G1 | migration 012 应用后，三表均有 `source_scope_id`+`erased_at`，episodic 有 `embedding vector(1536)`+HNSW，procedural 有负样本部分 HNSW | `\d` 检查 + migration 测试 |
| G2 | `EpisodicMemoryWorker` 源文件与触发注册已删除，TPW 是唯一 episodic 写入方 | grep 无残留引用；boot 注册表无旧 worker |
| G3 | 每条新 episodic/semantic/procedural 行：embedding 非空、`source_scope_id` 非空、伴随 `memory_updated` 事件（C1 约束） | 写入路径测试断言三者 |
| G4 | `insertSemanticFact` 相似度 >0.89 返回 `suggestedMerge`；supersede 后旧行退出检索空间（部分 HNSW `WHERE superseded_by IS NULL` 生效）且 `valid_until` 被触发器自动盖章 | 边界测试（0.89 上下各一例） |
| G5 | cold_start 触发 `mem::reflect`：无 episodic 记录的新 Scope 注入 `[REFLECTION MEMORY]` 分区，预算 ≤ `min(2000, W_max×0.3)`，顺序贪心截断 Procedural>Episodic>Semantic | reflect.function 测试 + 预算断言 |
| G6 | 生产路径接线：`processAgentTurn` 真实走 reflect（非仅测试桩）；`shouldReflect()=false` 的 Worker 可证明跳过 | 集成测试 |
| G7 | 全量测试通过（≥255 基线不退化）+ tsc 零错误 | CI |
| G8 | implementation-notes.md 记录所有偏离；`.harness/state.json` checkpoint 与最后 commit 同步 | 人工核对 |

## 6. 前向铺路契约（本阶段为后续做什么）

Phase 10 直接消费以下产物，执行时**不可偷工**：

1. **负样本语料开始积累**：orphan 检测从本阶段起每个 `scope_closed` 都在跑——Phase 10 的反面注入需要非空语料。若 orphan 判定（dead-end LEFT JOIN）有误报，Phase 10 的反模式质量直接被污染，宁可漏报不可误报。
2. **"当前内容"轻量查询路径**（09-DESIGN-NOTES §4）：获取某条记忆的现行内容必须是单查询（不遍历 supersession 链拼接）——Phase 10 外科式蒸馏的 `existing_lesson_content` 注入依赖此路径。G4 验收时一并确认。
3. **`mem::reflect` 触发类型可扩展**：`trigger_type` 是枚举入参而非硬编码分支——Phase 10 加 `conflict_detected`/`macro_planning` 时只加 case，不改函数签名。
4. **`reflect` 内部检索函数命名**：`searchEpisodic/searchSemantic/searchProcedural` 分立（非单一大 SQL）——Phase 10+ 把它们暴露为 LLM tool 动作时无需重构。
5. **migration 012 的 provenance 列**是 Phase 14 erase 级联的全部结构前提——D-4 之后 Phase 14 不再触碰这三张表的 DDL。

## 7. 风险与开放问题

- **嵌入维度锁定**：`vector(1536)` 一旦上线不可改（同 ADR-25 vector(128) 教训）。当前 EmbeddingProvider 默认模型输出 1536 维——若用户换 embedding 模型（如本地 768 维），需要重建列。记录在案，不阻塞：维度换型是 Phase 15 profiles 的已知边界，写入 doctor 检查项即可。
- **TPW 的 LLM 成本**：每个 scope_closed 一次全 DAG 读取 + LLM 蒸馏。大 Scope（>50 事件）的蒸馏输入应经 Knapsack/截断，不可全文直送——执行 02-PLAN 时确认输入有上界。

---
*Phase 链：08（DoD 已满足）→ **09** → 10（消费本阶段语料与接口）*
