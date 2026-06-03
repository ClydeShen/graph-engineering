# Testing Plan — Graph-Native Agent Runtime

> **原则：** 每个 Gate 的 E2E 测试通过后，才能开始下一个 Phase 的 planning。
> Gate 通过 = 所有期望 log 行出现 + 所有 curl 命令返回期望 JSON + 没有 ERROR 级别的 pino 行。

---

## Gate 1 — Phase 1 核心基础设施

**触发时机：** Phase 1 所有 plan（01-01 至 01-11）完成、unit tests 全绿之后。
**通过条件：** 本 Gate 全部 Scenario 通过，才能开始 Phase 2 planning。

---

### 1.1 环境准备

#### 必须安装

| 依赖 | 版本要求 | 验证命令 |
|------|----------|----------|
| Node.js | ≥ 20 | `node --version` |
| PostgreSQL | ≥ 15（含 pgcrypto、pgvector） | `psql --version` |
| iii Engine binary | 0.16.x | `iii --version` |
| npm | ≥ 10 | `npm --version` |

#### .env 文件（放在项目根目录）

```env
# 数据库（本地 PostgreSQL）
DATABASE_URL=postgres://postgres:password@localhost:5432/graph_test

# iii Engine WebSocket
III_URL=ws://localhost:49134

# HTTP Gateway 端口
PORT=3000

# 日志级别（Gate 1 测试时用 debug，可看完整 hash chain）
LOG_LEVEL=debug

# LLM Provider（Gate 1 不需要真实 LLM，但需要填占位值）
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=llama3
LLM_API_KEY=placeholder
```

#### iii-config.yaml（放在项目根目录）

```yaml
workers:
  - name: iii-worker-manager
    config:
      port: 49134
  - name: iii-observability
    config:
      enabled: true
      exporter: memory
      logs_enabled: true
      logs_console_output: true
```

---

### 1.2 启动顺序

**必须按顺序启动，每步等待对应的 log 出现再进行下一步。**

#### Step 1：运行数据库迁移

```bash
export $(cat .env | xargs)
psql $DATABASE_URL -f migrations/001-extensions.sql
psql $DATABASE_URL -f migrations/002-event-log.sql
psql $DATABASE_URL -f migrations/003-memory-tables.sql
psql $DATABASE_URL -f migrations/004-bus-state.sql
psql $DATABASE_URL -f migrations/005-scope-lineage.sql
```

**期望看到：** 每个 `psql` 命令返回 `CREATE TABLE` / `CREATE INDEX` 等，无错误。

**验证 schema：**
```bash
psql $DATABASE_URL -c "\dt"
```
期望出现：`execution_event_log`, `episodic_memory`, `semantic_memory`, `procedural_memory`, `working_memory`, `bus_state`, `scope_lineage`

#### Step 2：启动 iii Engine

```bash
iii --config iii-config.yaml
```

**期望看到（iii 自身日志）：**
```
[iii] Engine started on ws://localhost:49134
[iii] HTTP API on http://localhost:3111
```

#### Step 3：启动 Workers（新终端）

```bash
export $(cat .env | xargs)
node --loader tsx packages/workers/src/index.ts
```

**期望 pino 日志（LOG_LEVEL=debug）：**
```json
{"level":30,"time":...,"service":"graph-native-runtime","component":"worker","msg":"worker.registered","worker_name":"graph-workers"}
```

如果看到 4 个 `registerFunction` 完成（graph::context-assembly, graph::conflict-resolver, graph::scheduler::frontier, graph::patterns::discover），Worker 启动成功。

#### Step 4：启动 Control Plane（新终端）

```bash
export $(cat .env | xargs)
node --loader tsx packages/control-plane/src/index.ts
```

**期望 pino 日志：**
```json
{"level":30,"time":...,"service":"graph-native-runtime","component":"control-plane","module":"pulse-fetch","channel":"graph_event_ready","hwm":0,"msg":"pulse.fetch subscribed"}
{"level":30,"time":...,"service":"graph-native-runtime","component":"control-plane","msg":"boot complete — watchdog and pulse-fetch active"}
```

`hwm: 0` 表示首次启动，没有积压事件。

#### Step 5：启动 HTTP Gateway（新终端）

```bash
export $(cat .env | xargs)
node --loader tsx packages/gateway/src/index.ts
```

**期望看到：** Hono/Bun server 启动在 `http://localhost:3000`

---

### 1.3 测试 Scenario

#### Scenario A — 创建 Scope

```bash
curl -s -X POST http://localhost:3000/v1/scopes \
  -H "Content-Type: application/json" \
  -d '{"intent": "Gate 1 smoke test"}' | jq .
```

**期望 HTTP 响应（201）：**
```json
{
  "scope_id": "<uuid-v4>",
  "plan_hash": "<64-char hex string>",
  "context": {
    "stable": "You are a graph-native agent...",
    "context": [],
    "volatile": "{\"intent\":\"Gate 1 smoke test\"}"
  }
}
```

**期望 Gateway pino 日志（info 级别）：**
```json
{"level":30,"time":...,"service":"graph-native-runtime","component":"gateway","route":"POST /v1/scopes","scope_id":"<uuid>","plan_hash":"<hex64>","msg":"scope.created"}
```

**在 PostgreSQL 验证 hash chain：**
```bash
psql $DATABASE_URL -c "
  SELECT scope_id, event_type, predecessor_hash, version_hash
  FROM execution_event_log
  ORDER BY id DESC LIMIT 5;
"
```

期望看到：`predecessor_hash` 为 64 个 `0`（ZERO_HASH），`version_hash` 为 64 位 hex，`event_type` 为 `plan_created`。

---

#### Scenario B — 提交事件

用 Scenario A 返回的 `scope_id` 和 `plan_hash`：

```bash
SCOPE_ID="<scenario-A 的 scope_id>"
PLAN_HASH="<scenario-A 的 plan_hash>"

curl -s -X POST "http://localhost:3000/v1/scopes/$SCOPE_ID/events" \
  -H "Content-Type: application/json" \
  -d "{
    \"event_type\": \"task_spawned\",
    \"entity_id\": \"$(uuidgen)\",
    \"predecessor_hash\": \"$PLAN_HASH\",
    \"payload\": {\"task\": \"test task\", \"description\": \"Gate 1 verification\"}
  }" | jq .
```

**期望 HTTP 响应（200）：**
```json
{
  "version_hash": "<新的 64-char hex>",
  "occ_result": "won",
  "context": {
    "stable": "...",
    "context": [<plan_created 事件>],
    "volatile": "..."
  }
}
```

`occ_result: "won"` 表示 OCC 写入成功，第一个写入者获胜。

**期望 Gateway pino 日志（debug 级别可见）：**
```json
{"level":30,"time":...,"component":"gateway","scope_id":"<uuid>","version_hash":"<hex64>","occ_result":"won","msg":"event.written"}
```

**验证 hash chain 完整性：**
```bash
psql $DATABASE_URL -c "
  SELECT id, event_type,
         left(predecessor_hash, 8) AS pred_prefix,
         left(version_hash, 8) AS hash_prefix
  FROM execution_event_log
  WHERE scope_id = '$SCOPE_ID'
  ORDER BY id ASC;
"
```

期望看到 2 行：
1. `plan_created`，`pred_prefix = 00000000`（ZERO_HASH 前缀）
2. `task_spawned`，`pred_prefix` = 第 1 行的 `hash_prefix`（hash chain 连通）

---

#### Scenario C — 读取 Scope 状态

```bash
curl -s "http://localhost:3000/v1/scopes/$SCOPE_ID" | jq .
```

**期望 HTTP 响应（200）：**
```json
{
  "scope_id": "<uuid>",
  "event_count": 2,
  "latest_version_hash": "<最新 hash>",
  "context": { ... }
}
```

---

#### Scenario D — Zod 验证拒绝无效请求

```bash
# 无效 UUID
curl -s -X POST "http://localhost:3000/v1/scopes/not-a-uuid/events" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"task_spawned","entity_id":"bad","predecessor_hash":"bad","payload":{}}' | jq .
```

**期望 HTTP 响应（400）：**
```json
{ "error": "..." }
```

**确认 Gateway 没有访问 DB（不应有 event.written 日志行）。**

---

#### Scenario E — OCC 并发冲突

同一 `predecessor_hash` 发送两次写入，验证第二个收到 `demoted`：

```bash
# 注意：两个请求用相同的 predecessor_hash
ENTITY_A=$(uuidgen)
ENTITY_B=$(uuidgen)

# 串行发两次（第二次故意重用 PLAN_HASH 模拟 OCC 冲突）
curl -s -X POST "http://localhost:3000/v1/scopes/$SCOPE_ID/events" \
  -H "Content-Type: application/json" \
  -d "{\"event_type\":\"memory_updated\",\"entity_id\":\"$ENTITY_A\",\"predecessor_hash\":\"$PLAN_HASH\",\"payload\":{\"note\":\"A\"}}" | jq .occ_result

curl -s -X POST "http://localhost:3000/v1/scopes/$SCOPE_ID/events" \
  -H "Content-Type: application/json" \
  -d "{\"event_type\":\"memory_updated\",\"entity_id\":\"$ENTITY_B\",\"predecessor_hash\":\"$PLAN_HASH\",\"payload\":{\"note\":\"B\"}}" | jq .occ_result
```

**期望：**
- 第一个请求：`"won"`
- 第二个请求：`"demoted"`

第二个请求不应报错，应正常返回 200 with `occ_result: "demoted"`。

---

### 1.4 日志级别切换验证

**info 模式（生产默认）：**
```bash
LOG_LEVEL=info node --loader tsx packages/gateway/src/index.ts
```
只看到 `scope.created`、`event.written` 等业务事件。不显示 `pulse.replay`、hash 细节。

**debug 模式（排错用）：**
```bash
LOG_LEVEL=debug node --loader tsx packages/control-plane/src/index.ts
```
能看到每个 `pulse.replay` 行（含 `event_id`、`event_type`），hash chain 的每步写入。

---

### 1.5 Gate 1 通过标准

全部勾选后，Gate 1 通过：

- [ ] Scenario A：POST /v1/scopes 返回 201，`scope_id` 和 `plan_hash` 均为合法值
- [ ] Scenario A：PostgreSQL 中可查到 `plan_created` 事件，`predecessor_hash = ZERO_HASH`
- [ ] Scenario A：pino 日志出现 `scope.created`，含 `scope_id` 字段
- [ ] Scenario B：POST /v1/scopes/:id/events 返回 200，`occ_result: "won"`
- [ ] Scenario B：hash chain 连通（第 2 行的 predecessor_hash = 第 1 行的 version_hash）
- [ ] Scenario C：GET /v1/scopes/:id 返回 200
- [ ] Scenario D：无效 UUID 返回 400，无 DB 访问
- [ ] Scenario E：OCC 冲突第二个写入返回 `demoted`，非报错
- [ ] 全程无 pino `ERROR` 级别日志（fatal 也不行）
- [ ] LOG_LEVEL=debug 下 Control Plane 显示 `pulse.fetch subscribed`，hwm 字段为数字

**用户反馈渠道：** 将 Gate 1 结果（通过/未通过 + 失败的 Scenario 编号 + 复制的 pino 日志行）发给 AI Agent，Agent 据此 debug 后继续推进 Phase 2。

---

## Gate 2 — Phase 2 Agent Integration（占位）

**触发时机：** Phase 2 完成后。
**新增测试内容（待 Phase 2 plan 确定后填充）：**
- [ ] 真实 LLM 调用（ollama 本地）：`llm.call` 日志出现，含 token count
- [ ] Worker lifecycle 完整流转：Initializing → Processing → Writing → Terminated
- [ ] Context assembly：Knapsack slice 返回正确的 causal lineage
- [ ] ConflictResolverWorker Phase 2：LLM-assisted merge 日志

---

## Gate 3 — Phase 3 Pattern Discovery（占位）

**触发时机：** Phase 3 完成后（MIN_CORPUS=10 个 closed scope 后触发）。
**新增测试内容：**
- [ ] 10 个 scope 全部 closed 后，6h cron 触发
- [ ] `graph::patterns::discover` 执行，`skipped: false` 返回
- [ ] Pattern Discovery 不占用 OLTP Worker 槽位（观察 MAX_PARALLELISM 不受影响）

---

*最后更新：2026-06-03 | Phase 1 Gate 1 待执行*
