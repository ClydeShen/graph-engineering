# Phase 10: trail-discovery — Phase Spec

**写入：** 2026-06-11
**用途：** `/gsd:discuss-phase 10` 与 planner 的前置输入——划定范围、就绪条件、验收门、前向契约。
**基线：** `.harness/ROADMAP.md` §10-trail-discovery + 技术债轨道 TD-B/C/D；`09-DESIGN-NOTES.md` 交叉引用项；ADR-25/39/36/11/20。

---

## 1. 目标与定位

建立完整涌现闭环：正负样本 → 骨架模板 → 冷启动注入 → 强化/衰减 → 外科式蒸馏。这是 Memex 唯一不可替代的差异化能力——Phase 16 的产品验收指标（Trail Discovery 命中率、Lesson 留存率）全部在本阶段埋点。**本阶段的隐形主题是"可测量"：每个闭环环节必须留下可统计的计数器，否则 1.0 验收无据可依。**

## 2. 设计要点（规划前必须消化）

### 2a. `template_graph` 结构化格式（TD-C，本阶段第一个要拍板的决策）

现状：ADR-25 定义了 `topology_embedding vector(128)`（WL 图核），但 `template_graph` JSONB 是非结构化 LLM 散文。**必须在 TemplateProposalWorker 完整版动工前锁定 edge-list schema**：

```json
{ "nodes": [{"id": "n1", "label": "<event_type>"}],
  "edges": [{"from": "n1", "to": "n2"}],
  "abstraction_level": "interface-edge" }
```

约束：两次对同构 DAG 的提取必须机器可比对（节点按 event_type 标签规范排序后 JSON 相等或图同构判定可计算）。LLM prompt 输出受此 schema 约束（JSON mode / schema validation），不接受散文。写入 ADR-25 第二补充。

### 2b. 强化闭环的三条时间线（区分清楚，别混成一个 worker）

| 环节 | 触发 | 内容 |
|---|---|---|
| 强化 | 事件驱动：Scope 命中 Lesson/模板 | `success_count+1`, `last_used_at=NOW()`（P1-D SQL） |
| 归纳 | 双触发：每日 02:00 cron + ≥20 条新 episodic | Memory Synthesizer 跨 Scope 归纳 → semantic（P2-D） |
| 衰减 | 每日 03:00 cron | `reinforcement_count=0 AND last_used_at<NOW()-'90d'` → 逻辑删除（P2-E） |

cron 类维护任务是 09-DESIGN-NOTES §5 事件驱动不变量的**合法例外**（维护性周期任务），用 iii-cron 7 字段格式。

### 2c. 外科式蒸馏（ROADMAP item #6）

同一 `fingerprint_id` 强化时 prompt 注入 `existing_lesson_content`（走 Phase 09 铺好的"当前内容"轻量查询），LLM 输出 **delta**。验收要点：蒸馏后旧要点仍在（非覆盖）。

### 2d. 矛盾驱动 supersession（09 显式推迟项）

第二条 supersession 触发路径：新语义记忆与既有记忆**事实矛盾**（非仅相似）→ 取代。检测机制（LLM 判断 vs embedding 距离组合）在 discuss 阶段定，倾向：相似度 0.7~0.89 区间 + LLM 二分判断（>0.89 走相似合并，<0.7 视为无关，区间内才花 LLM 调用——控制成本）。

### 2e. 反馈驱动调参（headroom 方向）

Lesson 命中率 → Knapsack token 分配权重的映射。**注意**：[[token-budget 设计已结案]]——这里只做"命中率计数 + 权重微调"，不重开预算配置体系。

### 2f. TD-B 去重窗口

`SHA256(scope_id|entity_id|event_type|payload_hash)` + 5 分钟窗口（不含 predecessor_hash），拦截不同前驱下的语义重复工具调用。写入位置：Working Memory 写入路径（occ-write 之前的应用层检查）。写 ADR-11 补充。

## 3. 范围 Spec

**In scope：**
1. TemplateProposalWorker 完整版（正样本骨架提取 + WL topology_embedding 计算 + success correlation 负样本打包）
2. Skeleton Graph 冷启动注入（Top-20 ANN → 三信号重排 → 黄金骨架 + 反模式入 system prompt）
3. PatternDiscoveryWorker（ADR-25 跨域拓扑，定期扫描）
4. Ebbinghaus 闭环（强化/归纳/衰减三条时间线，§2b）
5. CrystallizeWorker 外科式蒸馏（§2c）
6. `conflict_detected` + `macro_planning` reflect 触发接线（09 推迟项）
7. 矛盾驱动 supersession（§2d）
8. TD-B 去重窗口；TD-D 文档归档（ADR-11/20/25 补充）
9. **指标埋点**：模板命中/采纳计数、Lesson 强化计数、注入后 Scope 收敛耗时——存图（事件），不建独立 metrics 表

**Out of scope：**
- 跨 agent Lesson 可见性域 → Phase 13（但见 §6.3 列预留评估）
- G1 遍历代数（Cayley 式查询语言）→ post-1.0；PatternDiscoveryWorker 用 WL 嵌入 + 固定 SQL 模板够用
- CCR 持久化存储 → 仅当 reflect 实测需要跨调用检索才做（08 deferred 项，默认不做）
- 模板的人工管理 UI → Phase 11 Dashboard

## 4. DoR — 进入规划的就绪条件

- [ ] Phase 09 DoD G1–G8 全过（语料生产线在跑）
- [ ] 测试语料就绪：≥20 个真实或合成 Scope（含成功收敛、orphan、conflict 三类）——没有语料，骨架提取与命中率验收无从谈起。可用 UAT journey 脚本批量生成
- [ ] `template_graph` schema（§2a）在 discuss 阶段第一个议题拍板，ADR-25 第二补充成文后才能写 TPW 完整版 plan
- [ ] iii-cron worker 可用性复核（Round 2 已确认，执行前 smoke test）

## 5. DoD — 完成定义（可观测门）

| # | 门 | 验证方式 |
|---|---|---|
| G1 | 对两个同构 DAG（不同 scope_id、相同拓扑）运行 TPW，产出的 `template_graph` 机器判同 | 同构夹具测试 |
| G2 | 冷启动注入端到端：新 Scope 嵌入 → ANN → 重排 → system prompt 含黄金骨架与反模式分区，token 占用在 ADR-21 预算内 | 集成测试 + 预算断言 |
| G3 | 强化路径：Scope 命中模板 → `success_count+1`；衰减路径：构造 91 天前夹具 → 扫描后逻辑删除且退出检索 | 单测 + 时钟夹具 |
| G4 | 外科式蒸馏：对已有 Lesson 二次强化，旧要点全部保留 + 新 insight 追加（diff 断言） | 蒸馏 delta 测试 |
| G5 | 矛盾 supersession：构造事实矛盾对 → 触发取代；相似但不矛盾对 → 仅建议合并 | 双夹具测试 |
| G6 | TD-B：同一工具调用 5 分钟内不同前驱重放 → 第二次被拦截；5 分钟外 → 正常写入 | 窗口边界测试 |
| G7 | 指标可查询：从图中能 SQL 读出"过去 N 个 Scope 的模板命中率"——Phase 16 eval 的数据通路打通 | 指标查询测试 |
| G8 | ADR-11/20/25 补充归档（TD-D 清账）；全量测试 + tsc 通过；implementation-notes 更新 | CI + 人工核对 |

## 6. 前向铺路契约

1. **Phase 11 Dashboard 的读路径**：模板/Lesson/命中指标的查询应封装为 `MemoryRepository`/`TrailReader` 的方法（而非散落 SQL），Phase 11 Gateway REST 直接包装这些方法成 endpoint，不重写查询。
2. **Phase 16 eval 数据通路**（G7）：命中率指标从本阶段开始积累——1.0 验收要"指标不退化"，基线越早建立越有说服力。
3. **Phase 13 可见性域预评估**：Lesson/procedural 行是否预留 `visibility TEXT NOT NULL DEFAULT 'global'` 列？按值变更/类型变更原则：加列 + 默认值回填是廉价迁移，**不预留**；但 CrystallizeWorker 的写入函数签名留 options 参数位，Phase 13 加 `visibility` 时不破坏调用方。discuss 阶段确认。
4. **PatternDiscoveryWorker 的扫描接口**：输入是"时间窗口内的 Scope 集合"——Phase 13 跨 agent 模式发现复用同一扫描器，只是 Scope 集合的过滤条件变化。扫描器与过滤条件解耦。

## 7. 风险与开放问题

- **LLM 成本集中营**：TPW 完整版 + 矛盾检测 + 外科蒸馏全是 LLM 调用。规划时给每条路径标注调用次数上界（如矛盾检测仅在 0.7~0.89 相似度区间触发）；蒸馏输入沿用 09 的截断约束。
- **WL 嵌入质量未经验证**：vector(128) WL 图核是 stub 实现升级——ADR-25 supplement 的 MRR/Hits@10 评估协议本阶段第一次真正运行，可能发现嵌入区分度不足。这是研究风险，留 buffer，不要把冷启动注入的验收建立在"嵌入必须完美"上（三信号重排里 quality/recency 可以兜底）。
- **success correlation 的因果误判**：「失败→修正」配对靠时序邻接推断，可能配错。负样本写入加 `correlation_confidence` 字段（low/high），注入时只用 high。

---
*Phase 链：09（语料 + reflect 接口）→ **10** → 11（Dashboard 消费读路径）→ 16（eval 指标基线）*
