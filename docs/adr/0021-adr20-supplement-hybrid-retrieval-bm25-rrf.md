# ADR 20 补充：三张记忆表混合检索规范（tsvector BM25 + pgvector RRF）

status: accepted

ADR 20 原始版本中三张记忆表（episodic/semantic/procedural）仅定义了 pgvector HNSW 向量检索轨道，缺少 BM25 文本检索轨道。交叉验证 agentmemory 后确认：纯向量检索对关键词精确匹配（错误代码、实体名称、API 名）存在系统性盲区，BM25 是必要补充。

选择 PostgreSQL 原生 `tsvector + ts_rank_cd` 而非 `pg_bm25`（ParadeDB）：语料规模（万到十万级）下排序差异在 RRF 融合后不可感知，且无需引入任何外部数据库扩展，保持 SSOT 纯洁性。BM25 文本列与 pgvector embedding 列在同一 Writable CTE 事务内原子写入，继承 ADR 17 哲学。

---

## Schema 补充（三张表统一追加 tsvector 列）

```sql
-- episodic_memory
ALTER TABLE episodic_memory
  ADD COLUMN ts_doc tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(intent_summary, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(outcome_summary, '')), 'B')
    ) STORED;
CREATE INDEX idx_episodic_ts ON episodic_memory USING GIN (ts_doc);

-- semantic_memory
ALTER TABLE semantic_memory
  ADD COLUMN ts_doc tsvector
    GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(fact_text, ''))
    ) STORED;
CREATE INDEX idx_semantic_ts ON semantic_memory USING GIN (ts_doc)
  WHERE superseded_by IS NULL;   -- 与 HNSW 部分索引边界对齐

-- procedural_memory（正负样本各自独立）
ALTER TABLE procedural_memory
  ADD COLUMN ts_doc tsvector
    GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(intent_description, ''))
    ) STORED;
CREATE INDEX idx_procedural_ts_positive ON procedural_memory USING GIN (ts_doc)
  WHERE is_anti_pattern = FALSE;
CREATE INDEX idx_procedural_ts_negative ON procedural_memory USING GIN (ts_doc)
  WHERE is_anti_pattern = TRUE;
```

> 使用 `'simple'` 配置（不做词干化）而非 `'english'`，原因：记忆内容混合中英文及专有名词，词干化会损坏技术术语的精确匹配。
>
> **已知限制（CJK，Phase 1 接受）**：`simple` 不做 CJK unigram 切分。对于无空格中文文本，`to_tsvector('simple', ...)` 将整段字符串视为单一 token，BM25 路对中文内容静默失效（`ts_doc @@ query` 返回空集），RRF 融合退化为纯向量路。**Phase 1 显式接受此退化**，在 Chinese-heavy 场景下 BM25 贡献为零，召回率等同纯 HNSW 向量检索。Phase 3+ 计划引入 `zhparser`（PostgreSQL 扩展，`to_tsvector('zhparser', ...)`）或等效 CJK 分词方案修复此限制，无需改动 RRF 公式或索引结构。

---

## 混合检索 RRF 公式（直接采用 agentmemory K=60）

```
RRF_score = 0.6 × (1 / (60 + vector_rank))
           + 0.4 × (1 / (60 + bm25_rank))
```

权重来源：agentmemory `HybridSearch` 默认值（vector=0.6, bm25=0.4），在双流系统中归一化后保持此比例。K=60 为标准 RRF 常数，消除头部排名的量纲放大效应。

---

## 标准混合检索查询模板（以 episodic_memory 为例，三张表同构）

```sql
WITH
-- 第一路：向量检索（HNSW ANN Top-20）
vector_candidates AS (
  SELECT id, intent_summary, outcome_summary, embedding,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $query_embedding) AS vector_rank
  FROM episodic_memory
  ORDER BY embedding <=> $query_embedding
  LIMIT 20
),
-- 第二路：BM25 文本检索（GIN 倒排 Top-20）
bm25_candidates AS (
  SELECT id, intent_summary, outcome_summary,
         ts_rank_cd(ts_doc, query) AS bm25_raw_score,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
  FROM episodic_memory,
       plainto_tsquery('simple', $query_text) AS query
  WHERE ts_doc @@ query
  ORDER BY bm25_raw_score DESC
  LIMIT 20
),
-- 候选集合并（union 去重）
all_candidates AS (
  SELECT id FROM vector_candidates
  UNION
  SELECT id FROM bm25_candidates
),
-- RRF 融合（K=60，缺失流取 rank=21 作为惩罚值）
rrf_scored AS (
  SELECT
    ac.id,
    0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
    0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
  FROM all_candidates ac
  LEFT JOIN vector_candidates vc ON ac.id = vc.id
  LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
)
SELECT e.id, e.intent_summary, e.outcome_summary,
       e.key_entities, e.error_patterns,
       e.duration_ms, e.conflict_count,
       r.rrf_score
FROM rrf_scored r
JOIN episodic_memory e ON r.id = e.id
ORDER BY r.rrf_score DESC
LIMIT $final_k;   -- 发散性反思轨道默认 LIMIT 5
```

> **缺失流惩罚值 rank=21**：当某条记录仅出现在向量路或文本路时，缺失路的 rank 设为 21（= Top-20 候选池外），对应 RRF 贡献 `1/(60+21) ≈ 0.012`，远低于排名第 1 的贡献 `1/61 ≈ 0.016`，平滑降权而非完全清零。

---

## procedural_memory 冷启动查询升级（原 ADR 20 两阶段 Top-20 保留，追加 BM25 第三路）

原始查询（ADR 20 §8.2）仅有向量路 + 三信号重排。补充 BM25 路后，三信号重排分数整体不变，仅将候选集来源从单一向量路扩展为 RRF 合并池：

```sql
WITH
vector_candidates AS (
  SELECT id, intent_description, template_graph,
         success_count, failure_count, last_used_at,
         ROW_NUMBER() OVER (ORDER BY intent_embedding <=> $new_intent_embedding) AS vector_rank
  FROM procedural_memory
  WHERE is_anti_pattern = FALSE
  ORDER BY intent_embedding <=> $new_intent_embedding
  LIMIT 20
),
bm25_candidates AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
  FROM procedural_memory,
       plainto_tsquery('simple', $intent_text) AS query
  WHERE ts_doc @@ query
    AND is_anti_pattern = FALSE
  ORDER BY bm25_rank
  LIMIT 20
),
all_candidates AS (SELECT id FROM vector_candidates UNION SELECT id FROM bm25_candidates),
rrf_pool AS (
  SELECT
    ac.id,
    0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
    0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
  FROM all_candidates ac
  LEFT JOIN vector_candidates vc ON ac.id = vc.id
  LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
),
-- 四信号重排（rrf × 0.5 + 质量 × 0.25 + 时效 × 0.1 + 多样性 × 0.15）
scored AS (
  SELECT
    p.id, p.intent_description, p.template_graph,
    p.success_count, p.failure_count, p.last_used_at,
    p.unique_worker_types,
    r.rrf_score,
    ((p.success_count::FLOAT + 1.0) /
     (p.success_count + p.failure_count + 1.0))          AS quality_score,
    GREATEST(0.0, 1.0 - (
      EXTRACT(EPOCH FROM (NOW() - COALESCE(p.last_used_at, NOW()))) / (86400.0 * 30)
    ))                                                    AS recency_score,
    -- COALESCE: last_used_at IS NULL（新模板从未使用）视为刚创建 → recency_score = 1.0
    (p.unique_worker_types::FLOAT /
     NULLIF(MAX(p.unique_worker_types) OVER (), 0))       AS diversity_score
    -- 窗口函数归一化至 [0,1]，奖励多 Worker 协作拓扑，抑制单链保守流程
  FROM rrf_pool r
  JOIN procedural_memory p ON r.id = p.id
)
SELECT id, intent_description, template_graph,
       (rrf_score      * 0.5  +
        quality_score  * 0.25 +
        recency_score  * 0.1  +
        diversity_score * 0.15) AS final_score
FROM scored
ORDER BY final_score DESC
LIMIT 3;
```

---

## Writable CTE 写入补充（原子追加 tsvector，无需修改）

`tsvector` 列声明为 `GENERATED ALWAYS AS ... STORED`，由 PostgreSQL 在每次 INSERT 时自动计算并写入。Worker 的 Writable CTE 写入路径无需任何改动。

---

## 关联 ADR

- **ADR 17**：pgvector 原子写入规范 — tsvector 补充遵循相同原子写入哲学
- **ADR 20**：本补充直接扩展原有四层记忆物理架构
- **ADR 13**：Knapsack Slicing — 发散性反思轨道检索结果的 Token 预算约束不变（`LIMIT $final_k` 受 `min(2000, W_max×0.3)` 控制）
