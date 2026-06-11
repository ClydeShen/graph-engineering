# Phase 11: memex-shell — Phase Spec

**写入：** 2026-06-11
**用途：** `/gsd:discuss-phase 11` 与 planner 的前置输入。
**基线：** `.harness/ROADMAP.md` §11-memex-shell + 技术债轨道 TD-E/F/G/H；`11-DESIGN-NOTES.md`（标本对比）；三层架构锁定（MemexOS/Core/Shell）。

---

## 1. 目标与定位

在 MemexCore 稳定基础上构建交互层。**铁律：Shell 不拥有状态，所有状态在 Core 的 Graph 里；Shell 是 Gateway REST/WS 的纯客户端。** 本阶段同时是 Phase 12–15 的接口奠基段——ConnectorAdapter、config.json、WS 认证、`@graph/types` 四样东西的形状决定后续四个阶段的施工难度。

## 2. 设计要点（规划前必须消化）

### 2a. WS/SSE ADR（本阶段第一个 ADR，范围已在 ROADMAP 锁定）

- 双轨：SSE（`GET /events`，Dashboard 单向）+ WebSocket（`/ws`，MemexTerminal 双向）
- 事件类型枚举从 Phase 08 hooks 派生：`context_assembled` / `context_compressed` / `llm_called` / `result_written` + scope 生命周期事件——**枚举写进 `@graph/types/api`，Shell 与 Gateway 共享**
- 本地认证：默认 bind localhost 为底线；连接 token 机制（与 TD-G pairing 同一 ADR 章节）；端点限速
- 背压策略：慢消费者断开重连（SSE `Last-Event-ID` 续传），不在 Gateway 内存排队

### 2b. TD-E：session→Scope 稳定映射（本阶段关键路径，Phase 12 硬前置）

现状：`dispatchMessage` 每条消息 `randomUUID()` 新建 Scope——会话上下文不在图中累积。目标语义：同一 `sessionKey` 映射稳定 Scope（经 `nestScope()`），上下文经 Knapsack 从同一 Scope 组装。设计点：
- session→scope 映射**存图**（不是 gateway 内存表）——重启不丢、跨副本天然一致、Phase 12 跨平台续接直接查图
- Scope 何时关闭：会话空闲超时（如 30 分钟无消息 → `scope_closed`），新消息再来开 child scope 接续 lineage——讨论阶段定阈值与语义
- 这个修复同时服务 Telegram/Discord（Phase 6 存量）与 MemexTerminal（本阶段新建）

### 2c. TD-G：Pairing 加固（hermes 六项标准，11-DESIGN-NOTES §3）

salted SHA-256 code 存储、无歧义 32 字符字母表、rate limit（同用户同平台 10 分钟 1 次）、5 次失败 lockout 1 小时、`timingSafeEqual` 比较、存储从 in-memory Map → DB 持久化。跨副本同步显式推迟 Phase 15。

### 2d. `@graph/types` 现状修正

ROADMAP 写"新建 packages/types"——**实际已存在**（架构 sprint 产出，现存 `api.ts`；`core.ts`/`shell.ts` 已裁撤）。本阶段任务是**补全分层**而非新建：`core`（Entity/HyperEdge/Scope/Lesson/Trail，零依赖）、`api`（REST+WS contract，含 §2a 事件枚举）、`shell`（Dashboard state、MemexTerminal session，继承 Pi SDK 官方 interface 不重定义）。迁移方式：各 package 删除重复定义改 import，tsc 把关。

### 2e. 配置分层（最终落地）

`iii-config.yaml` → MemexCore；`~/.memex/config.json` → 全系统（Gateway 端口/TLS、channel tokens、provider 注册表、Shell 连接地址、WS 开关）。env 引用 `${VAR}` startup 展开，解析值不写回磁盘。**TD-H 同时清账**：gateway 的独立 `gatewayLlmProvider` 收编进 `createLLMProvider()` 注册表路由——落地后全系统只有一条 provider 构造路径。

## 3. 范围 Spec

**In scope：** WS/SSE ADR + 实现；`@graph/types` 三层补全与迁移；`~/.memex/config.json` + provider 注册表 + FallbackProvider（熔断分类：timeout/rate_limit/overloaded → failover；auth/context_length/content_filter → 直接报错）；MemexTerminal（Pi SDK，`/ws`，SKILL.md 两阶段加载）；Onboarding TUI（`@clack/prompts`）；Dashboard（图可视化、SSE 订阅、Trail Discovery 结果展示）；`memex connect` CLI；pi-extension 补 stub fetch（TD-F）；TD-E/G/H 清账。

**Out of scope：**
- 渠道矩阵扩展（Slack/Email/Webhook）、cron、DeliveryRouter → Phase 12
- 跨渠道身份归一化 → Phase 13（但 `sender_id` 渠道前缀约定本阶段写进 `@graph/types/api` 的 MessageEvent 类型——类型先行，零实现成本）
- 远程 Gateway TLS、跨副本 → Phase 15
- 移动端/响应式 Dashboard —— 桌面浏览器优先

## 4. DoR — 进入规划的就绪条件

- [ ] Phase 10 DoD 全过（Dashboard 的 Trail Discovery 展示有真数据；Phase 08 hooks 是 WS 事件源）
- [ ] Pi SDK 版本锁定 + `createAgentSession`/`subscribe` API 文档复核（用 ctx7 拉当期文档，不凭训练数据）
- [ ] UI-SPEC.md 设计基线复核（LLM-settings 可写入设计已有结论，Dashboard 规划须沿用）
- [ ] discuss 阶段头两个议题定序：① WS/SSE ADR（含 pairing 加固章节）② TD-E 的 session 关闭语义

## 5. DoD — 完成定义（可观测门）

| # | 门 | 验证方式 |
|---|---|---|
| G1 | TD-E：同一 `sessionKey` 两条消息 → 同一 Scope lineage；第二条消息的 LLM 上下文含第一条的图内容；空闲超时后 scope_closed、再续走 child scope | 集成测试（核心验收） |
| G2 | MemexTerminal 经 `/ws` 完成完整 agent turn：发消息 → 流式 `text_delta` → `result_written`；断线重连不丢会话（状态在图） | E2E 手测 + 自动化 |
| G3 | Dashboard 经 SSE 实时收到新 Trail 通知；图可视化能 inspect Entity/Association/Lesson；Trail Discovery 模板可视 | E2E 手测 |
| G4 | 认证与限速：无 token 的 WS/SSE 连接被拒；超速请求 429；pairing 六项加固各有测试（哈希存储、rate limit、lockout、constant-time） | 安全测试集 |
| G5 | `@graph/types` 迁移完成：全仓 grep 无重复类型定义（Entity/Scope/Lesson 等只在 types 包声明一次）；tsc 全绿 | grep + CI |
| G6 | config.json：env 展开、provider 注册表切换不改代码、FallbackProvider 熔断分类按表生效；TD-H——全仓只有 `createLLMProvider()` 一条构造路径 | 单测 + grep |
| G7 | Onboarding 全新机器路径：无 config → 引导完成 → MemexTerminal 可用，全程不写 graph | 全新环境手测 |
| G8 | pi-extension 真实 fetch（stub 清除）；`memex connect` 对本地 Gateway 完成认证绑定 | 集成测试 |
| G9 | 全量测试 + tsc；implementation-notes 更新；新 ADR（WS/SSE）归档 | CI + 人工核对 |

## 6. 前向铺路契约

1. **ConnectorAdapter interface 定稿即冻结**（Phase 12 五个渠道全部实现它）：interface 须包含 Phase 12 已知需求的槽位——`platform_hint`（注入 system prompt）、`standalone_send`（无 live gateway 投递）、配置自验证。**宁可本阶段多留可选方法，不要 Phase 12 改 interface 重训五个实现。**
2. **MessageEvent.sender_id 渠道前缀**（`telegram:12345678`）从类型层强制（template literal type / 校验函数）——Phase 13 身份归一化的零成本预留。
3. **config.json 预留 Phase 12 槽位**：`channels.<platform>.home_channel`、`webhook.hmac_secret` 的 schema 占位（值为空），Phase 12 不改 config 结构只填值。
4. **WS token 认证机制即 Phase 15 远程 Gateway 的本地版**——设计时确认同一 token 体系加 TLS 即可远程化，不要做成"本地专用"的捷径实现。
5. **Dashboard 的图可视化组件接受数据注入**（props 驱动，不自取数据）——Phase 12 connector 状态面板、Phase 14 安全事件视图复用同一组件族。

## 7. 风险与开放问题

- **范围最大的阶段**：7 个交付物 + 4 项债务。讨论阶段应按依赖切 wave：types+config+WS/SSE ADR（奠基）→ TD-E+Gateway 实现 → Terminal+Dashboard+Onboarding（可并行）→ cli+pi-extension。若需砍范围，优先砍 Dashboard 可视化的丰富度，**不可砍 TD-E 与 ConnectorAdapter 接口质量**（Phase 12 硬前置）。
- **Pi SDK 是外部依赖**：版本变动风险。pi-extension 与 MemexTerminal 共享一个薄适配层，SDK breaking change 时只改一处。
- **Bun/Node 双运行时**（TD-M，Phase 15 清账）：本阶段新增 Gateway 代码时避免加深 Bun 专属 API 依赖，为 15 的收敛评估留路。

---
*Phase 链：10（hooks/数据）→ **11** → 12（ConnectorAdapter/config 槽位/TD-E）、13（sender_id 前缀）、15（token 认证体系）*
