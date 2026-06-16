---
name: project_console_redesign_now_universe
description: Console 人类视角重设计全弧收口；权威=docs/CONSOLE-REDESIGN.md(§1-11+附录AB)；执行=ROADMAP 21-console-redesign + 22-workspace-project；引擎翻案 g6→react-force-graph
metadata: 
  node_type: memory
  type: project
  originSessionId: bb96dcd5-9f1b-4e6b-a833-e94661782d9a
---

2026-06-13~14 经多轮 /fuller 把 Console 重设计**全部收口**，落 `docs/CONSOLE-REDESIGN.md`（v2.0，SSOT，取代已归档 UI-SPEC.md）。**仍未实现，文档是 SSOT**；执行入口已编入 `.harness/ROADMAP.md`：**21-console-redesign**（UI 弧）+ **22-workspace-project**（引擎弧）。

锁定不变量：图=SSOT、append-only、console 只读投影（除显式写面）、翻译只在表现层。受众=人类操作者单受众。

**Now 英雄页**（结构锁定，不变）：可缩放宇宙，星系=channel（从 `intent=session:<platform>::<chatId>` 解析）；L0宇宙→L1星系→L2 `scope_lineage` 树→L3 节点+旁白流；实时=SSE `/v1/stream` 脉冲 + REST 对账；渲染分层（L2/L3 跑 rAF，L0/L1 事件微光）。**引擎=react-force-graph-2d**（翻案史：react-force-graph→g6→最终回 react-force-graph-2d，用户对比真实例子嫌 g6 平/丑）；代价=移除 @antv/g6、重写 TopologyCanvas→ForestCanvas。节点美术经 `nodeCanvasObject`，候选 AI Town/Kenney CC0 小人精灵（结构不变，美术选型推迟到执行步骤2）。

**§9 待决全部收口**（每项都先查机制真相再定，多数发现原框法是伪命题）：
- **Notification→奥卡姆删除**：`/alerts` 本就只读零操作；suspended=watchdog OOM 故障(ADR-0024)无解挂路径；用户交互全在 channel/terminal。信号已由健康条 suspended_count 徽标 + Now 节点 rust 色覆盖。删页删 `/alerts`。
- **Emergence→lessons feed**：crystallize.worker 产物本就是 LLM 散文(`procedural_memory.content`)，"翻译"是伪命题；真缺口=无 list 端点。新建 `GET /v1/emergence`，呈现=markdown+confidence 人话徽标。顺带记 `/skills` 页误把 SKILL.md 标成 lesson（Plugins 拆分时解混淆）。
- **Kernel→奥卡姆删除**：`/kernel` 是纯 infra 遥测(池槽位/队列积压)，对受众无意义；home 仪表盘已覆盖。健康裁决留健康条，原始遥测走 `memex log`。删页。
- **Overview→富人话仪表盘**（非裁剪，用户明确要更丰富多维）：v1=现成4维纯前端(任务状态/健康裁决/活跃度/动作类型翻译)，v2=按端点跟上(来源/成效/学习/活动流)。锁定 event_type→人话标签映射。
- **Workspace→§11 引擎级设计**：Project=记在 scope 上的"工作文件夹/cwd"维度（observable fact，非新实体/注册表，守 SSOT）；artifact/Now/Workspace 继承；"距离即分簇"。per-channel LLM 配置=缺失的"agent 身份"功能(多 agent×多 project)。Bad-path=懒墓碑（图不改，访问时检测，投影显归档，复用 ADR-43 erase+404/410）。

**新建只读端点**（21 交付物1，纯 SELECT）：`/v1/forest`、`/v1/scopes/:id/lineage`、`/v1/emergence`、`/v1/artifacts`（全局交付物）。

**附录**：A=可写 LLM Provider/Model 设置（console 唯一已知写例外，设计就绪未实现）；B=游戏化 UX & 动效规格（trim tab=Now 手感；动效/tabular token 地基可最先摘；reduced-motion canvas 须 JS 显式停循环——CSS 管不到）。

**仍开放（§9 B 类，未定）**：per-channel LLM 配置 schema/UI、Plugins 页设计、§11 同名重建身份、onboarding 文件夹结构。

相关：[[project_ui_console_arc_complete]]（现状基线）、[[project_channel_connectivity_fix]]（渠道遗留→已编入 ROADMAP TD-N）、[[feedback_reanchor_on_original_design_when_drifted]]、[[feedback_language_chinese]]。
