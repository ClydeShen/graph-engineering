---
name: project_console_live_test_session
description: "Console live-test session — dev/test DB split, Now canvas fixes, blocked on revoked Gemini key"
metadata: 
  node_type: memory
  type: project
  originSessionId: bb96dcd5-9f1b-4e6b-a833-e94661782d9a
---

2026-06-14 会话:重启 dev 活体测试 Console(Phase 21-console-redesign),发现并修了三类问题,最后卡在死凭证。

**1. dev/test 分库(durable 环境事实)** — `.env` 原本 dev 和集成测试共用 `graph_test`,每次 `npm test` 灌入 GATE4/G3 fixture(386 scope),污染 Console。已分:`DATABASE_URL`→`graph`(dev 专用,已建库+22 迁移全过),新增 `TEST_DATABASE_URL`→`graph_test`;`vitest.config.ts` 用 env override 强制测试走 `TEST_DATABASE_URL`(回退 graph_test)。`.env.example` 同步。验证:graph=0 scope、graph_test=386 不动、集成测试连库绿。commit 746358d2。

**2. Now 画布修复(commit 30865ec1 + 41413f0a)** — ForestCanvas/UniverseCanvas 两个 bug+增强:
- **非全屏 bug**:ResizeObserver 的 effect 在 `data===null`(渲染 loading)时跑、wrapRef 为 null 直接 return,数据到了不重跑 → size 卡 800×480。改成 ref 容器恒挂载、loading/空状态做内部 overlay。
- **highlight**:hover 提亮节点+邻居+连边、其余 globalAlpha 压暗(adjacency Map)。
- **P1 三项(基于 react-force-graph 官方文档)**:`onEngineStop`→`zoomToFit(500,48)` 框图(治截图"挤中心被裁")、`autoPauseRedraw={false}`(让 highlight/SSE 重绘)、`forceCollide`(galaxy r28/task r13 摊开重叠)。新增 `d3-force-3d` 显式依赖 + `src/types/d3-force-3d.d.ts` 最小声明。reduced-motion 下 zoomToFit ms→0。

**3. 当前活体阻塞(未解决)** — Chat 发 "hi" → `403 Forbidden`。根因:`~/.memex/config.json` 的 Gemini key(`.env` 的 `GEMINI_API_KEY=...qHRbgg`)被 **Google 判定泄露并吊销**("Your API key was reported as leaked")。本地 Ollama 没装(不在 PATH、无 qwen3/bge-m3 模型)→ 本地兜底短期不可用。**用户已让停 dev,自己手动开 + 手动 onboarding** 配新 key。等用户 onboarding 完、Chat 通了,再验证第一个节点种进 `/now` + P1 效果。

**安全**:`.env` 的 Slack/Telegram token 也暴露在对话历史,建议轮换。

详见 [[project_console_redesign_now_universe]](权威设计 docs/CONSOLE-REDESIGN.md)。16 commit 未推送(用户未要求 push)。
