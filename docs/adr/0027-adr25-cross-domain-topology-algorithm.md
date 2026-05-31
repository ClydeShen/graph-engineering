# ADR 25｜跨域拓扑模式发现算法：WL 图核 + 拓扑嵌入

status: accepted  
日期: 2026-06-01

---

## 上下文

本系统的核心价值承诺是**跨域拓扑发现**：在表面上毫无关联的任务（调试代码、规划研究、设计文档）中识别出相同的底层认知拓扑（如 `explore → hypothesize → validate → converge`），并将其作为可复用的执行模式。

当前 ADR（01-23）只定义了**单 Scope 内**的模板提炼（TemplateProposalWorker，RFC §7.1-7.2）：从一个已关闭的 Scope 的 DAG 中提取低冲突路径，写入 `procedural_memory`。

但这只解决了"**记住这个 Scope 的经验**"，没有解决"**识别不同 Scope 中相似的结构**"。现有 `procedural_memory.intent_embedding` 做的是语义相似（意图文本向量），而非结构相似。两个意图完全不同的 Scope 可能有完全一样的执行拓扑——这是当前架构盲区。

---

## 决策

### 算法选型：Weisfeiler-Lehman (WL) 图核

**选择 WL 图核而非替代方案的原因**：

| 方案 | 适用性 | 问题 |
|------|--------|------|
| 图同构（Graph Isomorphism） | 精确匹配 | NP-complete；执行图不同节点数，直接同构无意义 |
| GNN 嵌入（GraphSAGE/GIN） | 语义+结构 | 需要训练数据、大量基础设施；Phase 1 无法实现 |
| 事件序列 LCS | 简单 | 丢失 DAG 分支结构，将树展平为线 |
| WL 图核 | **结构相似性** | **O(n×d)，无需训练，天然支持 DAG，有大量图 ML 文献验证** |
| 特征向量（手工特征） | 粗粒度 | 深度/分支度无法捕捉局部拓扑差异 |

**WL 图核原理**：

1. **标签初始化**：以 `event_type` 作为节点初始标签（忽略 payload 语义内容，只保留拓扑结构）
2. **迭代聚合**（h 轮，h=3 for Phase 1）：
   ```
   new_label[v] = hash(old_label[v] + sorted(old_label[neighbors(v)]))
   ```
3. **特征向量**：统计所有迭代中每个标签出现的次数，得到一个直方图向量
4. **相似度**：两个 Scope 的拓扑相似度 = 其 WL 特征向量的余弦相似度

**示例**（event_type = {p=plan, t=task, m=memory, c=conflict}）：

```
Scope A（代码调试）：p → t → m → t → c → m(convergence) → t → m → close
Scope B（研究规划）：p → t → m → t → c → m(convergence) → t → m → close

WL 特征向量几乎相同 → 余弦相似度 ≈ 1.0 → 跨域拓扑命中
```

---

### 存储与 Schema

**在 `procedural_memory` 中新增字段**（Phase 1 schema stub）：

```sql
ALTER TABLE procedural_memory
  ADD COLUMN topology_embedding vector(64),     -- WL 核特征向量（64 维）
  ADD COLUMN topology_wl_depth  SMALLINT NOT NULL DEFAULT 3;
                                                -- WL 迭代深度，用于版本对齐

CREATE INDEX idx_procedural_topology_hnsw
  ON procedural_memory
  USING hnsw (topology_embedding vector_cosine_ops)
  WITH (m=8, ef_construction=32)
  WHERE topology_embedding IS NOT NULL;
```

`topology_embedding` 初始可为 NULL（允许 Phase 1 逐步填充），HNSW 索引使用部分索引跳过 NULL 行。

---

### Phase 1：TemplateProposalWorker 扩展

在现有 TemplateProposalWorker（`scope_closed` 后触发）中追加拓扑嵌入计算：

```typescript
// 伪代码：WL 核计算
function computeWLEmbedding(templateGraph: DAG, depth: number = 3): Float32Array {
  const histogram = new Map<string, number>();
  
  let labels = new Map(templateGraph.nodes.map(n => [n.id, n.event_type]));
  
  for (let iter = 0; iter < depth; iter++) {
    const newLabels = new Map<string, string>();
    for (const node of templateGraph.nodes) {
      const neighborLabels = templateGraph.edges
        .filter(e => e.target === node.id)
        .map(e => labels.get(e.source)!)
        .sort();
      const hash = sha256(`${labels.get(node.id)}|${neighborLabels.join(',')}`);
      newLabels.set(node.id, hash);
      histogram.set(hash, (histogram.get(hash) ?? 0) + 1);
    }
    labels = newLabels;
  }
  
  // 将 histogram 投影到固定 64 维向量（模 64 取桶）
  const vec = new Float32Array(64);
  for (const [hash, count] of histogram) {
    const bucket = parseInt(hash.slice(0, 4), 16) % 64;
    vec[bucket] += count;
  }
  
  // L2 归一化
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / (norm || 1));
}
```

该计算在 TemplateProposalWorker 的 Node.js 进程内完成（无额外服务），结果作为 `topology_embedding` 写入 `procedural_memory`。

---

### Phase 2：CrossScopePatternDiscoveryWorker（延期）

Phase 2 新增定期任务（每日一次，iii-cron worker）：

1. **查询候选对**：
   ```sql
   -- 找出 topology_embedding 余弦相似度 > 0.90 的跨域模板对
   SELECT a.id AS id_a, b.id AS id_b,
          1 - (a.topology_embedding <=> b.topology_embedding) AS cos_sim
   FROM procedural_memory a
   JOIN procedural_memory b ON a.id < b.id
   WHERE a.topology_embedding IS NOT NULL
     AND b.topology_embedding IS NOT NULL
     AND a.intent_embedding <=> b.intent_embedding > 0.5  -- 语义不同（距离大）
     AND a.topology_embedding <=> b.topology_embedding < 0.10  -- 但拓扑相似（距离小）
   ```
   `意图语义差但拓扑相似` = 跨域同构模式

2. **写入聚类标记**：
   ```sql
   ALTER TABLE procedural_memory
     ADD COLUMN cross_domain_cluster_id UUID;
   ```
   将相似模板打上同一 `cluster_id`，供冷启动骨架拍入时跨域推荐。

3. **冷启动升级**（Phase 2）：冷启动骨架拍入时，除匹配 `intent_embedding` 相似模板外，还检查 `cross_domain_cluster_id` 相同但 `intent` 不同的模板——这些跨域模板在意图层是"陌生人"，但在拓扑层是"同行者"，提供更激进的骨架建议。

---

## 拒绝的方案

### GNN 嵌入（GraphSAGE / GIN）

- 需要大量标注训练数据（系统 Phase 1 数据量不足）
- 需要 Python 推理服务，引入异构技术栈
- WL 图核在图分类任务上的效果与 GNN 相当（Xu et al. 2019，"How Powerful are Graph Neural Networks?"）
- 可在 Phase 4+ 升级到 GNN，接口不变（只需替换嵌入计算函数）

### 纯拓扑哈希

- `sha256(sorted_event_types + structural_stats)` 只能做精确匹配
- 无法识别"近似相同"的拓扑（多一个 task_spawned 就完全不同）
- WL 特征向量的余弦相似度天然支持模糊匹配

---

## 后果

**Phase 1（实现 schema stub + TemplateProposalWorker 扩展）**：
- `procedural_memory` 新增 `topology_embedding vector(64)` 字段（NULLABLE，不阻塞现有功能）
- 每个新模板自动计算 WL 拓扑嵌入，为 Phase 2 发现奠定数据基础
- 无新服务依赖，计算在 TemplateProposalWorker 进程内完成

**Phase 2（CrossScopePatternDiscoveryWorker）**：
- 系统首次实现项目核心价值承诺：自动识别跨域相似执行拓扑
- 冷启动骨架拍入扩展为跨域推荐，完成"越用越聪明"的完整闭环

---

## 关联 ADR

- **ADR 17** — pgvector 原子写入：`topology_embedding` 在 TemplateProposalWorker 的 Writable CTE 内与其他字段原子写入
- **ADR 20** — 四层记忆物理架构：`procedural_memory` schema 扩展
- **ADR 07/RFC §7.1-7.2** — TemplateProposalWorker：本 ADR 在其 `scope_closed` 触发流程后追加拓扑嵌入计算步骤
