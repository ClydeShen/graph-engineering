---
name: emergence-loop-validation
description: "Emergence-loop A/B (#24): freeze trigger fired 2026-06-16, executed. Two permanent artifacts LANDED to master; A/B re-PARKED on F-1 (#29). Read for state."
metadata:
  node_type: memory
  type: project
  originSessionId: 151d19e7-1ea8-47b6-a8d3-a25a82a9b53c
---

## ⚡ UPDATE 2026-06-16 — freeze trigger fired, run executed

用户说「可 freeze」→ 跑了约定的 git 卫生流（branch→worktree+junction node_modules→build→merge FF→remove→验净，全清）。结果：

**✅ 两永久件已 merge 进 master (`11ef17e5`，含原 `65bbd092`)：**
- **注入开关** `MemReflectInput.inject_procedural`（默认 true）→ 跳过 procedural+anti 两层、留 episodic/semantic；单点 env 接缝 `MEMEX_INJECT_PROCEDURAL`（`0`/`false`=OFF）在 process-agent-turn（不透 5 caller）。
- **failure_count 写入路径** `penalizeInjectedTemplates`（template-injection.ts）→ 挂起(context-OOM)=非收敛终态时 `failure_count+1`，对称于收敛闭包的 `success_count+1`，关掉不可证伪 hitRate。挂在 process-agent-turn 的 context_length 分支，靠 checkSuspended 短路天然幂等。
- 386 包测试 + 31 定向测试绿，typecheck 绿，零回归。

**⛔ A/B 本体 PARK 在新 issue #29（F-1，live-verified）：**
- **F-1 = 正常 gateway+MCP 路径下 scope 永不收敛**。穷尽 grep：终态写入只有 frontier 环检测终止 + scope_closed 自身 + OOM suspended——**happy path 没有任务终结器**。活体探针 `scripts/eval/ab-convergence-probe.ts`(已进 master) 实测：plan_created→spawn→claim→complete 全程 `is_converged=false`，连空 scope 都不收敛（事件停在 pending_scheduling/processing）。
- ⟹ 涌现回路**成功侧**(`scope_closed→reinforceTemplate→success_count+1`)正常操作下**不触发**——比 failure_count 缺口更深的同类 Proxy Signal。
- ⟹ A/B 因变量「到收敛事件数」在 F-1 修好前无法 instrument。**#24 继续 PARK 在 #29 上**（#29=加 happy-path 任务终结器，动核心生命周期/需 ADR，open design Q：complete_task 终结 task_spawned 行 + plan_created 终态？）。

**⚡ 续 2026-06-16(同会话)**：
- **受控装置已建+跑**(exp/emergence-ab-harness worktree,未并 master)：trap①有序流水线+门控load + 黄金模板种子 + 活体 LLM agent loop。结论 **GO**——注入可靠把 agent 引离陷阱(可复现)；两次跑边界化效应：可恢复错误省~7%，灾难错误=成功vs失败。机制确认,真量级需忠实A/B。顺带 2 个 infra 发现(F-INFRA-1 doctor reachable≠functional 只ping不真调; F-INFRA-2 key在.env不在memex config,独立进程不load就500)。权威=harness worktree 的 `.harness/analysis/emergence-ab-results.md`。
- **F-1 已修=ADR-58/#29 已并 master `9ebd175a`**：收敛终结器。收敛语义改为 **EXISTS(task_spawned) AND 无非终态task_spawned**(两处SQL一致),complete_task 终结 task_spawned 行。**EXISTS守卫保护chat scope**(ADR-54只写memory_updated,无task→永不自动关——这是调研挖出的关键,「永不收敛」对聊天是load-bearing)。394测试绿+DB集成(任务scope真收敛/对话scope不收敛)。occWriteIdempotent无非测试调用方,complete_task是唯一完成路径。

**下一步**：F-1 已修→**涌现回路成功侧现在能真触发**(scope_closed→reinforceTemplate→success_count,加上已并的failure_count路径,hitRate变真信号)。回 #24 可跑**忠实 A/B**(去掉harness终结器垫片,真实路径)。harness worktree 仍在(exp/emergence-ab-harness,未并),含 trap+runner+results,可改造成忠实版。下面是 park 时的原始计划(部分已被上述取代)。

---
（以下为 2026-06-14 park 时原文，保留作参照）

挂起中（2026-06-14，fuller 续）。方向从愿景层(硬化/联邦/群)**收回到单机核心做实** = 用 A/B 因果验证「现有涌现回路到底有没有让实跑更好」。**非空想,是测已发布代码。**

**🎫 权威 = GitHub Issue [#24](https://github.com/ClydeShen/graph-engineering/issues/24)**(status:on-hold,看板 triage,effort3/size M)。本记忆是辅助上下文,真源是 issue。

## ⏸ 恢复触发器
用户说「部分代码还在开发调试中，不能 freeze」。**等用户确认「可以 freeze 了」→ 回来执行下面的 git 工作流跑 A/B。** 在那之前一行 git 都不动、不建 worktree、不发 issue。

## fuller 收口的决定
- **方向**：不走 2/3（联邦/群），做实单机核心。
- **选 A**（活体验证现有软回路）> B（建硬化层）> C（先建 guard 原语）。理由:全部愿景压在「软回路真有用」这一假设上,先证实再谈加固(你自己的门原则:难硬化先软验证)。
- **因变量 = B：到收敛的事件数**（连续、对少量跑敏感、**零 schema 改动**、正对「快路径」主张）+ **收敛布尔当护栏**（`checkConvergence` 已返回 `isConverged`，现成）。
- **装置 = A：陷阱/捷径任务**（人工放大效应→每臂 3–5 次就压过 LLM 噪声，适配你不稳的 LLM 环境）。首跑兼充种子语料。
- **性质澄清**：A/B 是**验证实验/证据闸**，既非产品功能、也非 arch 决定本身;它 **gate 住下游 arch 决定**(信号为正才值得建硬化层=愿景里的 option B;为零则回去修回路别加固)。

## 关键代码实证（本会话查证）
- **hitRate 是结构性 Proxy Signal**：`eval-metrics.ts: trailDiscoveryHitRate = Σsuccess_count/Σinjection_count`;但 `reinforceTemplate` 只 `success_count+1`，**全库无任何地方给 procedural_memory 的 `failure_count` 加分** ⟹ 单调只增、永不掉、不可证伪(违反波普尔门)。
- **没有注入开关**:`process-agent-turn.ts` 只要 `triggerType≠null` 就必调 `memReflect`。A/B 必须先加开关(只关 procedural+anti、别动 episodic/semantic 才能隔离 Phase 10 那条回路)。
- **岔口 B 的底座已实现且测过**(别重造):`template-graph.ts: canonicalizeTemplateGraph`=结构hash/规范形(WL精化,连不可区分边界都注明)、`wl-embedding`=同构相似、`reinforceTemplate`+superseded=Ebbinghaus、孤儿反模式=负样本、`cross-scope`=跨域聚类。⟹ 「硬化」只差三样:晋升门 + 后置条件当运行时 guard + 快路径/deopt(=岔口C的契约+缓存计划)。

## A/B 会顺手产出的永久件（不随实验扔）
1. **procedural 注入开关** — A/B 要它,对后续硬化调试/生产排障也长期有用。
2. **`failure_count` 写入路径** — **本身就是正经正确性修复**(不可证伪 bug),产品级。
3. 陷阱任务夹具 = 脚手架,可留作回归或删。

## 约定的 git 卫生工作流（freeze-ready 后执行）
```
0. 前置门:LLM 活体可用(现 Gemini key 被吊/Ollama 没装 → 不可用则只建到第4步、第5步挂起,不留半状态)
1. freeze master:先收干净游离改动 → 工作树 clean → 记 HEAD 基线
2. 开 exp/emergence-loop-ab(off 基线)
3. git worktree add 独立目录(master 工作树零触碰)
4. worktree 内建:注入开关 + failure_count 路径 + 陷阱夹具+runner
5. 跑两臂(开/关) → 比 事件数到收敛 + 收敛布尔  ← 需真 LLM
6. 落地永久件 + 结论写盘
7. merge exp→master
8. git worktree remove + git status 验净
```
注:freeze 时还有 3 个游离改动(`memex.mjs`/`forest-universe.ts`/`memex-terminal.mjs`,与本事无关)待处理(commit 或 stash)。

## 排队的下一议题
**MemexTerminal 功能补强** — 用户指出 Terminal 功能非常不完整,要基于这些愿景讨论提升其功能质量。本支收口后转入。

关联:[[project_skill_hardening_vision]] [[project_phase10_complete]] [[feedback_live_verification_policy]] [[feedback_confidence_four_dimensions]] [[project_memex_terminal_naming]]
