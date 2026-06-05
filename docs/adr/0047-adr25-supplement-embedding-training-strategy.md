# ADR 25 Supplement｜Topology Embedding Training Strategy for `topology_embedding vector(128)`

status: accepted
日期: 2026-06-05
supplements: ADR 25 (跨域拓扑模式发现算法：WL 图核 + 拓扑嵌入)

---

## 上下文

ADR 25 定义了 WL 图核算法（h=3 迭代，128 维特征向量）和 `procedural_memory.topology_embedding vector(128)` 的 schema。但以下内容未定义：

1. **训练集构建**：如何为嵌入质量评估构建正/负样本集
2. **评估指标**：如何量化 WL 嵌入的跨域检索质量
3. **增量更新协议**：新 Scope 的嵌入如何在不重训的前提下并入

本补充 ADR 填补上述三项。

---

## 决策

### 1. 维度冻结声明

> **`topology_embedding vector(128)` 的维度一旦 schema 部署即永久冻结。**
> 
> 变更维度（e.g., 128 → 256）需要：(1) 新迁移文件删除旧列并添加新列，(2) 重新计算所有现有记录的嵌入，(3) 重建 HNSW 索引。
> 
> **在此明确宣告：128 维是 Phase 1+ 的锁定维度，不得在未完成上述三步迁移的情况下修改。**

`topology_wl_depth` 字段（存储 h 值）记录当前嵌入使用的 WL 迭代深度（Phase 1 = 3）。若 h 变更，与维度变更同等处理——需全量重算。

---

### 2. 训练集构建

WL 图核是**确定性算法**（无梯度下降，无模型参数）。"训练"在此语境下指：

a. **历史填充**：对 `topology_embedding IS NULL` 的已有 `procedural_memory` 记录补算嵌入
b. **评估对构建**：从已有记录中抽取已知拓扑等价的 Scope 对，作为评估正样本

**历史填充步骤**：

1. 从 `procedural_memory` 查询所有 `topology_embedding IS NULL` 且 `template_graph IS NOT NULL` 的记录
2. 对每条记录的 `template_graph` 执行 WL 核计算（ADR 25 伪代码），生成 128 维向量
3. 批量 UPDATE，每批 100 条，事务内提交
4. 完成后记录日志：`Backfill complete: {N} records updated`

最小可评估数据量：≥ 20 条 `procedural_memory` 记录（低于此数量的相似性结果统计意义不足）。

**正样本对构建**（手工或半自动）：

- 方法 A（人工标注）：选取人工确认拓扑等价的 Scope 对（e.g., 两个都遵循 `explore → hypothesize → validate → converge` 的 Scope，无论领域）
- 方法 B（阈值自举）：以 `cos_sim > 0.90` 的现有候选对作为弱监督正样本（无人工标注，仅用于粗粒度基线对比）

Phase 2 评估使用方法 B（自举），Phase 3+ 可引入方法 A 精标数据。

**负样本策略**：

从 `procedural_memory` 中随机采样满足以下条件的 Scope 对作为负样本：
- `intent_embedding <=> intent_embedding > 0.5`（语义上不相似）
- `topology_embedding <=> topology_embedding > 0.5`（拓扑上也不相似）

此约束防止将真实的跨域同构对错误归为负样本。

---

### 3. 评估指标

**主指标**：MRR（Mean Reciprocal Rank）和 Hits@10

| 指标 | 计算方式 | 期望值（Phase 2 基线） |
|------|----------|----------------------|
| MRR | 对每个 query Scope，找其在余弦近邻排名中的真正等价对的位次，取所有 query 的倒数均值 | ≥ 0.60（随机基线 ≈ 0.05 for 20 scopes） |
| Hits@10 | 真实等价对出现在 top-10 余弦近邻中的比例 | ≥ 0.80 |

**评估查询**（使用 pgvector HNSW 索引）：

```sql
-- 对给定 query_id，找前 10 个余弦最近邻（排除自身）
SELECT b.id,
       1 - (a.topology_embedding <=> b.topology_embedding) AS cos_sim
FROM procedural_memory a
JOIN procedural_memory b ON a.id != b.id
WHERE a.id = $1
  AND a.topology_embedding IS NOT NULL
  AND b.topology_embedding IS NOT NULL
  AND b.is_anti_pattern = FALSE
ORDER BY a.topology_embedding <=> b.topology_embedding
LIMIT 10;
```

**基线比较**：
- 随机检索（不使用嵌入）的 MRR ≈ `1 / N_records`
- 仅用 `intent_embedding` 检索的 MRR（语义基线）

评估结果写入日志文件（`wl-embedding-eval-{date}.json`），不写入数据库。

---

### 4. 增量更新协议

WL 核是**无状态计算**：新 Scope 的嵌入无需访问历史记录，仅依赖当前 Scope 的 DAG。

**标准流程**（每个 `scope_closed` 触发）：

1. TemplateProposalWorker 从 `execution_event_log` 读取 Scope DAG
2. 执行 WL 核计算（h=3，ADR 25 算法），生成 128 维向量
3. 在同一 Writable CTE 事务中写入 `procedural_memory.topology_embedding`
4. HNSW 索引自动更新（pgvector 增量维护）

**无需批量重训**：WL 核是确定性的局部计算，新记录的嵌入与历史记录完全独立，不需要"看过"历史数据。

**唯一需要全量重算的场景**：
- WL 迭代深度 `h` 变更（`topology_wl_depth` 变化）
- 维度变更（前文已定义为需完整迁移）
- ADR 25 算法的标签规范（`event_type` 映射）发生变化

---

## 后果

- WL 嵌入质量可量化：MRR / Hits@10 提供可比较的基线
- 历史填充脚本确保 Phase 1 存量数据不丢失
- 增量更新无额外开销（已在 TemplateProposalWorker 热路径内）
- `vector(128)` 维度冻结声明防止无意识的 schema 漂移

---

## 关联 ADR

- **ADR 25** — WL 图核算法和 `topology_embedding` schema（本补充的宿主 ADR）
- **ADR 17** — pgvector 原子写入（Writable CTE 内写入 topology_embedding）
- **ADR 20** — 四层记忆架构（`procedural_memory` 宿主表）
- **Phase 3 Plan 03-02** — CrossScopePatternDiscoveryWorker（消费 topology_embedding 做跨域聚类）
