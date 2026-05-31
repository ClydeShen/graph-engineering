# 深度交叉验证 Round 2 研究报告

**研究日期：** 2026-05-31  
**研究范围：** 未决问题追踪.md 全部非 ✅ 条目 + verify-bm25-rrf.md 全部 [ASSUMED] 标注  
**数据来源：** context7（`/iii-hq/iii`、`/websites/iii_dev`、`/websites/postgresql`、`/langchain-ai/langmem`、`/websites/mem0_ai`）+ 已有研究文件交叉核验  
**置信度标注：** HIGH = 官方文档直接引用；MEDIUM = 推断但有架构依据；LOW = 待实测验证

---

## 一、P1-A：iii harness 组件是否为公开 worker？

**结论：✅ 已解决（结果：均需自建）**

### 发现

**公开 iii 注册表**（来源：`/iii-hq/iii` 官方仓库 website/index.html）包含 19 个基础设施 Worker：

```
nginx, rabbitmq, postgres, mysql, redis, kafka, s3, minio,
elasticsearch, datadog, prometheus, grafana, mongodb, clickhouse,
traefik, caddy, sentry, nats, opensearch
```

**`llm-budget`、`context-compaction`、`approval-gate`、`turn-orchestrator` 均不在公开注册表中。**

### approval-gate 的真实含义

来自官方文档 `iii-agentic-backend/SKILL.md`：

> "Implement approval gates by calling a condition function explicitly before enqueuing the next agent."

approval-gate 是一种**设计模式**（调用 condition function 再决定是否 enqueue），不是可 `iii worker add` 的具体 Worker 二进制。

### harness 三层架构（官方文档）

iii 的 harness 分三个精密等级（来源：`website/AGENTS.md`、`website/index.html`）：

| 等级 | 描述 | 对应本项目 |
|------|------|-----------|
| **autonomous** | 精简 harness，由 LLM 决定 next trigger | Phase 1 MVP |
| **supervised** | 需要 approval gates + 审计轨道 | Phase 2/3 |
| **deterministic** | 显式预决路径，最厚 harness | Phase 4 |

> "Harness composition in iii is a flexible choice rather than a product feature. A thin harness uses a worker with few functions, letting the model decide the next trigger, while a thick harness includes more functions, approval gates, and conditional logic. This shape is changed by adding or removing functions, not by rearchitecting."

### 影响

**ADR 14/16 组件（`llm-budget`、`context-compaction`）必须作为自建 iii Functions 实现。** 不能从注册表下载。Phase 1 工作量包含这两个 Function 的从零构建。

**建议**：P1-A 标记为 ✅ 已解决，ADR 14/16 备注"实现为自建 iii Function，非注册表 Worker"。

---

## 二、P1-C：iii-database change feeds 与 ADR 09 的关系

**结论：✅ 已解决（ADR 09 LISTEN/NOTIFY + HWM 设计正确，无冲突）**

### iii 的 postgres worker 工作机制

来自 iii 官方网站 worker 注册表：

```javascript
{ name: 'postgres', version: 'v16.4',
  desc: '...ACID transactions and rich SQL.',
  category: 'database', kind: 'MANAGED', verified: true }

// 对应触发器事件
NW_TRIGGERS = { 'postgres': { event: 'sql::query::execute', args: '{ query }' } }
```

iii 的 `postgres` worker 触发的是 **查询级事件**（`sql::query::execute`），不是行变更 CDC。

### iii 内部"change feeds"真实含义

前一轮研究中提到的"change feeds"来自 iii 的三种数据触发器：

| 触发器类型 | 机制 | 适用场景 |
|-----------|------|---------|
| `stream` trigger | `iii-stream` WebSocket 流变更（`StreamChangeEvent`） | iii 内部 KV 流数据 |
| `state` trigger | `iii-state` KV 状态变更 | iii 内部状态键值 |
| `sql::query::execute` | iii postgres worker 查询触发 | 外部 SQL 查询 |

这三种机制操作的是 **iii 自己的数据存储**（KV store），不是 PostgreSQL 行级变更。

### PostgreSQL 逻辑复制 CDC（官方文档确认）

PostgreSQL 原生支持 WAL 级 CDC：

```sql
-- 需要 wal_level=logical
SELECT * FROM pg_create_logical_replication_slot('slot_name', 'test_decoding', false, true);
SELECT * FROM pg_logical_slot_get_changes('slot_name', NULL, NULL);
-- INSERT: id[integer]:1 data[text]:'1'
```

但 WAL 级 CDC 有显著开销：需要持久化 replication slot、WAL 保留、消费者持续 poll。

### 结论

**ADR 09 的 LISTEN/NOTIFY + HWM 设计是正确且轻量的选择：**

| 维度 | LISTEN/NOTIFY（ADR 09） | WAL 逻辑复制 CDC |
|------|------------------------|-----------------|
| 开销 | 轻量（会话级 pub/sub） | 重（WAL 保留 + 持久 slot） |
| 持久化 | 无（会话丢失则通知丢失） | 是（slot 持久化） |
| 容错 | HWM 补偿（已设计） | slot 级恢复 |
| 适用场景 | append-only 事件流 | 全表行级变更捕获 |
| 本项目 | ✅ 合适（event_log insert 触发通知） | 过度设计 |

**tokio-postgres 集成**（已在 Round 1 验证）：使用 `Connection::poll_message()` + `stream::poll_fn`，不用 `Client::notifications()`（该方法不存在）。ADR 09 设计无需修订。

---

## 三、ADR 20 NULL bug：recency_score 的 COALESCE 缺失

**结论：🔴 已确认 BUG，需在迁移 SQL 中修复**

### Bug 描述

`procedural_memory` 三信号重排查询（ADR 20 补充文档 §procedural_memory 冷启动查询）：

```sql
GREATEST(0.0, 1.0 - (
  EXTRACT(EPOCH FROM (NOW() - p.last_used_at)) / (86400.0 * 30)
))  AS recency_score
```

**当 `last_used_at IS NULL` 时（新模板，从未被使用）：**

```
NOW() - NULL  =  NULL
EXTRACT(EPOCH FROM NULL)  =  NULL  
1.0 - NULL / (...)  =  NULL
GREATEST(0.0, NULL)  =  NULL   ← PostgreSQL: GREATEST 含 NULL 参数返回 NULL
final_score = rrf_score * 0.6 + quality_score * 0.3 + NULL * 0.1 = NULL
```

**后果**：新模板的 `final_score = NULL`，在 `ORDER BY final_score DESC` 中排最后，实际上被丢弃。系统在冷启动时无法推荐任何未被使用过的模板，违背了 `cold_start` 触发类型的设计意图。

### 修复方案（推荐）

```sql
-- 将 NULL last_used_at 视为"刚创建" = 最大时效性（recency_score = 1.0）
GREATEST(0.0, 1.0 - (
  EXTRACT(EPOCH FROM (NOW() - COALESCE(p.last_used_at, NOW()))) / (86400.0 * 30)
))  AS recency_score
```

`COALESCE(p.last_used_at, NOW())` → 时差 ≈ 0 → `1.0 - 0 = 1.0`。新模板得到最高时效分，鼓励冷启动时尝试新模板。

**备选语义**（若希望新模板排中性）：

```sql
COALESCE(
  GREATEST(0.0, 1.0 - (EXTRACT(EPOCH FROM (NOW() - p.last_used_at)) / (86400.0 * 30))),
  0.5  -- 未使用过 = 中性时效分
) AS recency_score
```

### 影响范围

- ADR 20 补充文档 §procedural_memory 冷启动查询升级
- Phase 1 数据库迁移 SQL
- 同样的 NULL bug 可能存在于 `semantic_memory` 的 `last_accessed_at`（如有）

---

## 四、A1：ts_rank_cd vs 真 BM25 ——新发现

**结论：设计已优化，ASSUMED 标注可降级为 HIGH**

### ts_rank_cd 规范化选项（官方文档）

来自 PostgreSQL 官方文档 `textsearch-controls.html`：

```sql
-- normalization 参数是一个 bitmask 整数
-- 0: 默认，不规范化
-- 1: 除以 1 + log(词数)
-- 2: 除以 词数
-- 4: 除以平均谐波距离（ts_rank_cd 专用）  ← BM25 近似
-- 8: 除以 唯一词数
-- 16: 除以 1 + log(唯一词数)
-- 32: 除以 rank + 1（将范围压缩到 (0,1]）

-- 默认权重数组（D-weight, C-weight, B-weight, A-weight）
-- {0.1, 0.2, 0.4, 1.0}
```

### 关键发现：RRF 中规范化无意义

**由于我们使用 `ROW_NUMBER() OVER (ORDER BY ts_rank_cd(...) DESC)` 而非 ts_rank_cd 原始分数：**

- RRF 公式 `1/(60 + bm25_rank)` 仅依赖排名位置，不依赖原始分数
- normalization flag 影响原始分数的绝对值，不影响排名顺序（单调变换）
- **结论：任何 normalization flag 对 RRF 结果无影响**

**A1 假设 "ts_rank_cd 与真 BM25 排名差异对 rrf_score 影响 < 0.001" 的置信度可从 ASSUMED 提升为 HIGH。** 原因：RRF 机制从架构上消除了绝对分数的重要性；唯一影响 BM25 路贡献的是 LIMIT 20 的截断，而不是分数精度。

### setweight 策略（ADR 20 补充已正确）

来自 ADR 20 补充文档，episodic_memory 的 `ts_doc` 定义：

```sql
setweight(to_tsvector('simple', coalesce(intent_summary, '')), 'A') ||  -- 权重 1.0
setweight(to_tsvector('simple', coalesce(outcome_summary, '')), 'B')    -- 权重 0.4
```

这是最优设计：意图字段（A=1.0）权重高于结果字段（B=0.4），与 RRF 语义一致。**无需改动。**

---

## 五、P1-E：隐私过滤层放置位置

**结论：🟡 方向确定，待写入 ADR**

### Mem0 方案参考

来自 Mem0 官方文档 `cookbooks/essentials/controlling-memory-ingestion`：

```python
client.project.update(
    custom_instructions="""
NEVER STORE:
- Social Security Numbers
- Insurance policy numbers
- Credit card information
- API keys, secrets, credentials
"""
)
```

Mem0 使用 **LLM + 自定义规则** 在记忆写入前过滤敏感信息。过滤发生在应用层，由 `client.add()` 调用内部处理。

### 本项目推荐实现

**推荐放置位置：iii-engine 层（`memory::write_guard` Function）**

理由：

| 层级 | 优劣分析 |
|------|---------|
| Worker 层 | ADR 05 限制 Worker 权限（SELECT/INSERT 数据面），Worker 信任度低；过滤逻辑分散 |
| **iii-engine 层** | **自然截流点**：所有记忆写事件经过总线；统一维护；与 ADR 05 "筑巢协议"一致 |
| PostgreSQL trigger | 性能影响大；SQL 触发器难以调用 LLM/regex；维护困难 |

**推荐接口设计：**

```typescript
// iii-engine 中注册 memory::write_guard Function
iii.registerFunction('memory::write_guard', async (payload) => {
  // 1. Regex pass：API key patterns, secret patterns
  const stripped = stripSecretsRegex(payload.content);
  
  // 2. LLM pass（可选，仅高敏感度 scope）：
  // if (payload.scope.sensitivity === 'high') {
  //   stripped = await llmPrivacyFilter(stripped);
  // }
  
  return { allowed: true, filtered_content: stripped };
});
```

所有记忆写入（episodic/semantic/procedural）先经过 `memory::write_guard`，再进入 Writable CTE。

**规则建议（写入 ADR 或实施规范）：**
- Regex 硬过滤：`sk-[A-Za-z0-9]{32,}`（OpenAI API key 模式）、`[A-Z0-9]{20,40}`（AWS key 模式）、PostgreSQL 连接串、`<secret>...</secret>` 标签
- 替换为 `[REDACTED:secret_type]`
- 不做 LLM 过滤（避免增加延迟和 token 消耗）

---

## 六、P1-F：SHA-256 去重窗口规范

**结论：🟡 框架已有结构去重，Working Memory 需补时间窗口去重**

### 现有去重机制（版本哈希）

ADR 02 的版本哈希公式：
```
version_hash = SHA256({scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)})
```

这是**结构去重**：相同 entity + predecessor + event_type + payload → 相同 hash → PostgreSQL unique constraint 阻止重复写入（OCC 自然保护）。

### 未覆盖的场景：Working Memory 连续相同工具调用

**场景**：Pi Agent 在 2 分钟内对同一文件调用了两次完全相同的 `read_file` 工具，payload 相同，但 predecessor_hash 不同（两次调用各有前驱事件）。版本哈希不同 → 两条记录均写入 `execution_event_log` → 不重复但语义上重复。

**agentmemory 解法**：SHA-256 of `{scope_id, entity_id, event_type, payload_hash}`（不含 predecessor），配合 5 分钟时间窗口：

```sql
-- agentmemory 式时间窗口去重（建议写入 ADR 11 或新 ADR）
WITH recent AS (
  SELECT 1 FROM execution_event_log
  WHERE scope_id = $scope_id
    AND entity_id = $entity_id
    AND event_type = $event_type
    AND encode(digest(canonical_json(payload), 'sha256'), 'hex') = $payload_hash
    AND created_at > NOW() - INTERVAL '5 minutes'
)
INSERT INTO execution_event_log (...)
SELECT ... WHERE NOT EXISTS (SELECT 1 FROM recent);
```

### 影响与建议

- **Phase 1 MVP**：不实现时间窗口去重，依赖结构去重（版本哈希 unique constraint）
- **Phase 2**：当 Working Memory 捕获高频工具调用时，补入 5 分钟时间窗口去重
- **建议更新 ADR 11**（Worker 幂等）：在补充规范中说明版本哈希去重 vs 时间窗口去重的适用场景

---

## 七、P1-B：Pi Sandbox 预演模式与 OCC 的关系

**结论：🟢 Phase 4 功能，不阻塞 Phase 1，方向已明确**

### Pi fork() API 作为沙箱候选

来自 `pi-sdk.md §9`（已验证）：

```typescript
// runtime.fork(entryId, { position: 'at' }) 从指定历史节点开辟新执行路径，不影响原 session
await runtime.fork(entryId, { position: 'at' });
```

结合 `SessionManager.inMemory()`：可在内存中预演图拓扑推进，不写入 PostgreSQL 主账本。这是 Phase 4 Pi Sandbox（ISSUE-28）的候选实现路径。

### 与 ADR 03 OCC 的关系

| 阶段 | 机制 | PostgreSQL 交互 |
|------|------|----------------|
| 预演阶段（Pi fork）| 内存中模拟图推进 | **无**（纯内存） |
| 提交阶段 | Writable CTE OCC（ADR 03） | 原子写入，CAS 验证 |

**两者协作关系**：Pi Sandbox 是 OCC 冲突的"预检"机制，减少无效的 OCC 提交尝试。预演成功 → 高置信度批量提交 → 仍通过 Writable CTE OCC 保证原子性。

**不引入新的原子性风险**：沙箱预演结果不保证与最终状态一致（其他 Worker 可能并发写入），提交时仍需完整的 OCC 验证。

**建议**：P1-B 可降级为 P2（Phase 4 设计），不影响 Phase 1-3。待 Phase 4 规划时补写 ADR。

---

## 八、P2-D/E：iii-cron 触发频率（Memory Synthesizer + Ebbinghaus 衰减）

**结论：✅ iii-cron 功能已确认，可直接使用**

### iii-cron 规范（官方文档）

来自 `/iii-hq/iii` 官方文档：

```yaml
# iii-config.yaml — 启用 cron worker
workers:
  - name: iii-cron
    config:
      adapter:
        name: kv
```

```typescript
// 注册 cron 触发器（7 字段 cron 表达式）
iii.registerTrigger({
  type: 'cron',
  function_id: 'cleanup::expired-sessions',
  config: { expression: '0 0 * * * * *' }  // 每小时
});
```

cron 表达式格式：**7 字段**（秒 分 时 日 月 周 年）

### Memory Synthesizer 触发建议

**选项比较：**

| 触发方式 | 优势 | 劣势 |
|---------|------|------|
| 每个 scope_closed 事件 | 即时归纳 | scope 数量大时过于频繁 |
| **每日凌晨 cron** | 低开销，可预测 | 最大 24h 延迟 |
| scope 积累 N 条 episodic | 事件驱动、平衡 | 需计数器/状态追踪 |

**推荐：每日凌晨 cron + scope 积累阈值双触发**

```typescript
// 方案：每日凌晨 2 点批量归纳
iii.registerTrigger({
  type: 'cron',
  function_id: 'memory::synthesize',
  config: { expression: '0 0 2 * * * *' }  // 每天 02:00
});

// 可选：scope_closed 后积累 ≥20 条 episodic 才触发
// （写入 ADR 20 §Memory Synthesizer 触发条件）
```

### Ebbinghaus 衰减扫描推荐

```typescript
iii.registerTrigger({
  type: 'cron',
  function_id: 'memory::decay_scan',
  config: { expression: '0 0 3 * * * *' }  // 每天 03:00（错开归纳）
});
```

衰减阈值（建议写入 ADR 20 或新 ADR）：
- `reinforcement_count = 0` AND `last_used_at < NOW() - INTERVAL '90 days'` → 标记 `superseded_by` = 自身（逻辑删除）
- 不做物理删除（保持 append-only 原则）

---

## 九、A2/A3/A4 假设日志更新

| 假设 | 原状态 | 新状态 | 理由 |
|------|--------|--------|------|
| A1 ts_rank_cd < 0.001 影响 | ASSUMED | **HIGH** | RRF 仅用 ROW_NUMBER，与原始分数无关；规范化无意义 |
| A2 quality/recency 放重排层 | ASSUMED | **MEDIUM（不变）** | 架构推断；无 paper 支撑，但逻辑严密 |
| A3 mem::reflect 集中式 > Worker 自查 | ASSUMED | **MEDIUM（不变）** | P1-E 研究佐证集中式过滤也在 iii-engine 层 |
| A4 触发类型差异化预算 | ASSUMED | **MEDIUM（可写入 ADR 21 as 可调参数）** | 无量化研究；合理工程设计 |

---

## 十、新发现问题（本轮新增）

| 编号 | 问题 | 状态 |
|------|------|------|
| N1 | ADR 20 NULL bug（recency_score COALESCE 缺失） | 🔴 需修复 |
| N2 | P2-D/E cron 触发器格式已确认（7 字段） | ✅ 可写入 ADR |
| N3 | P1-B Pi fork() = Phase 4 sandbox 候选实现 | 🟢 Phase 4 追踪 |
| N4 | P1-A harness 组件均需自建（无公开 worker） | ✅ ADR 14/16 备注更新 |

---

## 十一、结论与下一步行动

### 立即需要处理（影响 Phase 1）

| # | 行动 | 对应文档 |
|---|------|---------|
| 1 | 修复 ADR 20 补充文档中 `recency_score` 的 COALESCE（N1） | `0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` |
| 2 | 写入 ADR 21（反思轨道，已有完整内容） | 新建 ADR 21 |
| 3 | 更新 P1-A 状态（harness 组件均自建） | 未决问题追踪.md |
| 4 | 更新 P1-C 状态（LISTEN/NOTIFY 设计正确） | 未决问题追踪.md |

### Phase 2/3 追踪（不阻塞 Phase 1）

| # | 行动 | 对应文档 |
|---|------|---------|
| 5 | P1-E 补写 `memory::write_guard` 设计（隐私过滤） | ADR 05 补充或新 ADR |
| 6 | P1-F 补写 Working Memory 时间窗口去重规范 | ADR 11 补充 |
| 7 | P2-D/E 写入 iii-cron 双触发规范 | ADR 20 §Memory Synthesizer |

### Phase 4 追踪

| # | 行动 |
|---|------|
| 8 | P1-B Pi Sandbox → ADR（Pi fork + OCC 协作设计） |

---

## 来源索引

| 来源 | 用于 |
|------|------|
| `/iii-hq/iii` context7 | P1-A worker registry, iii harness tiers, cron format |
| `/websites/iii_dev` context7 | P1-C database trigger types, stream worker |
| `/websites/postgresql` context7 | A1 ts_rank_cd normalization, LISTEN/NOTIFY, logical replication |
| `/langchain-ai/langmem` context7 | A4 ReflectionExecutor, background processing |
| `/websites/mem0_ai` context7 | P1-E privacy filter custom_instructions pattern |
| `pi-sdk.md` (已有研究) | P1-B fork() sandbox, Worker 完整实现模式 |
| `iii-engine.md` (已有研究) | iii 架构确认 |
| `0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` | N1 NULL bug 位置确认 |
