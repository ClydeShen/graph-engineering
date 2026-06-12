# ADR 54｜对话核心：gateway 侧无状态应答循环（MemexShell 种子）

status: accepted（2026-06-12 实现落地；提纲源自同日 fuller 会话拍板）
日期: 2026-06-12

---

## 上下文

活体批次首轮测试（`.harness/FINDINGS-install-flow.md`）确认：用户消息以
`required_skills: ['message-handler']` 进入 pull 式技能路由，但全系统零实现者——
"开箱即聊"在当前架构里没有承接角色（P2）。

Hermes 标本研究（D:\Repo\specimens\hermes-agent）给出参照：应答者（LLM loop）是
进程内库核心，CLI/TUI/gateway/cron 全部直调同一核心，**对话不经过任何任务分发层**；
分发/路由是给异步任务的，对话是同步循环。

原始设计证据：`ws-protocol.ts` 协议注释 "text_delta is reserved (enum slot) until
**gateway-side LLM streaming** lands"——gateway 侧 LLM 流式本就是预留方向。

## 决策

### D-1：应答者 = gateway 侧进程内对话核心

不是注册 message-handler 的 worker，不是外部认领 agent，不走 task_spawned →
claim 链路。gateway 进程内置对话核心（MemexShell 的种子模块）；terminal 与
gateway-bot 各渠道共享同一宿主。LLM key 只存在于配置所在的服务端——跨机器
`memex chat` 不需要本地配 key。

实现：`packages/gateway/src/conversation/core.ts`（runConversationTurn）；
入口两个——WS `user_message` 消息（terminal）与 `POST /v1/scopes/:id/chat`
REST（gateway-bot 渠道、非 WS 客户端）。

### D-2：核心无状态——Graph → Context，每 turn 从图投影

对话核心**不持有消息列表**（Hermes AIAgent 的 `Context = State` 模式与 Memex 范式
冲突，明确不抄）。每 turn：用户消息照常 OCC 写图 → `processAgentTurn` 返回 context
投影（现成机制）→ LLM 调用消费投影 → 助手回合作为事件写回图。

事件类型落定：对话回合记为 `memory_updated`，payload kind =
`conversation.user` / `conversation.assistant`，带唯一 turn_id（防 TD-B 去重窗误杀）。
不引入 `memex::turn::*` 新账本事件类型——OCC 写路径的 event_type 枚举
（task_spawned|memory_updated，ADR-40 哈希公式一等列）扩枚举的迁移成本
超过收益；对话回合本质上就是一次记忆写入。

### D-3：首版范围 = 聊天 + memex_retrieve 单工具 + text_delta 流式

- 纯聊天循环之上**只**加 `memex_retrieve` 一个工具：投影的 stable 系统提示已向 LLM
  承诺"被裁剪事件可经 memex_retrieve 取回"，无工具则承诺为空头支票；工具已作为
  MCP 工具实现，复用不新建。
- `text_delta` 填入 ADR-44 预留的协议槽位，WS 流式回传。
- 完整 agentic 循环（工具集/技能/MCP 调度）= MemexShell 主战场正篇，明确不在本弧。

### D-4：message-handler 语义归还

terminal/gateway-bot 的对话消息不再 spawn `required_skills: ['message-handler']`
任务；该技能路由保留给真正的异步 agentic 任务（外部 agent 经 `claim_next_task`
认领）。渠道链路：渠道消息 → gateway 对话核心 → DeliveryRouter 回发。
ADR-31（dispatch LLM-free）、ADR-46（技能路由）不动——对话不再被迫穿过它们。

### D-5：provider 消费

对话核心从 ADR-56 的 ProviderProfile 声明表构造 chat provider，支持 fallback 链。

## 后果

- `memex chat` 开箱即聊成为可能（CLI 子命令接线见 FINDINGS 工程项）
- 第一句话无人应答（P2）、--agent 模式错配（P3 部分）随之解决
- trail 广播（N4）从对话关键路径上移除——仍需修，但不再阻塞聊天

## 关联

- ADR-31（dispatch LLM-free，不变）/ ADR-44（WS 协议，text_delta 槽位兑现）
- ADR-46（技能路由，语义归还）/ ADR-22（Pi 双层配置，--agent 模式维持隔离）
- ADR-55（记忆韧性）/ ADR-56（provider 注册表）
- `.harness/FINDINGS-install-flow.md`（问题清单与证据）
