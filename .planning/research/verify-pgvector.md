# pgvector 设计主张验证报告

**验证日期：** 2026-05-31
**研究者：** Research Agent
**数据源：** Context7 `/pgvector/pgvector`（pgvector 官方 README，Source Reputation: High），OpenAI 官方 Embeddings 文档
**ADR 文件：** `docs/ADR_v4.md`（已读取第 238–453 行）

---

## 总体判定摘要

| 主张 | 判定 | 影响 |
|------|------|------|
| 主张 1：cosine distance 范围 0–2，公式 `1.0 - distance / 2.0` 正确 | **VERIFIED** | ADR 20 公式无需修正 |
| 主张 2：HNSW 支持 partial index（WHERE 条件） | **VERIFIED** | ADR 17 / ADR 20 索引 DDL 合法 |
| 主张 3：HNSW 参数 m=16, ef_construction=64 适用性 | **VERIFIED with annotation** | 参数是 pgvector 默认值，合理；`ef_search` 默认 40 未在 ADR 中提及，需补充 |
| 主张 4：pgvector 无法下推过滤器，CTE pre-filter 是正确模式 | **PARTIAL** | 基本成立，但 pgvector 0.8.0 引入的 `iterative_scan` 改变了推荐做法，ADR 17 描述部分过时 |
| 主张 5：vector(1536) 是 text-embedding-3-small 的正确维度 | **VERIFIED with annotation** | 1536 是正确默认维度；但与 ada-002 相同，需区分；若改用 Claude 则无官方 embedding API |

---

## 主张 1：cosine distance 范围 0–2，公式正确性

### 判定：VERIFIED

### 证据

**来源：Context7 `/pgvector/pgvector`（官方 README）**

pgvector 文档明确定义 `<=>` 算子的语义和范围：

> "Cosine Distance, denoted by the `<=>` operator, measures the angle between two vectors, **ranging from 0 for identical directions to 2 for opposite directions**. It is equivalent to 1 minus the cosine similarity."

**具体示例（官方 README）：**
```sql
SELECT cosine_distance('[1,2]'::vector, '[2,4]'::vector);  -- 0    （同方向）
SELECT cosine_distance('[1,0]'::vector, '[0,1]'::vector);  -- 1    （正交）
SELECT cosine_distance('[1,1]'::vector, '[-1,-1]'::vector); -- 2   （完全相反）
```

**`<=>` 返回的是 cosine distance，不是 cosine similarity：**
```sql
-- 正确用法：从 distance 转换为 similarity
SELECT 1 - (embedding <=> '[3,1,2]') AS cosine_similarity FROM items;
```

cosine distance = 1 − cosine_similarity，其中 cosine_similarity ∈ [−1, 1]，因此：
- cosine_distance ∈ [0, 2]
- 0 = 完全相同方向
- 1 = 正交
- 2 = 完全相反

### ADR 20 公式验证

```sql
(1.0 - distance / 2.0) * 0.6
```

将 distance（范围 0–2）映射到 0–1 的 similarity，再乘以权重 0.6：
- distance = 0 → similarity = 1.0 → 贡献 0.6（最高分）
- distance = 1 → similarity = 0.5 → 贡献 0.3
- distance = 2 → similarity = 0.0 → 贡献 0.0

**公式在数学上完全正确。ADR 20 无需修正。**

### 需要注意的边界条件

cosine distance 的范围假设向量已归一化或使用浮点精度无误的情况下成立。如果存储向量时未归一化，`<=>` 仍然能正确计算角度（pgvector 内部处理），但若直接用 `cosine_distance()` 函数和 `<=>` 算子，结果完全等价，范围均为 0–2。

---

## 主张 2：HNSW 支持 partial index（WHERE 条件）

### 判定：VERIFIED

### 证据

**来源：Context7 `/pgvector/pgvector`（官方 README，直接引用）**

```sql
-- 官方 README 示例
CREATE INDEX ON items USING hnsw (embedding vector_l2_ops) WHERE (category_id = 123);
```

文档标题明确为："**Create Partial HNSW Index**"，描述为：

> "Create a partial HNSW index that only includes rows matching a specific condition, useful for filtering by a few distinct values."

### ADR 中的索引 DDL 合法性验证

ADR 20 中的以下两个索引定义均合法：

```sql
-- semantic_memory：仅对未被取代的版本建索引
CREATE INDEX idx_semantic_active_vector_hnsw ON semantic_memory
USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)
WHERE superseded_by IS NULL;

-- procedural_memory：仅对非反模式模板建索引
CREATE INDEX idx_procedural_intent_hnsw ON procedural_memory
USING hnsw (intent_embedding vector_cosine_ops) WITH (m=16, ef_construction=64)
WHERE is_anti_pattern = FALSE;
```

这两个 partial index 的 WHERE 条件均为 pgvector HNSW 支持的语法。

### 重要语义说明

Partial index 的作用是**减少索引大小、提升索引构建速度**，但查询时 WHERE 条件的行为需要理解：

- 当查询包含与索引 WHERE 相同的条件（如 `WHERE superseded_by IS NULL`），PostgreSQL 优化器会直接使用 partial index 进行 ANN 扫描，效果等同于只在活跃行上做向量检索。
- 这正是 ADR 20 的预期效果：降低噪声，只检索活跃知识。

**DDL 无需修正。**

---

## 主张 3：HNSW 参数 m=16, ef_construction=64 适用性

### 判定：VERIFIED with annotation

### 证据

**来源：Context7 `/pgvector/pgvector`（官方 README）**

官方文档明确列出的默认值：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `m` | 16 | 每层最大连接数（max connections per layer） |
| `ef_construction` | 64 | 构建时动态候选列表大小（dynamic candidate list size during build） |
| `hnsw.ef_search` | **40** | 查询时动态候选列表大小（query-time, SET 级别参数） |

ADR 20 使用的 `m=16, ef_construction=64` 恰好是 pgvector 的**内置默认值**，因此即使不写 `WITH (m=16, ef_construction=64)`，行为完全相同。

### 参数适用性评估（数百到数万条记录）

对于 procedural/semantic/episodic memory 的典型规模（数百到数万条）：

- `m=16`：适合通用场景。较低的 m 值（如 8）可加速构建但降低召回率，较高的 m 值（如 32）提升召回但增加内存。16 是合理平衡点。
- `ef_construction=64`：适合中小规模。对于数千条记录，64 已经能获得良好的图质量。对于数万条且要求高召回率（>99%），可考虑提升到 128。
- 对于 `vector(1536)` 维度：高维向量会增加内存占用（每条记录约 6KB 的 1536 维 float32 向量），但不影响 HNSW 算法逻辑正确性。

**参数选择合理，无需修正。**

### 需要补充到 ADR 的内容：ef_search 未提及

**ADR 17 和 ADR 20 均未提及 `hnsw.ef_search` 参数。**

官方文档说明：

> "Query performance for HNSW can be tuned by setting `hnsw.ef_search`, which controls the size of the dynamic candidate list during search (default 40). A larger value enhances recall at the expense of query speed."

**建议在 ADR 20 的查询规范中补充：**
```sql
-- 当过滤条件命中行数较少时，提升召回率
SET hnsw.ef_search = 100;  -- 默认 40，数百条规模建议设为 80–200
```

---

## 主张 4：pgvector 无法下推过滤器，CTE pre-filter 是正确模式

### 判定：PARTIAL

### 核心发现

ADR 17 原文："pgvector 无法将过滤器下推到向量索引扫描层" —— 这个描述在技术上是准确的，**但自 pgvector 0.8.0 起，官方引入了 `iterative_scan` 作为更优的替代方案**，ADR 17 对现状的描述已部分过时。

### 证据

**来源：Context7 `/pgvector/pgvector`（官方 README）**

**关于过滤器行为（确认 ADR 17 的基础假设）：**

> "With approximate indexes, **filtering is applied after the index is scanned**." 

即：HNSW 索引先扫描 k 个近邻候选，再应用 WHERE 条件过滤，而非在索引扫描内部进行过滤。这确认了"无法下推"的说法。

**关于 pgvector 0.8.0 新增的 iterative_scan：**

> "Iterative index scans, available from version **0.8.0**, improve query recall for approximate indexes by scanning more of the index until sufficient results are found, up to configured limits like `hnsw.max_scan_tuples` or `ivfflat.max_probes`."

官方推荐的 filtered ANN 方案（来自官方 README）：

```sql
-- 方案 A：提升 ef_search（手动调参）
SET hnsw.ef_search = 200;
SELECT id FROM documents WHERE category_id = 7
ORDER BY embedding <-> '[0.1,0.2,0.3]' LIMIT 5;

-- 方案 B：iterative_scan（0.8.0+，自动扩展扫描范围）
SET hnsw.iterative_scan = strict_order;
SELECT id FROM documents WHERE category_id = 7
ORDER BY embedding <-> '[0.1,0.2,0.3]' LIMIT 5;
RESET hnsw.iterative_scan;
```

### ADR 17 CTE pre-filter 模式评估

ADR 17 强制要求的查询模式：

```sql
WITH candidates AS (
  SELECT entity_id, version_hash, event_type, payload, embedding
  FROM execution_event_log
  WHERE scope_id = $scope_id
    AND event_type != 'conflict_detected'
)
SELECT entity_id, version_hash, payload,
       embedding <=> $query_embedding AS distance
FROM candidates
ORDER BY distance
LIMIT 10;
```

**该模式的本质是全表精确扫描（exact search），不是 ANN。** CTE 先按 scope_id 过滤出所有候选行，再在候选集上做向量距离排序。

这意味着：
1. **不使用 HNSW 索引**：因为 CTE 先将候选行物化到内存，之后的 `ORDER BY distance` 是对物化结果的线性扫描
2. **在 scope 内候选数量小时完全合理**：如果一个 scope 有数百行，线性扫描成本可接受
3. **若 scope 有数万行时会成为瓶颈**：此时 iterative_scan 是更优选择

### 对 ADR 17 的影响

ADR 17 的核心决策（防止双写窗口，向量与事件原子落盘）**完全正确，无需修正**。

但以下描述需要更新：
- 原文："pgvector 无法将过滤器下推到向量索引扫描层" —— 这个技术限制依然存在，但 0.8.0 的 `iterative_scan` 提供了更好的缓解手段
- 原文的 CTE pre-filter 是合法的精确检索方案，适合中小规模 scope；对大规模 scope 需考虑 `iterative_scan`

**建议补充到 ADR 17 的脚注或附录：**
```sql
-- pgvector 0.8.0+ 大规模 scope 的替代查询方案
SET hnsw.iterative_scan = strict_order;
SELECT entity_id, version_hash, payload,
       embedding <=> $query_embedding AS distance
FROM execution_event_log
WHERE scope_id = $scope_id
  AND event_type != 'conflict_detected'
ORDER BY embedding <=> $query_embedding
LIMIT 10;
RESET hnsw.iterative_scan;
```

---

## 主张 5：vector(1536) 是 text-embedding-3-small 的正确维度

### 判定：VERIFIED with annotation

### 证据

**来源：OpenAI 官方 Embeddings 文档（https://developers.openai.com/api/docs/guides/embeddings）**

| 模型 | 默认维度 | 可否降维 |
|------|----------|----------|
| `text-embedding-ada-002` | 1536 | 不支持（固定） |
| `text-embedding-3-small` | **1536**（默认） | 支持（via `dimensions` 参数） |
| `text-embedding-3-large` | 3072（默认） | 支持（可降至 256 仍超越 ada-002） |

**text-embedding-3-small 默认输出 1536 维，与 ada-002 相同。** ADR 20 的 `vector(1536)` 对 text-embedding-3-small 是正确的。

### 澄清：1536 不是仅属于 ada-002 的维度

两个模型均默认输出 1536 维。text-embedding-3-small 的优势是：
- 可通过 `dimensions` API 参数降维（如 512、1024）以节省存储
- 相同维度下，准确率优于 ada-002
- 价格是 ada-002 的 1/5

ADR 20 使用 `vector(1536)` 是正确的，无需修正。

### 关于 Claude/Anthropic Embedding

**如果项目使用 Claude API（Anthropic），需要注意：**

> Anthropic 目前没有官方的 Embedding API。[ASSUMED — 基于截至 2025 年 8 月的训练数据，需用户确认]

如果项目需要使用 Claude 而非 OpenAI，需要选择第三方 embedding 方案，例如：
- Cohere embed-v3（英文 1024 维，多语言 1024 维）
- Voyage AI voyage-3（1024 维，推荐用于 RAG）

此情况下 `vector(1536)` 需要相应调整。

---

## ADR 修正建议汇总

### 无需修正

- **ADR 20 评分公式** `(1.0 - distance / 2.0) * 0.6`：数学正确，cosine distance 范围 0–2 已验证
- **ADR 20 HNSW partial index DDL**：`WHERE superseded_by IS NULL` 和 `WHERE is_anti_pattern = FALSE` 均合法
- **ADR 20 HNSW 参数** `m=16, ef_construction=64`：即 pgvector 默认值，无需修改
- **ADR 20 向量维度** `vector(1536)`：对 text-embedding-3-small 正确

### 建议补充（非破坏性）

**补充 1：ADR 20 —— 补充 ef_search 参数说明**

在查询规范 SQL 注释中或文字说明中增加：

```sql
-- 查询时默认 ef_search=40，当候选集较小（<100条）时建议提升
-- SET hnsw.ef_search = 100;  -- 示例值，按实际数据量调整
```

**补充 2：ADR 17 —— 更新技术背景说明**

将原文：
> "pgvector 无法将过滤器下推到向量索引扫描层"

更新为：
> "pgvector 在 0.8.0 前无法将过滤器下推到向量索引扫描层，过滤在索引扫描后执行。0.8.0 引入 `hnsw.iterative_scan` 可缓解该问题，但对中小规模 scope，CTE pre-filter 精确扫描方案仍为首选（召回率 100%）。"

**补充 3：ADR 17 —— 大规模 scope 的替代查询方案（可选脚注）**

对于 scope 内行数超过 10,000 条的情况，考虑使用 `iterative_scan` 替代当前的全候选集线性扫描。

---

## 置信度评估

| 主张 | 置信度 | 数据来源 |
|------|--------|----------|
| 主张 1（cosine distance 范围） | **HIGH** | Context7 官方 README，含直接代码示例 |
| 主张 2（HNSW partial index） | **HIGH** | Context7 官方 README，明确标题 "Create Partial HNSW Index" |
| 主张 3（HNSW 参数） | **HIGH** | Context7 官方 README，列出默认值 |
| 主张 4（过滤器下推） | **HIGH** | Context7 官方 README，含 0.8.0 版本说明 |
| 主张 5（embedding 维度） | **HIGH** | OpenAI 官方 Embeddings 文档直接确认 |
| Anthropic 无官方 Embedding API | **[ASSUMED]** | 训练数据截止 2025-08，需用户确认 |

---

## 参考来源

### Primary（HIGH 置信度）
- Context7 `/pgvector/pgvector` — [https://github.com/pgvector/pgvector/blob/master/README.md](https://github.com/pgvector/pgvector/blob/master/README.md)
  - 查询："cosine distance range operator returns distance or similarity"
  - 查询："HNSW partial index WHERE clause filtered search pre-filtering"
  - 查询："HNSW parameters m ef_construction ef_search performance tuning"
  - 查询："filter pushdown CTE pre-filter iterative scan version 0.8"

### Secondary（HIGH-MEDIUM 置信度）
- OpenAI 官方 Embeddings 文档 — [https://developers.openai.com/api/docs/guides/embeddings](https://developers.openai.com/api/docs/guides/embeddings)
  - text-embedding-3-small 默认维度确认

### Tertiary（MEDIUM 置信度，交叉验证）
- Zilliz FAQ — text-embedding-ada-002 vs text-embedding-3 模型维度对比
- OpenAI 官方公告 — [https://openai.com/index/new-embedding-models-and-api-updates/](https://openai.com/index/new-embedding-models-and-api-updates/)
