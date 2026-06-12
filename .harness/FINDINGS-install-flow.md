# FINDINGS — 安装→配置→首次对话 全链路测试（2026-06-12）

> **状态（同日收口）：14 项全部处理完毕。** 实现批次 f288b68b…8bbda07a（7 commits），
> ADR 54/55/56 已 accepted，638/638 测试连续 4 轮全绿，活体冒烟复验通过
> （scope 不锁死 / trail 广播恢复 / 历史误锁清零 / 双入口清晰报错）。
> 各项落点：P1→ADR-55，P2/P3→ADR-54，P4/N1/N5/N6→ADR-56，P5/N0→memex chat 批次，
> N2/N3/N4→杂项批次，N7→doctor embedding 探测，N8→migration 021。
> 唯一遗留：配真实 LLM 的端到端对话体验验证（需要用户跑 onboarding 配真 key/本地模型），
> 属"活体批次"既有范围。

> 测试方法：活体测试（`npm run dev` 全栈 + MemexTerminalClient 协议级首次对话模拟 + `memex doctor`）
> 交叉验证：代码级审计（subagent，57 次工具调用，全部结论带 文件:行号 证据）。
> 目标态（用户定义）：`npm run dev` → onboarding（clack）→ 全栈启动 → 新终端 `memex chat` → 用 onboarding 配的 LLM 直接对话。

---

## 一、用户已报告问题的验证结果

### P1 — Embedding 硬编码 Ollama，一次失败永久锁死 ✅ 活体复现 + 加重

- 复现：`POST /v1/scopes` + WS 发首条消息 → `turn1 occ_result=won` → gateway 日志
  `context.oom err=fetch failed` → `scope.suspended.lockout` → 第二条消息直接 `suspended:true`。
- 证据：`packages/gateway/src/index.ts:57-62`（gateway embedding），`packages/workers/src/index.ts:68-73`（workers embedding），
  两处均只读 env，baseUrl 默认 `http://localhost:11434`。
- **加重 1**：embedding model 回退链是 `EMBEDDING_MODEL ?? LLM_MODEL ?? 'llama3'` — 若用户配
  `LLM_MODEL=claude-sonnet-4-6`，系统会拿 Claude 模型名去打 OpenAI embeddings 端点，必败。
- **加重 2**：`AnthropicProvider` 确认无 `embed()`（`packages/shared/src/llm/anthropic.provider.ts:14`，注释明言
  "Does NOT implement EmbeddingProvider"）。onboarding 只选 Anthropic = 第一句话必锁死，架构必然。
- ADR-39 一次 OOM 即 lockout 无重试 — 对"embedding 端点不可达"这类环境性瞬时错误过于致命。

### P2 — 对话无内部承接者 ✅ 代码证实

- 发送侧：`packages/terminal/src/client.ts:163`、`packages/gateway-bot/src/router.ts:26` 均带
  `required_skills: ['message-handler']`。
- 接收侧：全仓 grep `message-handler` 只有 4 处，全是 spawner，零实现者。
  GRAPH_OS 自身 AgentCard（`packages/gateway/src/routes/agents.ts:17-30`）技能为
  `task-routing / context-assembly / memory-retrieval / pattern-discovery`，无 message-handler。
- `claim_next_task` 是 pull 模型（`packages/gateway/src/mcp/server.ts:78`，`FOR UPDATE SKIP LOCKED`），
  任务永远停在 `pending_dispatch/pending_scheduling`。
- **衍生**：系统没有任何 "required_skills 可满足性" 校验 — 带不存在技能的任务永久排队，无告警。
- 性质：架构空缺（ADR-31 LLM-free dispatch + ADR-46 技能路由的刻意结果），不是漏注册一个 worker。

### P3 — --agent 模式双配置层 ✅ 代码证实

- `packages/terminal/src/agent-mode.ts:27-28`：`createAgentSession()` 用 Pi SDK 自己的 `~/.pi/agent` 配置，
  不注入 Memex config（ADR-22 LOCKED，刻意设计）。
- `agent-mode.ts:84-88`：graph 镜像写入失败被 `.catch(() => {})` 静默吞掉 — 对话照常进行但 trail 静默丢失，
  用户无从得知（本次 P1 场景下就是每条消息都吞一次 suspend 错误）。

### P4 — dev.mjs 与 onboarding 脱节 ✅ 证实 + 严重加重

- dev.mjs 只解析 `.env`（`scripts/dev.mjs:16-22`），不读 `~/.memex/config.json`，不触发 onboard。
- **加重（本次最大新发现）**：`config.json` 的 `providers[]` 在**全系统范围内没有任何消费者**——
  gateway 只拿 config 的 `database.url` fallback（`packages/gateway/src/index.ts:132-135`）和 `gateway.token`；
  workers 的 `createLLMProvider()` 只读 env（`packages/workers/src/index.ts:59-65`）。
  即 onboarding 让用户精心配置的 LLM provider 被运行时静默忽略，是"写了没人读"的假配置。

### P5 — memex chat 不存在 ✅ 证实 + 加重

- `packages/cli/src/index.ts:46` KNOWN 列表无 `chat`。
- **加重**：未知子命令 fallback 到 `connect`（`index.ts:46-49`）——用户敲 `memex chat` 会莫名弹出
  "Which agents to connect?" 多选框。
- MemexTerminal 入口在 `packages/terminal`（bin: `memex-terminal`），未挂到 `memex` CLI。
- terminal 默认 gateway 地址 `127.0.0.1:3000`（`packages/terminal/src/index.ts:20-28`，
  来自 `config.gateway.port ?? 3000`），与 `.env PORT=4000` 不一致 — 即使有 message-handler 也连不上。

---

## 二、本次测试新发现的问题

### N0 — memex CLI 未全局可用（安装第一步就断）

- 实测 `Get-Command memex` → NOT FOUND。bin 字段存在（`packages/cli/package.json:6-8`），但 workspace 安装只链到
  `node_modules/.bin`，没有任何文档/脚本引导 `npm link`。新用户连 `memex onboard` 都无法运行。

### N1 — console 与 gateway 端口冲突（PORT 环境变量泄漏）★活体确认

- `scripts/dev.mjs:175-179` 把整个 `appEnv`（含 `.env` 的 `PORT=4000`）传给 console 子进程；
  Next.js 读 `PORT` env → console 绑 4000 而非默认 3000。
- 实测结果：gateway 绑 IPv4 `127.0.0.1:4000`，console 绑 IPv6 `[::1]:4000`，两者共存——
  浏览器 `localhost:4000` 打到 console（IPv6 优先）、`127.0.0.1:4000` 打到 gateway，
  banner 宣称的 `localhost:3000` 无人监听。纯属巧合才"都能用"，行为随 OS 解析顺序漂移。

### N2 — `scheduled` trigger 类型不存在 ★活体确认

- iii 启动日志 `[ERROR] iii::trigger Trigger type scheduled not found`。
- 来源：`packages/workers/src/integrations/mcp-client.worker.ts:17`、
  `packages/workers/src/memory/user-profile.worker.ts:6` 注册 `type: 'scheduled'`，iii 只认 `cron`。
- 后果：这两个 worker 的定时触发静默失效。

### N3 — pulse-replay 函数名不匹配 ★活体确认

- ctrl 重放 `sub_scope_resolved` 事件时直呼 `graph::scope::sub_scope_resolved` → iii `Function not found` ×5；
  worker 实际注册名是 `graph::scope::sub-scope-result`（只挂了 queue 订阅）。
- 后果：实时路径（queue）能走，replay 路径全部 skip — 重启后未处理的 sub_scope_resolved 事件丢失处理机会。

### N4 — WS trail_event 广播实测零接收 ★活体确认，根因待查

- 实测：WS subscribe(scope_id) 后写入 2 个事件，0 条 trail_event 广播。
- 已排除：`pg_notify('graph_event_ready')` 调用存在（`packages/shared/src/occ-write.ts:77,117`）；
  broadcaster onOpen 启动 LISTEN（`ws-protocol.ts:198-204`）；DB 无 NOTIFY trigger（设计上由应用代码发）。
- 待查方向：Node (`@hono/node-ws`) 适配器 onOpen 是否触发 / LISTEN 连接被 best-effort catch 吞错 / 订阅时序。
- 影响面：console 实时刷新、terminal trail 视图全部依赖此通路。

### N5 — doctor 不读 .env ★活体确认

- repo 根目录跑 `memex doctor`，`.env` 里有 `DATABASE_URL` 仍报 `✗ postgres no DATABASE_URL`。
- dev.mjs 自己解析 .env、CLI 不解析 — 配置源三分裂（.env / config.json / process env）的又一例。

### N6 — doctor 的 gateway 探测端口错误 ★活体确认

- doctor 探测 `http://127.0.0.1:3000`（config gateway.port 默认 3000），实际 gateway 在 4000（.env PORT）。
- 全栈正常运行时 doctor 仍报 `! gateway not running`，诊断工具自身误报。

### N7 — doctor 缺关键检查项

- 不检查 embedding 端点可达性（P1 这种"第一句话锁死"的故障 doctor 查不出）；
- 不警告 config.json providers[] 与运行时实际消费源（env）的脱节（P4）。

### N8 — 脏数据累积（观察项）

- `/v1/sys/health`：live_scopes=51、suspended=5 — graph_test 库里历次测试残渣堆积，
  每个 suspended scope 都是一次性死亡，无恢复/清理路径。

---

## 三、目标态 vs 现状 差距矩阵

| 目标态步骤 | 现状 | 阻断问题 |
|---|---|---|
| `npm run dev` 先弹 onboarding | dev.mjs 不检查/不触发 onboard | P4 |
| onboarding 配置所有 LLM provider | onboard 流程完整，但写出的 providers[] 无人消费 | P4(加重) |
| 全栈一起启动（iii/ctrl/workers/gateway/console） | 能启动，但 console 端口冲突、scheduled trigger 失效、replay skip | N1 N2 N3 |
| 新终端 `memex chat` 进入 MemexTerminal | 命令不存在，fallback 到 connect 提示 | P5 N0 |
| 直接用 onboarding 配的 LLM 对话 | 第一句话 OOM 锁死（embedding）；即使不锁死也无人应答（message-handler） | P1 P2 |

## 四、修复路线（2026-06-12 fuller 会话拍板，架构决策已落 ADR 54/55/56 提纲）

> 决策过程：以 Hermes 标本（D:\Repo\specimens\hermes-agent）为参照做交叉研究后逐支拍板。
> 五项结构决策：① 本弧=修复开箱体验，解与 MemexShell 兼容；② 应答者=gateway 侧无状态
> 对话核心（ADR-54）；③ embedding=迟到投影+故障重分类（ADR-55，修订 ADR-39）；
> ④ ProviderProfile 声明表+config 单权威（ADR-56）；⑤ 首版范围=聊天+memex_retrieve+text_delta。

按依赖排序：

1. **ADR-56 配置统一**（解 P4/N1/N5/N6 根因）：内置 ProviderProfile 声明表（@graph/shared），
   onboarding/doctor/运行时全部从表派生；config.json 单权威，apiKey 支持 env 引用；
   fallback 链激活 priority 字段；dev.mjs onboarding gate + console env 净化 + 端口单源。
2. **ADR-55 记忆韧性**（解 P1/N7/N8 根因）：故障分类器（环境错误 ≠ 溢出，lockout 只留真溢出）；
   embedding 按 version_hash 幂等排队回填；检索降级走 pg 全文/BM25（挂靠 ADR-20 supplement）；
   doctor 加 embedding 探测（warn 非 fail）；onboarding 不强制 embedding。
   附带：清理/解锁历史误锁死的 suspended scope（N8）。
3. **ADR-54 对话核心**（解 P2/P3 根因）：gateway 侧无状态应答循环，每 turn 从图投影；
   聊天 + memex_retrieve 单工具 + text_delta 流式（兑现 ADR-44 预留槽位）；
   message-handler 语义归还给异步任务；渠道经 DeliveryRouter 回发。
4. **`memex chat` 接线**（解 P5/N0）：挂 MemexTerminal 到 memex CLI；未知子命令报错而非
   fallback connect；安装文档加 `npm link`。
5. **杂项修复**：N2（scheduled→cron）、N3（函数名对齐）、N4（trail 广播排查——已从对话
   关键路径移除但仍需修）、P3（.catch 至少记一条 stderr）。

明确不做（本弧）：Hermes 插件目录机制、credential 轮转、完整 agentic 循环（MemexShell 正篇）、
本地单空间记忆基座（记 ROADMAP 远期）。

---
*测试产物：`scripts/tmp-live-test.mts`（已删除）；dev 栈日志 `/tmp/memex-dev.log`（Git Bash tmp）。*
*架构决策提纲：docs/adr/0063-adr54 / 0064-adr55 / 0065-adr56（status: proposed）。*
