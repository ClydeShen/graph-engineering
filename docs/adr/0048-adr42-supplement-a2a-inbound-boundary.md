# ADR 42 补充｜A2A 入站边界与异步结果回传

status: accepted（精确化 D-3 边界声明，非推翻）
日期: 2026-06-07

---

## 背景

ADR 42 D-3 声称三协议并存，"协议层是接入适配器，不影响账本语义"。这个声明对 MCP 和 iii 成立——两者都具备拉取/竞争式认领能力（`claim_next_task` + SKIP LOCKED）。但对 A2A 是否成立，取决于流量方向，而 D-3 未明确区分这一点。

研究确认（[A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)）：A2A 是严格的点对点、客户端发起寻址协议——客户端定位特定 Agent 的 AgentCard，直接向其 endpoint 发送 `message/send`；协议本身不存在共享队列、broker、或竞争式认领原语。这与 ADR 42 D-1 明确拒绝的"显式指派"在寻址语义上同构。因此：**A2A 能否作为"不影响账本语义的适配器"，仅在入站方向成立**。

---

## 决策：精确入站边界——外部 A2A 参与者 = 请求方，非可调度执行方

| 层面 | 外部 A2A 源的角色 | 与现有机制的关系 |
|---|---|---|
| 注册 / 发现层 | 与内部 Worker、MCP Agent 形状一致——AgentCard JSON 写入 `agent_registry`，按 skill GIN 索引 | 完全复用 D-2 AgentCard 通用化，零新增设计 |
| 任务触发层 | 通过 `/a2a/rpc` 提交 `message/send`；graph-os 将其翻译为 `task_spawned` 事件写入账本（`required_skills` 从请求内容推导） | 新增账本事件**来源**，调度 / 认领逻辑不变 |
| 任务执行层 | **不参与**——内部按既有 SKIP LOCKED 拉取竞争派发给内部 Worker / MCP Agent | D-1 / D-5 完全不受影响，物理平等性、崩溃恢复均未触动 |
| 结果回传层 | 异步——任务完成后通过 A2A 原生 **webhook push notification** 机制回传给请求方 | 不需要发明新机制：A2A 规范本身原生支持"长任务 / 断连场景下服务端向客户端提供的 webhook URL POST 结果" |

**为什么 D-3 的"不影响账本语义"在此严格成立**：唯一变化是 `task_spawned` 事件多了一个外部来源。skill 匹配、SKIP LOCKED 竞争认领、完成写入、Watchdog 崩溃恢复——全部 100% 维持账本拉取模型不变。外部 A2A 源被严格限定在"提出请求"与"接收异步结果"两端，从未成为调度器尝试派发任务的对象。

---

## 范围声明

- **Outbound A2A**（graph-os 主动委托给第三方 A2A Agent）—— 不在当前范围。当前无具体外部对接系统；此方向需要解决"账本拉取模型 vs 协议点对点推送寻址"的结构性矛盾（候选方案：将"推送给外部 Agent X"封装为一个普通内部 Worker 通过常规拉取认领的任务，而非调度层的显式指派——但此设计未经验证，留待出现具体外部需求时另立 ADR）
- **最小实现**——`/a2a/rpc` 仅需覆盖：(1) 解析 `message/send` → 翻译写入 `task_spawned`；(2) 任务完成后通过 webhook 推送结果回请求方。无需实现 A2A 全部方法集
- **细化与深挖**——推迟至 Phase 6（外部集成扩展阶段）一并讨论

---

## 关联 ADR

- **ADR 42 D-2**（AgentCard 通用化）—— 注册 / 发现层完全复用，零新增设计
- **ADR 42 D-3**（协议层适配）—— 本文档精确化其边界声明：仅入站方向成立
- **ADR 42 D-1 / D-5**—— 验证：物理平等性、账本即协调者均未被破坏
