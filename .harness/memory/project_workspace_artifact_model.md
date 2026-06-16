---
name: workspace-artifact-model
description: "fuller 收口(2026-06-14续): workspace/project 生命周期 + agent身份(per-channel LLM) + persona(SOUL/AGENTS) + artifact 模型。取代 ADR-52 CAS。设计阶段未起工。映射 GH #25/#27/#28。"
metadata:
  node_type: memory
  type: project
  originSessionId: 151d19e7-1ea8-47b6-a8d3-a25a82a9b53c
---

fuller 续钻 #28 ①（per-channel LLM）→ persona → 文件夹约定 → workspace 生命周期 → artifact 模型，2026-06-14。**设计阶段、未起工。** 映射 GH **#25**(agent身份/SOUL)/**#27**(console artifact)/**#28**(workspace/project)。

## 决策簇（全锁）
1. **per-channel LLM = agent 身份（#28①，B）**：`channel.llm` 从 `string` 升为 `string | {provider, model?}`（补 hermes 证实的「per-platform 模型覆盖」）。precedence：**channel.llm > 附录A 全局可写 override > providers[0]**。unset→继承（hermes「覆盖否则继承」律）。persona/工具**不进** channel config（Memex 用图投影/ADR-47/ADR-51 承担）。
2. **persona 不进图（cross-checked，high）**：persona/SOUL = LLM 行为风格 = 配置输入、噪音，非图信息。实证：`process-agent-turn.ts:117` 每事件带 `_principal`（ADR-46）= 涌现的**分区键**，所以 persona 当噪音安全（不需文本进图）。注入点 `core.ts:137` system prompt = `ctx.stable + 投影 + SOUL + AGENTS`。SOUL 连账本引用都不进（纯 config-input，零图足迹）。**唯一不变量**：persona 必须挂在被归因的同一 principal 身份上。
3. **SOUL vs AGENTS 正交（B）**：**SOUL.md = agent 身份专属**（人格，随 agent 跨 project 不变，文件、每 turn 热读、缺省→默认）；**AGENTS.md = project 专属**（这个 project 怎么干，随 project 跨 agent 通用）。SOUL 随 agent，AGENTS 随 project。
4. **文件夹约定 = 固化文件名、非目录树（B + AGENTS.md 互操作）**：固化**文件名**(`SOUL.md`/`AGENTS.md`)+读位置+优先级，**不规定目录树**（守 #28「discovered not designed」）。从 cwd 读；`AGENTS.md` 纳入跨工具互操作（hermes auto-inject SOUL.md/AGENTS.md/.cursorrules；`.cursorrules`/`CLAUDE.md` 留后）。双层：project cwd > 全局 `~/.memex/`。
5. **workspace 生命周期 = A（糖 over discovered，无注册表）**：守 §11「不是注册表/一等实体」。
   - onboarding 建全局 `~/.memex/SOUL.md`+`AGENTS.md` 模板 + workspace 根目录。
   - `memex workspace add <name>` = 建文件夹 + 丢 **AGENTS.md**（**不丢 SOUL.md**，SOUL 只属 agent 身份）+ 建 **`artifact/` 文件夹**。
   - 「用哪个 agent / 引入新 agent」= 选某 channel 的 `llm`(B) + 设其 SOUL.md。
   - 「agent 在哪个 project 干活」= channel 配 **default cwd 字段**（config，非存储绑定）。
   - project = 文件夹 + `scope.project` 可观测事实（execute_bash cwd 检测填，nestScope(project) 已有）。
6. **artifact 模型 = A：取代 ADR-52 CAS** ⚠️：
   - **per-project `workspace/<project>/artifact/` 文件夹、path 寻址**；console artifact 页**读该文件夹内容**。
   - 账本按 path 引用；用户删文件→悬空→**软化**（= #25 beam5 / 三线合一）；erase = #28 懒墓碑（删文件夹）。
   - **取代已 accepted+implemented 的 ADR-52**（`<profile>/artifacts/<hash>` 内容寻址 CAS + migration 018 + `store.ts` + `/v1/artifacts/:hash`）。理由：CAS 几乎没被用（`saveArtifact` opt-in，唯一消费者 Phase20 截图未活体）；图才是 SSOT，artifact 是软 knowledge 层不需 CAS 完整性/dedup（同 #25 beam5「Hermes 无 store 也活」）。
   - **需写新 ADR 取代 0061**；重写 `store.ts`/`routes/artifacts.ts`/migration。**本 session 第一次取代已实现 ADR。**

7. **同名重建身份（#28②，B，已收口）**：**不裁决身份，让拓扑表达**。`scope.project` 存**文件夹名/路径标签**（无 ctime/id）；「同名即同标签」。重建实例靠**图连通性**在 Now 自然分簇——删除切断连续性 → 旧=变暗归档簇、新=活跃簇、**两簇同标签（cosmetic）**；Workspace 按标签分组显活文件夹内容（旧悬空/墓碑）。否决 path+ctime（= designed 实体，违 §11.1「名是标签、簇是 project」）。= §11.1 + §11.3「同名即复用」+ 懒墓碑 三合一；append-only 柔术「不强加身份实体」。

## 仍开放（#28 残留，皆非结构性）
- ④ Plugins 页设计
- 细节：workspace 根放哪、channel `cwd` 字段名、`workspace add` 模板内容

关联:[[project_memex_terminal_design]] [[project_emergence_loop_validation]] [[project_console_redesign_now_universe]] [[feedback_confidence_four_dimensions]]
