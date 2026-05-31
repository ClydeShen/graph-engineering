# ADR 21｜发散性反思轨道触发规范（mem::reflect 接口与 Token 预算）

status: accepted  
日期: 2026-05-31  
研究依据: `.planning/research/verify-bm25-rrf.md §Gap3`、`.planning/research/deep-cross-validation-round2.md`

---

## 上下文

RFC §4.4 定义了双轨检索架构：确定性执行轨道（Knapsack Slicing，ADR 13）与发散性反思轨道（三张记忆表按需查询）。RFC 规定了三种触发场景（`conflict_detected`、`macro_planning`、`cold_start`）和总预算公式 `min(2000 tokens, W_max × 0.3)`，但以下细节未被任何 ADR 覆盖：

1. 反思轨道由谁调用、接口如何设计（集中式 vs Worker 自查）
2. 注入内容在 Context Window 中的物理分区结构
3. 三层记忆（Procedural / Episodic / Semantic）的具体截断算法
4. 不同触发类型下的预算差异化策略

---

## 决策

### 1. 统一 `mem::reflect` 函数（集中式，iii-engine 层）

**在 iii-engine 层实现统一的 `mem::reflect` 函数，Worker 通过单一接口触发反思检索。**

不采用"Worker 自行查询三张记忆表（分散式）"，原因：

| 维度 | 集中式（本决策） | 分散式 |
|------|----------------|--------|
| ADR 05 权限隔离 | ✅ Worker 账号仅 SELECT/INSERT 数据面 | ❌ Worker 需了解三表 schema |
| schema 变更影响 | ✅ 仅 iii-engine 层更新 | ❌ 变更扩散至所有 Worker |
| RRF 逻辑重用 | ✅ 集中一处，DRY | ❌ 每个 Worker 各自实现 |
| Token 预算截断 | ✅ 集中强制执行 | ❌ 分散，易遗漏 |
| RFC §2.1 定位 | ✅ iii-engine 是"大脑层"，Worker 是"执行手" | ❌ 违反关注点分离 |

参考：MemR3 架构（集中式 Router 控制三节点检索图）[CITED: arxiv.org/html/2512.20237v1]、MemGPT/Letta（统一工具接口 `create_search_memory_tool`）[CITED: langchain-ai.github.io/langmem]。

**Worker 调用接口（TypeScript）**：

```typescript
// Worker 调用 mem::reflect — iii Function 触发
// Worker 只传 query_text，embedding 由 mem::reflect 内部生成（见下方说明）
const reflection = await iii.trigger<MemReflectInput, MemReflectOutput>({
  function_id: 'mem::reflect',
  payload: {
    query_text:   string,   // 触发查询的文本（BM25 路直接使用；HNSW 路由 iii-engine 内部生成 embedding）
    trigger_type: 'cold_start' | 'conflict_detected' | 'macro_planning',
    w_max:        number,   // 当前 Worker 的 W_max（ADR 14）
    scope_id:     string,   // 当前 Scope UUID
  },
});

// 返回
// reflection.content:  格式化的注入文本，直接插入 [REFLECTION MEMORY] 分区
// reflection.tokens:   实际消耗 token 数（Wasm Tokenizer 计算，ADR 15）
// reflection.sections: { procedural: string, episodic: string, semantic: string }
```

**Embedding 生成规范**：`query_text` 的向量化由 `mem::reflect` 内部负责，Worker 无需持有 embedding API 凭证，符合 ADR 05 权限隔离。Embedding 模型通过 iii-engine 统一配置（见 ADR 22），消耗不计入 Worker 的 △_padding，写入 iii-observability 单独监控。

---

### 2. Context Window 注入结构

**`[REFLECTION MEMORY]` 作为独立分区**，物理上位于 `[EXECUTION CONTEXT]` 之后：

```
[SYSTEM PROMPT]       → Core Schema Rules & tRPC Contracts
[EXECUTION CONTEXT]   → Immutable Graph Lineage（确定性轨道，Knapsack 切片，ADR 13）
[REFLECTION MEMORY]   → mem::reflect 注入此分区（发散性轨道）
  ## Procedural Memory（黄金拓扑模版）
  <注入内容，不超过 Step 1 预算>

  ## Episodic Memory（相似 Scope 经验）
  <注入内容，不超过 Step 2 剩余预算>

  ## Semantic Memory（通用事实知识）
  <注入内容，不超过 Step 3 剩余预算>
```

三个分区均为可选（若预算耗尽或检索结果为空，对应分区省略）。

---

### 3. Token 预算：顺序贪心截断（Sequential Greedy Truncation）

**总预算 B 由触发类型决定（见第 4 节），截断策略为顺序贪心，不预设固定比例。**

```
B = 触发类型预算（见下表）

Step 1：Procedural Memory
  查询：混合检索 RRF（ADR 20 补充），LIMIT 由 trigger_type 决定（见下表）
  截断规则：
    if single_result_tokens > B × 0.6:
        only inject intent_description (summary), skip template_graph (full JSON)
    else:
        inject full result
  消耗：P_tokens（Wasm Tokenizer 实时计算，ADR 15）

Step 2：Episodic Memory
  查询：混合检索 RRF（ADR 20 补充），LIMIT 5
  可用预算：B₂ = max(0, B - P_tokens)
  截断：按 rrf_score DESC 逐条追加，直到 B₂ 耗尽
  消耗：E_tokens

Step 3：Semantic Memory
  查询：混合检索 RRF（ADR 20 补充），LIMIT 5，WHERE superseded_by IS NULL
  可用预算：B₃ = max(0, B₂ - E_tokens)
  截断：按 rrf_score DESC 逐条追加，直到 B₃ 耗尽

最终注入 tokens = P_tokens + E_tokens + S_tokens ≤ B
```

**典型 token 消耗估算**（仅供参考）：

| 层 | 单条 token 估算 | LIMIT | 典型消耗 |
|----|----------------|-------|---------|
| Procedural | 200–800（含 intent_description） | 1–3 | 200–600 |
| Episodic | 50–100（intent + outcome 摘要） | 5 | 150–300 |
| Semantic | 20–50（fact_text） | 5 | 100–200 |
| **合计** | — | — | **450–1100** |

通常远低于 2000 token 上限，预算裁断主要保护极端情况（大型黄金模版 JSON）。

---

### 4. 触发类型差异化预算

| trigger_type | 总预算 B | Procedural LIMIT | 语义 |
|-------------|---------|-----------------|------|
| `cold_start` | `min(2000, W_max × 0.3)` | **3**（尽量召回多个候选模版） | 最高优先级：找黄金拓扑模版 |
| `macro_planning` | `min(2000, W_max × 0.3)` | **3**（全局规划需要多模版对比） | 高优先级：规划时对齐历史成功路径 |
| `conflict_detected` | `min(1000, W_max × 0.2)` | **1**（只需找最相关的冲突处理模式） | 中优先级：快速注入处置经验，不消耗大量预算 |

> 差异化预算为可调参数，Phase 1 先固定以上数值，后续可基于实测调整。

---

### 5. `mem::reflect` iii-engine 内部实现伪代码

```typescript
// iii-engine 层 mem::reflect Function 注册
iii.registerFunction('mem::reflect', async (input: MemReflectInput) => {
  const budget = computeBudget(input.trigger_type, input.w_max);
  const procLimit = input.trigger_type === 'conflict_detected' ? 1 : 3;

  // 内部生成 embedding（不暴露给 Worker，符合 ADR 05 权限隔离）
  const queryEmbedding = await embeddingProvider.embed(input.query_text); // ADR 22

  // Step 1: Procedural
  const procRows = await hybridSearch('procedural_memory', {
    queryEmbedding,
    queryText: input.query_text,
    scopeId: input.scope_id,
    limit: procLimit,
    antiPattern: false,
  });
  const procText = formatProcedural(procRows, budget);
  const pTokens = await wasmTokenizer.count(procText); // ADR 15

  // Step 2: Episodic
  const epiRows = await hybridSearch('episodic_memory', {
    queryEmbedding,
    queryText: input.query_text,
    scopeId: input.scope_id,
    limit: 5,
  });
  const epiText = formatEpisodic(epiRows, budget - pTokens);
  const eTokens = await wasmTokenizer.count(epiText);

  // Step 3: Semantic
  const semRows = await hybridSearch('semantic_memory', {
    queryEmbedding,
    queryText: input.query_text,
    scopeId: input.scope_id,
    limit: 5,
    activeOnly: true, // WHERE superseded_by IS NULL
  });
  const semText = formatSemantic(semRows, budget - pTokens - eTokens);
  const sTokens = await wasmTokenizer.count(semText);

  const content = assembleReflectionPartition(procText, epiText, semText);
  return {
    content,
    tokens: pTokens + eTokens + sTokens,
    sections: { procedural: procText, episodic: epiText, semantic: semText },
  };
});

function computeBudget(triggerType: string, wMax: number): number {
  if (triggerType === 'conflict_detected') {
    return Math.min(1000, Math.floor(wMax * 0.2));
  }
  return Math.min(2000, Math.floor(wMax * 0.3));
}
```

---

## 后果

- **ADR 05 完全兼容**：Worker 账号仅需 SELECT/INSERT 数据面权限，无需直接查询三张记忆表
- **ADR 13 互补**：Knapsack Slicing 处理确定性轨道（因果图切片）；`mem::reflect` 处理发散性轨道（跨 Scope 弱联想）。两者独立触发，不竞争 Token 预算
- **ADR 14 保障**：`w_max` 从 ADR 14 的 Context Window 安全容量公式导入，`[REFLECTION MEMORY]` 预算永不超出物理窗口
- **ADR 15 依赖**：Wasm Tokenizer 旁路预检为逐层截断提供精确 token 计数
- **ADR 20 依赖**：三层记忆表的混合检索（RRF K=60，tsvector BM25 + pgvector HNSW）由 ADR 20 及其补充文档定义；`mem::reflect` 直接调用 ADR 20 的标准混合检索 SQL 模板
- **可观测性**：`mem::reflect` 的每次调用应写入 `[REFLECTION MEMORY]` 分区的 token 数到 iii-observability，用于监控反思轨道的资源消耗趋势

---

## 关联 ADR

- **RFC §4.4** — 双轨检索原始规范（本 ADR 是其实现细节的精确化）
- **ADR 13** — Knapsack Slicing（确定性轨道，互补）
- **ADR 14** — Context Window 安全容量公式（`w_max` 来源）
- **ADR 15** — Wasm Tokenizer 旁路预检（token 计数依赖）
- **ADR 20** — 四层记忆物理架构（三张记忆表 schema + 混合检索 SQL）
- **ADR 20 补充（文件 0021）** — BM25 + RRF 混合检索规范（`mem::reflect` 底层查询模板）
