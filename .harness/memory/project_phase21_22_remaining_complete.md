---
name: project_phase21_22_remaining_complete
description: Phase 21+22 剩余开发 (GH
metadata: 
  node_type: memory
  type: project
  originSessionId: 37fedce5-81d1-4394-8af7-5e4e416f0526
---

自主 GOAL「完成所有已讨论但未开工的开发」2026-06-14 收口。范围裁定（用户确认）= **#28(workspace/project 深度集成) + #27(console 写路径/Now 美术)**；显式排除 #24(PARKED 缺活体LLM)、#26(icebox 不实现)、#25(epic 需先钻X再切片)。

**#28 落地**：`scope-project.ts`(projectFromCwd/recordScopeProject first-write-wins/isProjectArchived 懒墓碑) → execute_bash local 分支写 `scope_lineage.project`；`buildChannelChatProvider` + gateway **chat 端点**按 principal(`<platform>::<chatId>`)路由 provider（ADR-54 服务端单应答者下 seam 在服务端,非 gateway-bot 本体）；`/v1/forest` 增 projects[]（basename+archived）；`/v1/artifacts` LEFT JOIN 继承 project+project_archived；onboarding `ensureWorkspaceRoots`→`<profileDir>/workspaces/<channel>/`。**同名重建身份决策=绝对路径标签,不做 path+ctime**（与 [[project_workspace_artifact_model]] ⑦ 一致）。

**#27 落地**：`POST/DELETE /v1/sys/llm-overrides`(token 仅门控写动词,fail-closed §6.5 坏输入写前 400)；`LlmSettingsForm.tsx`(password show/hide+提交态+「重启生效」诚实提示)；`/v1/sys/config` 反映 overrides+channels.llm。**生效语义偏离 Appendix A**:持久化即时+重启生效(gateway 进程内热生效需跨路由 getter 重构,对安全敏感写面风险过高,留独立基础设施项)。Now 美术 art-selection=**程序化 2.5D 状态精灵**(无外部资源,§9 sheet 选型本待决/#27 称 design pick;保留 drawImage seam)。

**Gate**：707 测试绿(104 文件,基线 682+新25,零回归)；root+console tsc clean；console next build clean(13 路由)；DB journey(`scripts/journey-workspace.mts` vs graph_test)10/10。

**2026-06-15 续 — Now 图 3D 翻案 + 交互修复**：用户指出当初选 react-force-graph 是为 3D，现有 2d 是平面。`react-force-graph-2d`→`react-force-graph-3d`(ThreeJS/WebGL)；新增 `three`/`three-spritetext`/`react-force-graph-3d`(单一 three 副本)；共享 `lib/graph3d.ts`(hex 调色板/UnrealBloom 辉光/签名/spritetext 标签)。**并修「节点突然失控放大」bug**：根因=`onEngineStop` 每脉冲 reheat 后重复 `zoomToFit`(节点少→强 zoom-in 暴胀+抢相机)；修=**fit-once**(仅首次取景)+**diff-before-reload**(`graphSignature` 闲时脉冲不 reheat)。console tsc+next build 绿。设计 CONSOLE-REDESIGN §6.5/§7 翻案。遗留=CC0 贴图 sprite 仍是 seam + 3D 活体视觉待 dev server 跑。

**唯一遗留=BLOCKED**：#27 AC4 真 LLM+浏览器活体视觉验证（本机 Gemini key 吊销/Ollama 未装,见 [[project_console_live_test_session]]）。logic-done,待用户配可用 provider 跑活体。详见 `.harness/implementation-notes.md` 2026-06-14 节。未提交(用户未要求)。
