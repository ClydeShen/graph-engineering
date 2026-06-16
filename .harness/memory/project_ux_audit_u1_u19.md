---
name: project-ux-audit-u1-u19
description: "挑剔用户 UX 审计弧（2026-06-13, b015ea73）——U1 HWM 致命 bug 修复 + 19 项 findings 全处置"
metadata: 
  node_type: memory
  type: project
  originSessionId: d8eac67b-bd9e-4b12-9478-e6bc9f1f8675
---

2026-06-13 完成"挑剔用户多终端模拟"UX 审计（.harness/FINDINGS-ux-audit.md，U1–U19）。

最重发现 U1：`advanceHwm` 只 UPDATE 不 INSERT，bus_state 永远空 → 每次启动重放全部
历史事件（sub_scope_resolved 真实调 LLM 烧 token），重放风暴压垮 workers 触发重连
风暴（U2 cron 重复注册、WS error ×27）。修复 = UPSERT + GREATEST。第三次启动 0 噪音。

U18：gateway /v1/skills 默认读 ./skills（cwd），CLI 装 ~/.memex/skills——console
Skills 页永远空。已改 memexHome()/skills + detail 路由接受安全目录名。

未修留档：U17（Topology/Artifacts 需手输 uuid，无 scope 选择器——设计改进项）、
U14（telegram 渠道未配，既有）、canvas 节点点击自动化盲区（force-graph 不认合成
事件，Inspector 需人工点验）、引擎侧 cron 去重/watcher 粒度（iii 上游）。

测试基线 638；与活跑 dev stack 并跑全量测试时 gate4 teardown DROP TABLE 会死锁
（环境冲突非回归，单跑即绿）。相关 [[project-live-batch-findings]]。
