# ADR 44｜Gateway 实时 API：SSE/WS 双轨、本地认证、限速与 Pairing 加固

status: accepted
日期: 2026-06-11

---

## 上下文

Gateway 是纯 REST（ADR 24），Dashboard 只能轮询历史快照；MemexTerminal 需要双向 agent turn 流。Phase 11（MemexShell）需要实时 API。现状盘点：`GET /v1/stream` SSE 路由**已存在**（LISTEN `graph_event_ready`，30 秒 ping），但无认证、无限速、payload 是裸 event_id。Pairing（Phase 6）已有 salted hash / timingSafeEqual / 失败 lockout，缺无歧义字母表、生成限速、DB 持久化（TD-G）。

## 决策

### D-1：双轨——SSE 单向推送 + WS 双向会话

| 轨 | 端点 | 消费者 | 语义 |
|---|---|---|---|
| SSE | `GET /v1/stream` | Dashboard | Trail 写入通知（pulse：仅 event_id，详情 point-query——与 ADR 32 D-4 ≤64B 脉冲语义一致）；30s ping 保活 |
| WS | `GET /ws` | MemexTerminal | JSON 消息协议：`agent_event`（镜像 POST /v1/scopes/:id/events，走同一 `processAgentTurn`）→ `turn_result`；`subscribe` → `trail_event` 广播 |

消息类型定义在 `@graph/types/shell`（`WsClientMessage` / `WsServerMessage`）——Gateway 与 Shell 共享一份契约。

**`text_delta` 保留不发**：流式 LLM turn 需要 Gateway 侧驱动 LLM 调用，当前协议中 LLM 在 agent 客户端侧。枚举占位（`REALTIME_EVENT_TYPES.text_delta`），Gateway 侧流式落地时不改协议。

### D-2：认证——默认 localhost，token 门

- Gateway 默认 bind `127.0.0.1`（底线，配置显式改 `0.0.0.0` 才暴露）
- WS/SSE 连接须带 token：`Authorization: Bearer <token>` 或 `?token=`（WS 浏览器客户端无法设 header）
- token 来源：`~/.memex/config.json` 的 `gateway.token`（支持 `${ENV_VAR}`）或 `MEMEX_GATEWAY_TOKEN` env；**两者都未配置时仅放行 localhost 连接**（本机开发零配置可用，远程必须配 token）
- 校验用 `timingSafeEqual`
- REST 路由不动（已有 pairing guard 体系），本 ADR 只覆盖实时端点

### D-3：限速与背压

- 实时端点连接级限速：每 IP 每分钟 ≤10 次新连接（内存令牌桶，单进程语义——多副本是 Phase 15 命题）
- WS 消息限速：每连接每秒 ≤20 条，超速断开（code 1008）
- 背压：慢消费者不在 Gateway 内存排队——SSE 依赖 HTTP 流背压 + 客户端断线重连（pulse 语义使丢失可恢复：重连后 point-query 补齐）；WS 发送缓冲超限即断开

### D-4：Pairing 加固（TD-G，hermes 六项对齐）

已有：salted SHA-256 存储 ✓、timingSafeEqual ✓、5 次失败 lockout ✓、TTL ✓。本阶段补齐：

1. **无歧义字母表**：剔除 `0/O/1/I`（32 字符），防肉眼混淆
2. **生成限速**：同一 agentId 10 分钟内只发 1 个 code（防枚举刷 pending）
3. **DB 持久化**：`agent_pairing` 表（migration 014）——重启不失效；in-memory Map 保留为 read-through 缓存。跨副本一致性显式推迟 Phase 15（共享存储语义随远程 Gateway 一起定）

### D-5：事件枚举派生关系

`REALTIME_EVENT_TYPES` 派生自 Phase 08 pipeline hooks（`context_assembled`/`context_compressed`/`llm_called`/`result_written`）+ scope 生命周期（`scope_created`/`scope_closed`/`trail_appended`）。hooks 是事件源的语义锚——新增实时事件类型必须先有对应 hook 或账本事件，不允许凭空造枚举。

## 后果

- Dashboard/MemexTerminal 获得实时通道；REST 消费方零影响
- token 体系即 Phase 15 远程 Gateway 的本地版（加 TLS 即远程化，无捷径实现）
- 单进程限速语义在多副本部署下退化为每副本限速——Phase 15 已知边界

## 关联

ADR 24（REST 入口协议）；ADR 32 D-4（脉冲语义）；ADR 09（LISTEN/NOTIFY）；TD-G（追踪：implementation-notes Phase 6 pairing 节）；`@graph/types/shell`；migration 014。
