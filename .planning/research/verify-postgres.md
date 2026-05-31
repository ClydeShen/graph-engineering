# PostgreSQL 设计主张验证报告

**研究日期：** 2026-05-31
**研究员：** Claude Sonnet 4.6（research agent）
**范围：** 验证 ADR 02、03、04、09 中涉及 PostgreSQL 和 tokio-postgres 的具体技术主张

---

## 主张 1：jsonb::text 产生字母序 key 排列（ADR 02 哈希函数的基础）

**结论：REFUTED（已证伪）**

### 证据

PostgreSQL 官方文档明确声明：

> "Because the `json` type stores an exact copy of the input text, it will preserve semantically-insignificant white space between tokens, as well as the order of keys within JSON objects... By contrast, **`jsonb` does not preserve white space, does not preserve the order of object keys**, and does not keep duplicate object keys."

文档中还给出了一个具体示例，其输出顺序既非输入顺序，也非字母顺序：

```sql
SELECT '{"bar": "baz", "balance": 7.77, "active":false}'::jsonb;
                      jsonb
--------------------------------------------------
 {"bar": "baz", "active": false, "balance": 7.77}
-- 输入顺序：bar, balance, active
-- 输出顺序：bar, active, balance（既非输入顺序，也非字母顺序）
```

jsonb 内部实际的 key 排序规则（来自 Section 8.14.4 B-tree ordering）是：**较短的 key 排在较长的 key 前面**（length-first ordering），而非字母顺序。文档明确指出：

> "Note that object keys are compared in their storage order; in particular, since **shorter keys are stored before longer keys**, this can lead to results that might be unintuitive."

这是一个**实现细节，而非文档化保证**。PostgreSQL 官方从未承诺 `jsonb::text` 输出为字母升序排列。

### 影响

ADR 02 的哈希计算依赖 `canonical_json(payload)` 保证 key 的字母升序。如果使用 `jsonb::text` 实现，哈希结果将依赖 PostgreSQL 的内部存储顺序（length-first），而非字母顺序。这意味着：

1. **哈希不一致性风险**：不同 PostgreSQL 版本的 jsonb 内部存储实现可能发生变化，导致同一 payload 产生不同哈希值，打破区块链式因果链。
2. **与 ADR 02 文字描述不符**："Payload 内 Key 严格按字母升序定序"——这一描述是正确的目标，但 `jsonb::text` 并不能实现这一目标。

### 正确替代方案

要实现真正的字母升序 key 排列，应使用以下方法之一：

**方案 A：PostgreSQL 应用层函数（推荐）**
```sql
CREATE OR REPLACE FUNCTION canonical_json(data jsonb) RETURNS text AS $$
  SELECT json_agg(kv ORDER BY kv->>'key')::text
  FROM jsonb_each(data) AS kv;
$$ LANGUAGE sql IMMUTABLE;
```
注意：上述仅为思路，实际递归排序需更复杂的实现。

**方案 B：应用层预处理后再传入 PostgreSQL**
在 Rust 端使用 `BTreeMap` 序列化（自动按 key 字母序），确保传入 PostgreSQL 的字符串已经是规范化格式，然后对字符串而非 jsonb 类型做哈希运算。

**来源：** [PostgreSQL 官方文档 8.14 JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)

---

## 主张 2：Writable CTE 中 UNIQUE 冲突不抛出异常（ADR 03 OCC 的核心）

**结论：VERIFIED（已验证，但有重要细节需说明）**

### 证据

**子问题 A：ON CONFLICT DO NOTHING 是否抑制异常？**

PostgreSQL 官方文档明确：

> "`ON CONFLICT DO NOTHING` simply avoids inserting a row as its alternative action."

以及：

> "Only rows that were successfully inserted or updated will be returned."

当 UNIQUE 冲突发生时，`ON CONFLICT DO NOTHING` 会：
- **不抛出异常**（异常被抑制）
- **不插入行**
- **RETURNING 子句返回空结果集（零行）**，不返回任何行，也不抛出错误

[来源：PostgreSQL 官方文档 INSERT](https://www.postgresql.org/docs/current/sql-insert.html)

**子问题 B：空行如何在 CTE 后续步骤中检测？**

```sql
WITH attempt AS (
  INSERT INTO execution_event_log (...)
  VALUES (...)
  ON CONFLICT (predecessor_hash, scope_id) DO NOTHING
  RETURNING version_hash
)
SELECT CASE WHEN attempt.version_hash IS NOT NULL THEN 'won' ELSE 'demoted' END
FROM ...
```

当冲突发生时，`attempt` CTE 返回零行。后续 SELECT 通过 `LEFT JOIN` 或 `CASE WHEN attempt.version_hash IS NOT NULL` 的判断逻辑需要小心——如果 `attempt` 返回零行，直接 `FROM attempt` 会导致整个 SELECT 也返回零行，而非返回 `'demoted'`。

**正确实现必须处理零行的情况**，例如使用 `FULL JOIN` 或借助一个基准单行表（如 `SELECT 1 AS dummy`）做 LEFT JOIN：

```sql
WITH attempt AS (
  INSERT INTO execution_event_log (...)
  ON CONFLICT (predecessor_hash, scope_id) DO NOTHING
  RETURNING version_hash
)
SELECT CASE WHEN (SELECT version_hash FROM attempt LIMIT 1) IS NOT NULL
            THEN 'won'
            ELSE 'demoted'
       END AS result;
```

这种写法在 attempt 为零行时也能正确返回 `'demoted'`。

**子问题 C：落后者的 conflict_detected INSERT 是否在同一 CTE 内？**

ADR 03 描述的"落后者被降级为 conflict_detected"需要第二次 INSERT。根据 PostgreSQL Writable CTE 的语义：

> "Data-modifying statements in WITH are executed exactly once and to completion, independently of whether the primary query reads all (or any) of their output."

可以在同一个 CTE 链内添加第二步 INSERT（条件性写入 conflict_detected），但这需要额外的 CTE step。具体地：

```sql
WITH attempt AS (
  INSERT INTO execution_event_log (...) VALUES (...)
  ON CONFLICT (...) DO NOTHING
  RETURNING version_hash
),
demote AS (
  INSERT INTO execution_event_log (event_type, predecessor_hash, ...)
  SELECT 'conflict_detected', winner_hash, ...
  WHERE NOT EXISTS (SELECT 1 FROM attempt)
  RETURNING version_hash
)
SELECT ...
```

这在单次数据库 I/O 往返内完成——**主张成立**，无需应用层重试。

### 影响

主张核心成立：`ON CONFLICT DO NOTHING` 确实抑制异常，RETURNING 返回空行而非报错。但 CTE 后续查询需正确处理零行情况，不能假设 attempt 总会返回一行。ADR 03 的 Worker 返回 `won/demoted` 的设计是可行的，实现时需注意空行处理。

---

## 主张 3：AFTER INSERT 触发器中 pg_notify 的事务提交时机（ADR 09）

**结论：VERIFIED（完全验证，行为与 ADR 09 预期一致）**

### 证据

PostgreSQL 官方文档 [NOTIFY 命令](https://www.postgresql.org/docs/current/sql-notify.html) 明确说明：

> "Firstly, if a `NOTIFY` is executed inside a transaction, the **notify events are not delivered until and unless the transaction is committed**. This is appropriate, since if the transaction is aborted, all the commands within it have had no effect, including `NOTIFY`."

以及：

> "The function `pg_notify`(`text`, `text`) can be used as an alternative to the `NOTIFY` command... [it follows] identical transaction semantics—notifications are queued and only delivered after the trigger's transaction commits."

### 验证结论

| 问题 | 答案 |
|------|------|
| pg_notify 在触发器内执行时，通知何时发送？ | **事务提交之后**，不在触发器执行时立即发送 |
| 外层事务回滚后，通知是否被丢弃？ | **是，完全丢弃**，不会到达任何监听者 |
| 这对 ADR 09 的 HWM 语义是否安全？ | **是**，notification 保证只在 INSERT 成功提交后才到达 iii-engine |

### 影响

ADR 09 的核心假设完全成立：AFTER INSERT 触发器调用 `pg_notify`，通知只在外层 INSERT 事务提交后才到达 iii-engine。这保证了 iii-engine 收到 `{"id": $event_id}` 时，对应事件行已确实持久化，可以安全地执行 BIGSERIAL 点查。事务回滚时通知被丢弃，保底路径 HWM 断线补发机制会覆盖这一情况。

**来源：** [PostgreSQL NOTIFY 文档](https://www.postgresql.org/docs/current/sql-notify.html)

---

## 主张 4：tokio-postgres 的 LISTEN/通知 API（Open Question #3）

**结论：PARTIAL（主张部分正确，但 API 形状与预期不同）**

### 证据

通过 [docs.rs/tokio-postgres](https://docs.rs/tokio-postgres/latest/tokio_postgres/) 和 Rust 社区论坛验证：

**Client::notifications() 方法**

`Client` 结构体**不存在** `notifications()` 方法。`Client` 的方法列表包含 query、execute、transaction、prepare、copy_in、copy_out 等，但没有任何 LISTEN/NOTIFY 专用方法。

**正确的 LISTEN/NOTIFY API 形状**

tokio-postgres 的通知接收通过 `Connection` 结构体的 `poll_message()` 方法实现：

```rust
// Connection::poll_message 签名
pub fn poll_message(
    &mut self,
    cx: &mut Context<'_>
) -> Poll<Option<Result<AsyncMessage, Error>>>
```

`AsyncMessage` 枚举有两个变体：
- `AsyncMessage::Notice(DbError)` — 服务端 notice 消息
- `AsyncMessage::Notification(Notification)` — LISTEN/NOTIFY 通知（标注 `#[non_exhaustive]`）

**正确的完整使用模式（来自 Rust 社区论坛和官方 GitHub issue #591）：**

```rust
use futures::{stream, StreamExt};
use futures_channel::mpsc;

let (client, mut connection) = tokio_postgres::connect(url, NoTls).await?;

// 创建消息传递通道
let (tx, mut rx) = mpsc::unbounded();

// 将 connection 的 poll_message 包装为 Stream，转发到 channel
// 注意：此处不能直接 await connection，否则无法检查 poll_message 输出
let stream = stream::poll_fn(move |cx| connection.poll_message(cx))
    .map_err(|e| panic!("{}", e));
tokio::spawn(stream.forward(tx));

// 订阅通知频道
client.batch_execute("LISTEN iii_engine_channel;").await?;

// 在另一个任务中接收通知
tokio::spawn(async move {
    while let Some(msg) = rx.next().await {
        if let tokio_postgres::AsyncMessage::Notification(n) = msg {
            println!("received: {}", n.payload());
        }
    }
});
```

**关键约束：**
- `Connection` 必须通过 `tokio::spawn` 并发驱动
- 不能直接 `.await` connection（否则无法使用 `poll_message`）
- `poll_message` 返回值 `None` 或 `Some(Err(_))` 是终止信号，之后不应再调用

**来源：**
- [docs.rs Connection::poll_message](https://docs.rs/tokio-postgres/latest/tokio_postgres/struct.Connection.html)
- [docs.rs AsyncMessage](https://docs.rs/tokio-postgres/latest/tokio_postgres/enum.AsyncMessage.html)
- [Rust 论坛 tokio-postgres LISTEN 讨论](https://users.rust-lang.org/t/listen-for-psql-notification-using-tokio_postgres/105798)
- [rust-postgres GitHub issue #591](https://github.com/rust-postgres/rust-postgres/issues/591)

### 影响

如果 iii-engine 实现中假设了 `Client::notifications()` 方法，该方法不存在，代码会编译失败。正确实现需使用 `Connection::poll_message` + `stream::poll_fn` 模式。该模式功能完整，只是 API 形状与直觉不同。

---

## 主张 5：PostgreSQL LIST 分区 + 跨分区 UNIQUE 约束行为（ADR 04）

**结论：PARTIAL（约束可声明，但跨分区唯一性语义需仔细理解）**

### 证据

PostgreSQL 官方文档 [DDL 分区限制](https://www.postgresql.org/docs/current/ddl-partitioning.html) 说明：

> "To create a unique or primary key constraint on a partitioned table, the partition keys must not include any expressions or function calls and **the constraint's columns must include all of the partition key columns.**"

> "This limitation exists because the individual indexes making up the constraint can only **directly enforce uniqueness within their own partitions**; therefore, the partition structure itself must guarantee that there are not duplicates in different partitions."

### ADR 04 实际设计的分析

ADR 04 采用的是**在子分区上分别声明 UNIQUE 约束**的方式：

```sql
-- ADR 04 的实际做法是在子表上加约束：
ALTER TABLE execution_event_log_scope_{id}
ADD CONSTRAINT uk_scope_composite_occ_{id} UNIQUE (predecessor_hash, scope_id);
```

这与"在主表上声明跨分区 UNIQUE"不同。ADR 04 的约束是**分区级别**的。

### 关键问题：OCC 语义是否仍然成立？

由于表按 `scope_id` 做 LIST 分区，每个 scope_id 值路由到固定的子分区。`UNIQUE(predecessor_hash, scope_id)` 在子分区上意味着：

- **同一个 scope_id 的 predecessor_hash 必须唯一** ✓（因为 scope_id 相同则一定在同一分区）
- **不同 scope_id 的 predecessor_hash 可以重复** ✓（设计意图：scope_id 是盐值，ADR 02 的哈希已经内含 scope_id）

| 场景 | 是否被约束阻止 |
|------|---------------|
| scope A 的 predecessor_hash='X' 已存在，再次 INSERT scope A + hash='X' | **是，被阻止**（同一分区唯一约束生效） |
| scope A 的 hash='X'，scope B 也有 hash='X' | **否，不被阻止**（不同分区） |

### 影响

ADR 04 的 OCC 设计是**语义上正确的**：
1. `scope_id` 作为加密盐已经使得同一个 `predecessor_hash` 在不同 scope 中代表不同的逻辑状态，不需要跨 scope 唯一性
2. 真正的竞争条件发生在同一个 scope 内（多个 Worker 竞争同一 scope 的同一祖先节点），而这正好被子分区级 UNIQUE 约束完整捕获

**结论：ADR 04 的分区 + 分区级 UNIQUE 设计在语义上完全正确，OCC 保证有效。** 唯一需要注意的是，主表上无法声明全局 UNIQUE 约束（只能在子分区上），但这是 ADR 04 已经正确处理的实现方式。

**来源：** [PostgreSQL DDL Partitioning Limitations](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-LIMITATIONS)

---

## 总结表

| 主张 | ADR | 结论 | 风险等级 | 需要行动？ |
|------|-----|------|---------|------------|
| 主张 1：`jsonb::text` 产生字母序 key | ADR 02 | **REFUTED** | 高 | 是——必须更换规范化实现 |
| 主张 2：Writable CTE ON CONFLICT DO NOTHING 不抛异常 | ADR 03 | **VERIFIED**（含细节） | 低 | 注意零行处理 |
| 主张 3：AFTER INSERT 触发器 pg_notify 在提交后发送 | ADR 09 | **VERIFIED** | 无 | 无 |
| 主张 4：tokio-postgres Client::notifications() 方法 | Open Q#3 | **PARTIAL** | 中 | API 形状不同，需用 poll_message |
| 主张 5：LIST 分区 + UNIQUE 跨分区约束 | ADR 04 | **PARTIAL**（设计正确） | 低 | 确认子分区级约束是意图实现 |

---

## 最高优先级行动项

### P0：修正 ADR 02 的规范化 JSON 实现

`jsonb::text` 不产生字母序 key，实际产生的是 length-first 内部存储顺序。这是最严重的发现：如果当前代码用 `jsonb::text` 计算哈希，哈希函数的规范化假设已经被打破。

**建议方案：** 在应用层（Rust 端）使用 `serde_json` + `BTreeMap` 做 canonical JSON 序列化，确保 key 按字母升序排列，将已序列化的字符串传入 PostgreSQL 做 `encode(digest(...), 'hex')`，而非将 jsonb 在 PostgreSQL 内部转换为 text 再哈希。

### P1：确认 tokio-postgres LISTEN 实现使用 poll_message

检查 iii-engine 的 Rust 代码，确认使用 `Connection::poll_message` + `stream::poll_fn` 模式，而非不存在的 `Client::notifications()` 方法。

---

## 来源清单

| 来源 | 用于验证 | 可信度 |
|------|---------|--------|
| [PostgreSQL 官方文档 8.14 JSON Types](https://www.postgresql.org/docs/current/datatype-json.html) | 主张 1 | HIGH |
| [PostgreSQL 官方文档 INSERT](https://www.postgresql.org/docs/current/sql-insert.html) | 主张 2 | HIGH |
| [PostgreSQL 官方文档 WITH Queries](https://www.postgresql.org/docs/current/queries-with.html) | 主张 2 | HIGH |
| [PostgreSQL 官方文档 NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) | 主张 3 | HIGH |
| [PostgreSQL 官方文档 DDL Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) | 主张 5 | HIGH |
| [docs.rs tokio-postgres Connection](https://docs.rs/tokio-postgres/latest/tokio_postgres/struct.Connection.html) | 主张 4 | HIGH |
| [docs.rs tokio-postgres AsyncMessage](https://docs.rs/tokio-postgres/latest/tokio_postgres/enum.AsyncMessage.html) | 主张 4 | HIGH |
| [Rust 论坛 tokio-postgres LISTEN 讨论](https://users.rust-lang.org/t/listen-for-psql-notification-using-tokio_postgres/105798) | 主张 4 | MEDIUM |
| [rust-postgres GitHub issue #591](https://github.com/rust-postgres/rust-postgres/issues/591) | 主张 4 | MEDIUM |
