# ADR 25 Supplement 2｜template_graph 结构化 Schema 与规范化判同（TD-C）

status: accepted
日期: 2026-06-11
supplements: ADR 25（跨域拓扑模式发现算法）；ADR 25 Supplement（0047，嵌入训练策略）

---

## 上下文

ADR 25 定义了 WL 图核与 `topology_embedding vector(128)`，但 `template_graph JSONB` 的内容格式从未规范——现状是三种互不兼容的产物：

1. MemorySynthesizerWorker 输出 `{steps: string[]}`（LLM 散文步骤列表）
2. TemplateProposalWorker 负样本输出 `{orphan_entity_id, scope_id}`（调试信息）
3. ProceduralMemoryWorker 透传 synthesizer 的合成线性链

后果：两次对**同构 DAG** 的提取产出字面不同的 JSON，模式涌现的可验证性为零——Phase 16 的"Trail Discovery 命中率"指标无法成立（技术债 TD-C / 追踪表 G2）。

## 决策

### D-1：规范 Schema（edge-list，version 1）

```json
{
  "version": 1,
  "abstraction": "interface-edge",
  "nodes": [{ "id": "n0", "label": "<event_type>" }],
  "edges": [{ "from": "n0", "to": "n1" }],
  "correlation_confidence": "high | low"   // 仅负样本行，可选
}
```

- 节点语义只保留 `event_type` 标签（拓扑高于内容，ADR 25 原则）
- `abstraction: "interface-edge"`：连续同标签线性段折叠为单节点——骨架记录的是**类型转换结构**，不是事件计数
- `correlation_confidence`：success-correlation 负样本的"失败→修正"配对置信度；注入路径跳过 `low`

### D-2：规范化（canonicalization）规则

实现：`packages/workers/src/memory/template-graph.ts`

1. **构图**：每事件一节点（label = event_type），predecessor_hash 在 Scope 内解析为边
2. **折叠**：边 u→v 且 label 相同、出度(u)=1、入度(v)=1 → 合并，迭代至不动点
3. **WL 标签精化**（3 轮，双向邻居）排序节点 → 规范 id `n0..nK` → 边按 (from,to) 排序
4. **判同**：`JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))`

**性质**：同构 DAG（不同 UUID、不同输入顺序）规范化后 JSON 字面相等——机器可比对（DoD G1 测试覆盖）。

**已知边界**：WL 精化无法区分某些对称节点对（WL 不可区分性）。真自同构节点任意指派产出相同边集，判同仍成立；WL 等价但非自同构的病态图可能误判不等——执行 DAG 实践中不出现，接受此边界（完整 canonical labeling 是 GI-hard）。

### D-3：LLM 输出受 schema 约束

TemplateProposalWorker / Synthesizer 产出 template_graph 时**不接受 LLM 散文**——图由代码从事件 DAG 确定性构建，LLM 只产出 `intent_description` 等文本字段。这比"约束 LLM 输出 JSON schema"更强：拓扑提取完全无 LLM，零幻觉面。

### D-4：注入与采纳指标（强化闭环的度量面）

- `procedural_memory.injection_count`（migration 013）：reflect 注入即 +1
- `template_injection(scope_id, template_id, trigger_type)` 关联表：Scope 关闭收敛后 TemplateProposalWorker 据此 `success_count +1`（P1-D SQL 的调用方，强化闭环至此闭合）
- 命中率 = `sum(success_count) / sum(injection_count)`——Phase 16 eval 的数据通路

**偏离 PHASE-SPEC 的说明**：spec 原文"指标存图（事件）"。实测约束：账本 OCC 槽位唯一性为 `(predecessor_hash, scope_id)`（ADR 41），中途写指标事件会挤占 agent 的 predecessor 槽位、将 agent 下一次写入降级为 conflict_detected——伪冲突污染 Trail。改用计数列 + 关联表，指标仍可 SQL 查询，不碰账本链。

### D-5：三信号重排落地口径

ADR 20 补充展示的四信号 SQL 引用了幽灵列 `unique_worker_types`（从未建列）。落地按追踪表 P0-B 原始决策执行**三信号**：

```
final_score = rrf_norm × 0.6 + quality × 0.3 + recency × 0.1
quality  = (success_count + 1) / (success_count + failure_count + 1)
recency  = max(0, 1 − days_since_last_used / 30)
rrf_norm = rrf_score / max(rrf_score) over 候选池   -- 量纲归一，原始 RRF ≈0.01 级别会被 quality 淹没
```

diversity 信号随 `unique_worker_types` 列一并搁置——若 Phase 13 多 agent 拓扑出现单链保守化实证，再评估建列。

## 后果

- 同构判同可测 → Trail Discovery 命中率指标成立（Phase 16 前提）
- 拓扑提取零 LLM 依赖 → 确定性、零成本、无幻觉
- synthesizer 的 `{steps}` 线性链产物被 TPW 的真实 DAG 骨架取代为主路径（synthesizer 保留为跨 Scope 归纳的次路径）
- 旧格式存量行（`{steps}`/`{orphan_entity_id}`）不迁移——WL 嵌入仍可检索；规范化判同只对 version:1 行有意义

## 关联

ADR 25（宿主）；ADR 41（OCC 槽位——D-4 偏离的依据）；ADR 20 补充（重排公式宿主）；migration 013；Phase 10 DoD G1/G7。
