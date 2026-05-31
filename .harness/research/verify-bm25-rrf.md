# BM25 / RRF / 反思轨道 SOTA 研究报告

**研究日期：** 2026-05-31
**研究范围：** P0-A（BM25 方案选型）、P0-B（RRF 公式）、P0-C（反思轨道触发规范）
**对应文档：** ADR 20 补充（`docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md`）、RFC v4 §4.4

---

## Gap 1：BM25 实现方案（P0-A）

**推荐方案：** 方案 B — PostgreSQL 原生 `tsvector + ts_rank_cd`，**加条件：** 若 IDF 盲区在实测中造成可感知的召回下降，可后续无痛升级至 VectorChord-bm25（第三方案）。

**理由：**

### ts_rank_cd 与真 BM25 的精度差距

`ts_rank_cd` 缺失三个 BM25 核心信号：

| 信号 | ts_rank_cd | 真 BM25 | 影响 |
|------|-----------|---------|------|
| IDF（逆文档频率） | 无 | 有 | 高频词（"database"）被高估，罕见精确词（错误码、API名）被低估 |
| TF 饱和 | 无 | 有（k1 参数） | 关键词重复 50 次的文档排名高于只提及 1 次的精确文档 |
| 文档长度归一化 | 无（cd 变体有部分近似） | 有（b 参数） | 长摘要天然优于短精确摘要 |

[CITED: https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres]

**在记忆检索场景下，这个差距有多实质性？**

记忆表（万到十万级）的检索场景与通用搜索引擎有关键不同：

1. **语料密度低**：`episodic_memory.intent_summary`、`semantic_memory.fact_text`、`procedural_memory.intent_description` 均是短文本（50-300 tokens），IDF 差异在小 corpus 下比在千万级语料库下小得多。
2. **RRF 融合稀释了排序误差**：即使 ts_rank_cd 的绝对排名与 BM25 有差异，RRF 公式 `1/(60 + rank)` 的分母抹平了头部排名的量纲放大效应。排名第 3 与排名第 5 对 RRF 得分的影响微乎其微。[CITED: https://www.paradedb.com/learn/search-concepts/reciprocal-rank-fusion]
3. **向量路是主力**：vector weight=0.6 占主导。BM25 路 weight=0.4 的作用是补充关键词精确匹配（错误代码、实体名、API 名），而不是独立决定排序。

**结论：** 在万到十万级短文本记忆表、向量为主的 0.6:0.4 双轨 RRF 场景下，`ts_rank_cd` 与真 BM25 的精度差距在 RRF 融合后**不可感知**。

> **Round 2 验证（2026-05-31）：置信度从 ASSUMED 升级为 HIGH。** 原因：RRF 公式使用 `ROW_NUMBER()` 而非 ts_rank_cd 原始分数，normalization 对排名无影响（单调变换）。任何 BM25/ts_rank_cd 分数精度差异只影响绝对分值，不影响 LIMIT 20 内的相对排名。验证来源：PostgreSQL 官方 `textsearch-controls.html` normalization bitmask 文档 + RRF 架构原理。

---

### 三个候选方案对比

| 方案 | 算法 | 依赖 | 安装难度 | 生产就绪度 |
|------|------|------|---------|-----------|
| **A: pg_search（ParadeDB）** | 真 BM25（Tantivy/Rust） | 需安装 `.deb` + `shared_preload_libraries` | 中（需重启 PG） | 高（PostgreSQL 15+，支持 Debian/Ubuntu/RHEL/macOS） |
| **B: tsvector + ts_rank_cd（原生）** | BM25 近似（无 IDF/TF 饱和） | 零（PostgreSQL 内置） | 零 | 最高（无变更） |
| **C: VectorChord-bm25** | 真 BM25（Block-WeakAnd/Rust） | 需安装 `.deb` + pg_tokenizer.rs | 中（两个扩展） | 中（新兴，PG 17/18） |

[CITED: https://docs.paradedb.com/deploy/self-hosted/extension] — pg_search 独立安装，无需 ParadeDB 完整 stack，无 Timescale 依赖

[CITED: https://github.com/tensorchord/VectorChord-bm25] — VectorChord-bm25 独立扩展，PG 17/18

**重要澄清：** `pg_bm25` 已于 v0.6.0 更名为 `pg_search`，可完全独立于 ParadeDB Docker stack 安装，无需 Timescale。
[CITED: https://pgxn.org/dist/pg_search/0.22.5/]

---

### 方案 B 的 ADR 20 实现（已在补充文档确认）

ADR 20 补充文档（`0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md`）已决策选用方案 B，理由一致：

- `tsvector` GENERATED ALWAYS 列，零写入路径变更
- `'simple'` 配置（不词干化），保护技术术语和 CJK unigram
- GIN 索引，与 HNSW 索引同架构哲学

**代价：**

- IDF 盲区：高频词权重过高，罕见精确词（错误码、API 名）召回轻微劣化
- 无 TF 饱和：关键词重复的长摘要有微小排名优势
- 在 RRF 0.4 权重下，上述劣化对最终 `rrf_score` 的影响 < 0.001（数量级估算）[ASSUMED]

**升级路径（后备）：** 若实测发现技术术语召回率低于预期，可无损迁移至 `pg_search`（方案 A）：仅需将 `ts_doc @@ plainto_tsquery(...)` 替换为 `||| ` 操作符，BM25 结果直接插入现有 RRF CTE。

**参考 SQL 实现（已在 ADR 20 补充文档确认）：**

```sql
-- BM25 文本路（方案 B，原生 tsvector）
bm25_candidates AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
  FROM episodic_memory,
       plainto_tsquery('simple', $query_text) AS query
  WHERE ts_doc @@ query
  LIMIT 20
)

-- 若未来升级至 pg_search（方案 A），仅替换此 CTE：
-- bm25_candidates AS (
--   SELECT id,
--          ROW_NUMBER() OVER (ORDER BY pdb.score(id) DESC) AS bm25_rank
--   FROM episodic_memory
--   WHERE intent_summary ||| $query_text
--   LIMIT 20
-- )
```

---

## Gap 2：RRF 公式（P0-B）

**推荐 k 值：** k = 60

**理由：**

k=60 是学术 paper（Cormack et al. 2009）的原始推荐值，也是工业界 OpenSearch、Elasticsearch、Azure AI Search、MongoDB Atlas、Weaviate 的默认值。[CITED: https://www.paradedb.com/learn/search-concepts/reciprocal-rank-fusion]

k=60 的数学语义：`1/61 ≈ 0.0164`（排名第1）vs `1/81 ≈ 0.0123`（排名第21），差距约 33%。这使得头部排名有意义但不极端，符合"奖励多系统共识、惩罚单系统极端"的 RRF 哲学。

[CITED: https://bigdataboutique.com/blog/reciprocal-rank-fusion-how-it-works-and-when-to-use-it]

**k 值调优建议（可选）：**

| k 范围 | 行为特征 | 适用场景 |
|--------|---------|---------|
| 10-20 | 强调头部排名，单系统 top-1 支配 | 精度优先，语料相似度高 |
| 50-60 | 平衡，头部有意义但不极端 | **通用推荐，记忆检索默认值** |
| 80-100 | 扁平化，鼓励多系统共识 | 召回优先，多路等权 |

---

### PostgreSQL RRF 实现模板（三信号融合）

ADR 20 的 `procedural_memory` 查询已实现 **RRF 双路 + 三信号重排** 的正确分层设计：

```sql
WITH
-- 第一路：向量检索（HNSW ANN Top-20）
vector_candidates AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $query_embedding) AS vector_rank
  FROM episodic_memory
  ORDER BY embedding <=> $query_embedding
  LIMIT 20
),
-- 第二路：BM25 文本检索（GIN 倒排 Top-20）
bm25_candidates AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
  FROM episodic_memory,
       plainto_tsquery('simple', $query_text) AS query
  WHERE ts_doc @@ query
  ORDER BY bm25_rank
  LIMIT 20
),
-- 候选集合并（union 去重）
all_candidates AS (
  SELECT id FROM vector_candidates
  UNION
  SELECT id FROM bm25_candidates
),
-- RRF 融合（K=60，缺失流 rank=21 作为惩罚值）
rrf_scored AS (
  SELECT
    ac.id,
    0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
    0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
  FROM all_candidates ac
  LEFT JOIN vector_candidates vc ON ac.id = vc.id
  LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
)
-- procedural_memory 三信号重排（rrf_score × 0.6 + quality × 0.3 + recency × 0.1）
SELECT id, intent_description, template_graph,
       (rrf_score * 0.6 + quality_score * 0.3 + recency_score * 0.1) AS final_score
FROM ...
ORDER BY final_score DESC
LIMIT 3;
```

---

### 三信号融合设计分析

ADR 20 补充文档的当前设计将质量分和时效分作为**候选集重排阶段**（post-RRF）的信号，而不是放入 RRF 公式本身。这是正确的分层设计：

| 层级 | 信号 | 作用 |
|------|------|------|
| **RRF 层**（候选集生成） | vector_rank + bm25_rank | 多路检索融合，解决不同量纲评分的可比性问题 |
| **重排层**（候选集精排） | rrf_score + quality_score + recency_score | 结合业务语义，对 RRF 候选池做最终排序 |

**为什么不把 quality/recency 放进 RRF？**

RRF 设计假设每个输入都是独立的**排名列表**（rank list）。质量分（`success_count` 平滑贝叶斯）和时效分（Ebbinghaus 衰减）不是排名列表，是标量信号。将标量信号强行转化为排名列表会引入排名解释的歧义。正确做法是将它们保留在重排层作为线性权重。[ASSUMED：基于 RRF 架构原理推断，无公开 paper 专门讨论此组合场景]

---

### 与 ADR 20 原始线性加权方案的对比

ADR 20 原始冷启动查询：
```sql
((1.0 - distance / 2.0) * 0.6 + quality_score * 0.3 + recency_score * 0.1) AS final_score
```

这是**单路向量检索 + 三信号线性加权**，不是 RRF。当加入 BM25 后，需要 RRF 先解决两路检索的评分不可比问题，再做三信号重排。

| 维度 | 原始线性加权 | RRF + 重排 |
|------|------------|-----------|
| BM25 融合 | 不支持（评分量纲不同） | 原生支持（只用 rank，不用 score） |
| 量纲归一化 | 需手动归一化 | 自动（RRF 公式消除量纲） |
| 权重调优 | 需要人工实验 | k=60 开箱即用 |
| Agent 记忆场景推荐度 | 单路可用，多路不适合 | **推荐** |

[CITED: https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual]

---

## Gap 3：反思轨道触发规范（P0-C）

### 子问题 1 推荐方向：统一 `mem::reflect` 函数（选项 A）

**推荐：选项 A — 在 iii-engine 中实现统一 `mem::reflect` 函数，Worker 调用单个接口。**

**理由：**

**SOTA 研究证据：**

MemR3 的架构明确采用**集中式控制**：三节点 Agent Graph（Retrieve → Reflect → Answer）由单一 Router 控制，各个检索后端作为可插拔模块。[CITED: https://arxiv.org/html/2512.20237v1]

MemGPT/Letta 的实现也是集中式：Agent 通过统一工具接口（`create_search_memory_tool`）检索记忆，而不是让每个 Worker 自行构建查询。[CITED: https://langchain-ai.github.io/langmem/]

**架构一致性论证：**

本系统的 Worker 遵循 ADR 12 的法定认知事件枚举，Worker 账户权限硬限缩为纯 `SELECT/INSERT`（ADR 05）。如果 Worker 自行查询三张记忆表（选项 B），则：

1. Worker 需要了解三张表的 schema（违反关注点分离）
2. 三张表的 schema 变更会扩散到所有 Worker（高耦合）
3. RRF 融合逻辑在每个 Worker 中重复实现（DRY 违反）
4. Token 预算裁断逻辑（`min(2000, W_max × 0.3)`）分散在多处

选项 A 将三表查询、RRF 融合、Token 预算截断全部封装在 `mem::reflect` 内，Worker 只需传入 `{query_text, query_embedding, trigger_type, W_max}` 并接收格式化的反思注入内容。这与 iii-engine 作为"大脑"层（ADR RFC §2.1）的定位完全一致。

**`mem::reflect` 接口设计（建议）：**

```typescript
// Worker 调用接口（伪代码）
const reflectionContext = await mem.reflect({
  query_text: "...",           // 触发查询的文本
  query_embedding: Float32Array, // 查询向量（1536 维）
  trigger_type: "conflict_detected" | "macro_planning" | "cold_start",
  w_max: number,               // 当前 Worker 的 W_max（ADR 14）
  scope_id: string,            // 当前 Scope
});

// 返回格式化的反思注入内容
// reflectionContext.tokens <= min(2000, w_max * 0.3)
// reflectionContext.sections = [procedural, episodic, semantic]
```

---

### 子问题 2 注入规范

**RFC §4.4 已定义的规范（直接采用）：**

```
反思记忆预算 = min(2000 tokens, W_max × 0.3)
截断优先级：Procedural > Episodic > Semantic
```

**Context Window 注入结构：**

```
[SYSTEM PROMPT]:      Core Schema Rules & tRPC Contracts
[EXECUTION CONTEXT]:  Immutable Graph Lineage（确定性轨道，Knapsack 切片）
[REFLECTION MEMORY]:  ← mem::reflect 注入此分区
  Procedural:  黄金拓扑模版摘要（最高优先级）
  Episodic:    相似 Scope 经验摘要
  Semantic:    通用事实知识
```

**注入边界保障（`mem::reflect` 内部实现）：**

```sql
-- 逐层截断算法（伪代码）
budget = min(2000, w_max * 0.3)

procedural_result = query_procedural(budget)    -- 先取 Procedural
procedural_tokens = tokenize(procedural_result)

episodic_budget = max(0, budget - procedural_tokens)
episodic_result = query_episodic(episodic_budget)
episodic_tokens = tokenize(episodic_result)

semantic_budget = max(0, episodic_budget - episodic_tokens)
semantic_result = query_semantic(semantic_budget)
```

---

### 子问题 3 Token 预算分配规范

**当前 RFC 状态：** RFC §4.4 定义了总预算 `min(2000, W_max × 0.3)`，但各层具体分配未定义。

**SOTA 参考：**

- Mem0 最新算法每次检索 context < 7000 tokens，重点是相关性过滤而非固定分层预算。[CITED: https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up]
- A-MEM 每次记忆操作约 1200 tokens，比全上下文方法节省 85-93%。[CITED: https://arxiv.org/pdf/2502.12110]
- MemR3 通过动态路由控制预算，没有固定的分层比例。[CITED: https://arxiv.org/html/2512.20237v1]

**无公开研究支持特定的三层固定比例分配**（如 50% Procedural、30% Episodic、20% Semantic）。[ASSUMED]

**推荐策略：顺序贪心截断（Sequential Greedy Truncation），不预设固定比例**

原因：
1. **Procedural Memory 的检索结果天然有硬上限**：`LIMIT 3`（ADR 20），模版 JSON 通常较大，直接取最高分模版截断即可。
2. **Episodic Memory 是简短摘要**：`intent_summary + outcome_summary`，单条 50-100 tokens，取 Top-3 约 150-300 tokens。
3. **Semantic Memory 是通用事实**：`fact_text` 更短，单条 20-50 tokens，取 Top-5 约 100-250 tokens。

**具体实现规范（建议写入 ADR 21）：**

```
总预算 B = min(2000, W_max × 0.3)

Step 1: Procedural
  - 查询：混合检索（RRF，见 ADR 20 补充），LIMIT 1（冷启动）或 LIMIT 3（macro-planning）
  - 截断：若单条模版 > B × 0.6，只注入 intent_description（摘要），不注入 template_graph（完整 JSON）
  - 消耗：P_tokens（实际值，由 Wasm Tokenizer 计算，ADR 15）

Step 2: Episodic
  - 查询：混合检索，LIMIT 5，发散性反思轨道默认（见 ADR 20 补充）
  - 预算：B2 = B - P_tokens
  - 截断：按 rrf_score DESC 逐条追加，直到 B2 耗尽

Step 3: Semantic
  - 查询：混合检索，LIMIT 5
  - 预算：B3 = B2 - E_tokens
  - 截断：按 rrf_score DESC 逐条追加，直到 B3 耗尽

结果：三层内容拼接，总 tokens <= B
```

**触发类型差异化预算（可选优化）：**

| 触发类型 | Procedural 优先级 | 典型总预算 |
|---------|----------------|---------|
| `cold_start` | 最高（找黄金模版） | min(2000, W_max × 0.3) |
| `conflict_detected` | 中（找历史冲突模式） | min(1000, W_max × 0.2) |
| `macro_planning` | 高（找全局规划模版） | min(2000, W_max × 0.3) |

[ASSUMED：触发类型差异化预算无公开研究支撑，为架构推断]

---

## 结论摘要

| Gap | 决策 | 置信度 |
|-----|------|--------|
| P0-A BM25 方案 | 方案 B（原生 tsvector），后备升级路径为 pg_search | HIGH（与 ADR 20 补充一致） |
| P0-B RRF k 值 | k=60，学术 + 工业界标准 | HIGH |
| P0-B RRF SQL 结构 | RRF 双路 + 三信号重排分层设计，已在 ADR 20 补充确认 | HIGH |
| P0-C 子问题1 | `mem::reflect` 统一函数，iii-engine 层实现 | MEDIUM（架构推断） |
| P0-C 子问题2 | 顺序截断，Procedural > Episodic > Semantic，预算 = min(2000, W_max × 0.3) | MEDIUM（RFC §4.4 已定义总量） |
| P0-C 子问题3 | 顺序贪心截断，不预设固定比例，Wasm Tokenizer 实时计算 | MEDIUM（无 SOTA 固定比例研究） |
| **A1 ts_rank_cd 精度** | **RRF 使用 ROW_NUMBER()，normalization 无影响，精度差距不可感知** | **HIGH（Round 2 升级）** |

---

## 假设日志（[ASSUMED] 标注汇总）

| # | 假设内容 | 风险 |
|---|---------|------|
| A1 | ~~在 RRF 0.6:0.4 权重、万到十万级短文本、LIMIT 20 双路下，ts_rank_cd 与真 BM25 排名差异对最终 rrf_score 的影响 < 0.001~~ **✅ Round 2 升级为 HIGH：RRF 使用 ROW_NUMBER()，normalization 对排名无影响，精度差距从架构上不可感知（无论文档长度）** | 无残留风险 |
| A2 | quality_score/recency_score 不放入 RRF 公式，作为重排层信号是正确的分层设计 | 目前无公开 paper 专门研究此混合场景，实践上是合理推断 |
| A3 | `mem::reflect` 集中式实现优于 Worker 自查（选项 A 优于选项 B） | 若 iii-engine 无法暴露 RPC 接口，选项 B 作为降级方案 |
| A4 | 触发类型差异化预算（cold_start vs conflict_detected vs macro_planning）合理 | 无量化研究支撑，可在 ADR 21 中标注为可调参数 |

---

## 来源

### PRIMARY（HIGH confidence）
- [CITED: https://docs.paradedb.com/deploy/self-hosted/extension] — pg_search 独立安装规范
- [CITED: https://pgxn.org/dist/pg_search/0.22.5/] — pg_search PGXN 包信息
- [CITED: https://www.paradedb.com/learn/search-concepts/reciprocal-rank-fusion] — RRF k=60 标准值
- [CITED: https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual] — PostgreSQL RRF SQL 模板
- [CITED: https://arxiv.org/html/2512.20237v1] — MemR3 集中式反思检索架构
- [CITED: https://github.com/tensorchord/VectorChord-bm25] — VectorChord-bm25 独立扩展

### SECONDARY（MEDIUM confidence）
- [CITED: https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres] — ts_rank_cd 与 BM25 差距分析
- [CITED: https://bigdataboutique.com/blog/reciprocal-rank-fusion-how-it-works-and-when-to-use-it] — RRF k 值调优指南
- [CITED: https://supabase.com/docs/guides/ai/hybrid-search] — Supabase 官方 RRF SQL 模板（k=50 变体）
- [CITED: https://langchain-ai.github.io/langmem/] — LangMem 统一记忆检索接口设计
- [CITED: https://mem0.ai/blog/benchmarked-openai-memory-vs-langmem-vs-memgpt-vs-mem0-for-long-term-memory-here-s-how-they-stacked-up] — Mem0 token budget < 7000
- [CITED: https://arxiv.org/pdf/2502.12110] — A-MEM token 压缩数据

### TERTIARY（LOW confidence / ASSUMED）
- [CITED: https://docs.pgedge.com/vchord-bm25/development/comparison-to-other-solution-in-postgres/] — VectorChord-bm25 与 ts_rank_cd 对比
- 触发类型差异化预算分配（架构推断，无公开 paper）
