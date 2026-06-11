# Phase 12: connector-matrix — Phase Spec

**写入：** 2026-06-11
**用途：** `/gsd:discuss-phase 12` 与 planner 的前置输入。
**基线：** `.harness/ROADMAP.md` §12-connector-matrix；hermes 深度研究报告（`.harness/analysis/hermes-agent-deep-research-report.md`）；`11-DESIGN-NOTES.md` §1/§5。

---

## 1. 目标与定位

从"两个聊天机器人"扩展为"任意终端皆可触达的常驻系统"。本阶段的结构性主张是**配置即图**：connector 配置变更、定时任务、投递记录都是 Trail Mesh 上的一等数据——这是相对 hermes（config.yaml + jobs.json + 平台隔离 session）的差异化，规划时每个交付物都要过一遍"这个状态是否应该在图里"的检查。

## 2. 设计要点（规划前必须消化）

### 2a. ConnectorRegistry（hermes `PlatformEntry` 模式）

每个 Connector 注册元数据：`check_fn`（依赖检测）、`validate_config`、`required_env`、`standalone_sender_fn`、`platform_hint`、`pii_safe`。注册表是纯运行时对象，但**配置变更写图**（`connector::config_updated` Association）。Dashboard 状态面板直接消费元数据（Phase 11 已留好 props 驱动组件）。
**预留字段（Phase 14 消费，本阶段只定义不实现）**：`trust_level` / `allowed_toolset`——Webhook 渠道的受限工具集靠它落地，registry schema 必须现在就有这两个槽位。

### 2b. 三个新渠道的差异点

| 渠道 | 接入方式 | 关键设计点 |
|---|---|---|
| Slack | Socket Mode（无入站端口） | 与 Telegram long-poll 同构，复用 gateway-bot 进程模型 |
| Email | IMAP 轮询 + SMTP | 轮询间隔入 config；邮件 thread → sessionKey 映射（TD-E 语义直接复用）；附件暂不处理（out of scope） |
| 入站 Webhook | HTTP 端点 | **HMAC 签名校验必配**（无 secret 不启动该渠道）；不可信来源标记进 MessageEvent，Phase 14 据此限工具集 |

全部归一化为 MessageEvent（Phase 11 类型已定，`sender_id` 渠道前缀强制）。

### 2c. Graph-native Cron（新 ADR：Cron Entity schema 与触发语义）

- 定时任务 = 图上 Entity：`{schedule, prompt, deliver, origin, enabled}` Snapshot；修改任务 = 新 Snapshot（append-only，历史天然保留）
- 每次触发创建新 Scope——定时 turn 与手动 turn 用同一套 Trail 记录（09-DESIGN-NOTES 交叉引用第 3 条）
- tick 调度复用 iii-engine durable subscriber（iii-cron worker），**不另起 scheduler 进程**
- ADR 需决策：错过的 tick（系统宕机期间）是否补跑——倾向不补跑 + 记录 missed 事件（简单、可审计）

### 2d. DeliveryRouter

目标语法：`origin` / `<platform>`（home channel）/ `<platform>:<chat_id>` / `all` / 逗号组合。home channel 读 config.json（Phase 11 槽位已留）。静默标记不投递。投递失败写图（`delivery::failed` 事件），重试策略简单化：1 次重试后标记失败，不做指数退避队列（YAGNI）。

### 2e. 跨平台会话连续性（验收亮点）

依赖 TD-E（session→Scope 存图映射）。续接判定：同一 principal（Phase 13 前用 pairing 身份 + 显式 session 引用，不做自动身份合并）在另一平台引用进行中的 Scope → Knapsack 从同一 Scope 组装上下文 → 结果按 origin 投递。

## 3. 范围 Spec

**In scope：** ConnectorRegistry + Telegram/Discord 迁移入表；Slack/Email/Webhook 三渠道；Cron Entity ADR + 实现；DeliveryRouter；跨平台续接验收场景；connector 配置变更写图。

**Out of scope：**
- 跨渠道身份自动归一化（`same_as`）→ Phase 13；本阶段跨平台续接靠显式引用
- Webhook 受限工具集的**执行**（本阶段只打标记 + 留 registry 字段）→ Phase 14
- 语音/图像消息 → post-1.0；MessageEvent 类型留 `attachments?` 可选位即可
- 渠道侧富 UI（Slack Block Kit 等）——纯文本优先

## 4. DoR — 进入规划的就绪条件

- [ ] Phase 11 DoD G1（TD-E）、G5（types）、G6（config）必须全过——三者是本阶段全部交付物的地基
- [ ] ConnectorAdapter interface 冻结确认（Phase 11 §6.1 契约履行核查）
- [ ] Cron Entity ADR 在 discuss 阶段先行（schema 决定 worker 实现）
- [ ] Slack Socket Mode / IMAP 库选型短调研（各 ≤1 天，ctx7 拉文档）

## 5. DoD — 完成定义（可观测门）

| # | 门 | 验证方式 |
|---|---|---|
| G1 | 五渠道全部经 ConnectorRegistry 注册；Dashboard 面板显示各渠道 check/config 状态；缺依赖渠道 graceful skip 不崩进程 | 集成测试 + 手测 |
| G2 | Webhook：无签名/错签名请求 401 且不产生任何图写入；正确 HMAC 进入 MessageEvent 流且带不可信标记 | 安全测试 |
| G3 | Cron：建任务 → 按 schedule 触发 → 每次 tick 新 Scope → 结果按 deliver 投递；修改任务产生新 Snapshot，旧版可查 | 集成测试（短间隔夹具） |
| G4 | DeliveryRouter 五种目标语法各一测试；投递失败写 `delivery::failed`；静默标记不投递 | 单测 |
| G5 | 跨平台续接验收场景：Telegram 创建任务 → MemexTerminal 续接（上下文含 Telegram 轮内容）→ 结果回投 Telegram origin | E2E（产品级验收） |
| G6 | connector 配置变更产生 `connector::config_updated` Association，历史可查询 | 单测 |
| G7 | Email 渠道：IMAP 收 → 处理 → SMTP 回，thread 续接同一 Scope | 集成测试（本地 mail 容器） |
| G8 | 全量测试 + tsc；Cron ADR 归档；implementation-notes 更新 | CI + 人工核对 |

## 6. 前向铺路契约

1. **DeliveryRouter 是 Phase 14 审批流的推送通道**：投递 API 必须支持"等待回应"语义的消息形态（审批请求 → 用户 `/approve`/`/deny` 回流）。本阶段不实现审批，但 Router 的消息模型留 `expects_reply` 标记位。
2. **Registry 的 `trust_level`/`allowed_toolset` 字段**（§2a）：Phase 14 信任分级直接填值，不改 schema。
3. **MessageEvent 不可信标记**（G2）：Phase 14 webhook-safe 工具集的判定输入。
4. **Cron Entity 的运行历史天然入图**：Phase 10 的 PatternDiscoveryWorker 扫描器（已与过滤条件解耦）可直接分析"这个周报任务每次都在同一步骤偏离"——Phase 13+ 不需要额外管道。
5. **Email thread→sessionKey 映射**复用 TD-E 语义：Phase 13 身份归一化时邮箱地址是 `email:user@x.com` 前缀身份，无迁移成本。

## 7. 风险与开放问题

- **三渠道并行的集成测试基建**：Slack/Email 的 CI 测试需 mock 或本地容器（greenmail 类）。规划时先定测试策略再写渠道代码，避免"实现完了测不了"。
- **Email 轮询与 iii-engine 的归一**：IMAP 轮询是又一个常驻循环——确认复用 gateway-bot 的进程模型（Telegram long-poll 同款），不引入第三种进程形态。
- **Cron 触发精度**：iii-cron 的 tick 粒度与 cron 表达式语义（7 字段）需在 ADR 中声明精度边界（分钟级足够，秒级不承诺）。

---
*Phase 链：11（ConnectorAdapter/config/TD-E）→ **12** → 13（sender_id 语料、显式续接→自动归一）、14（DeliveryRouter 审批通道、trust_level 槽位）*
