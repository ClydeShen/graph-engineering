---
name: project-live-batch-findings
description: 开箱体验修复弧已完成（2026-06-12）——FINDINGS 14 项全关账，ADR 54/55/56 accepted+实现，638 tests；遗留=真 LLM 活体对话验证
metadata: 
  node_type: memory
  type: project
  originSessionId: d8eac67b-bd9e-4b12-9478-e6bc9f1f8675
---

2026-06-12 单日完成：活体测试（14 项发现）→ fuller 拍板（5 项架构决策）→ **全部实现落地**
（commits f288b68b…8bbda07a，7 个提交，638/638 tests 连续 4 轮绿，活体冒烟复验通过）。

落地内容：
1. **ADR-56**（accepted）：PROVIDER_PROFILES 声明表（@graph/shared/llm/provider-profiles.ts），
   onboard/doctor/运行时全派生；config.json 单权威；fallback 链激活；端口统一 DEFAULT_GATEWAY_PORT=4000
2. **ADR-55**（accepted）：故障分类（lockout 只留真溢出）；embedding_backlog（migration 020）+
   EmbeddingBackfillWorker 自愈回填；memReflect BM25 降级（degraded 标志）；migration 021 解锁历史误锁
3. **ADR-54**（accepted）：gateway 对话核心（conversation/core.ts，无状态、每 turn 从图投影）；
   WS user_message + text_delta（槽位激活）+ REST /chat（tokenAuth）；对话回合 = memory_updated
   conversation.user/assistant + turn_id；渠道 dispatchMessage 返回真回复；
   顺带修了 AnthropicProvider system 参数 400 潜在 bug
4. `memex chat` 子命令；未知子命令报错；OCC 死锁重试（40P01）；GATE4 测试唯一技能防互偷

**Why:** 用户目标态（npm run dev → onboarding gate → 全栈 → memex chat 对话）代码层面全通。
**How to apply:** 唯一遗留 = 用户用真 key/本地模型跑 onboarding 后做端到端对话活体验证（"活体批次"
既有范围，连同 3 平台安装/docker/渠道命令路由等 pre-existing 清单在 state.json stopped_at）。
不要重开已拍板分支；FINDINGS 文档头部有全部 14 项的落点映射。
