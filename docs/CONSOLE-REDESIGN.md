# MemexOS Console 重设计 — 人类视角 & Now 宇宙

> 版本：v2.0 · 2026-06-13
> 状态：设计已定稿（结构核心），细节分支与落地顺序见末尾
> 取代：`docs/UI-SPEC.md` v1.0 的过时部分（见 §9）

---

## 1. 动机

现有 Console 是图内部本体论的**忠实镜像**——8 个导航项几乎 1:1 等于引擎概念（Topology / Kernel / Artifacts / Crystallized lessons），界面上全是 `scope_id`、version-hash、`trail mesh` 这类黑话。它是为"已经懂这套本体论的人"造的观测台。

但真实用户不共享这套本体论。他的心智是：

> "我给系统派了个活儿。它在干吗？有进展吗？卡住了吗？干完了吗？它学到了什么？"

核心错配：**忠实于本体论的投影 ≠ 对人类友好的"正在发生什么"的投影。** 而且——看单个 scope 对人类毫无意义；真正打动人的，是看着整个东西随着系统啃一个难任务而**像活树一样长出来**。

---

## 2. 受众

**只有一种人：人类 = 操作者。** 没有第二拨观众。所谓"进阶遥测"（System/Kernel）只是同一个人往深看，不是另一种用户。

---

## 3. 不变量（守住，不可破）

1. **图 = SSOT。** 引擎内部本体论（Scope / Association / Entity / Snapshot / Lesson / version-hash）一行不改。
2. **Append-only。** 不改既有图节点。
3. **Console 是只读投影**——除少数显式写面（Settings / Plugins 安装 / Notification 操作）。
4. **翻译只在表现层。** 人话命名只活在 console/TUI，绝不下沉到引擎或 DB 列名。

---

## 4. 词汇翻译层

| 引擎内部（SSOT 保留） | 人类看到的 | 说明 |
|---|---|---|
| Scope / scope_id / hash | **任务**（task） | 隐藏 id 与 hash |
| Crystallized Lesson | **Emergence** | 系统自学的东西；显示时翻成人话（图/文皆可，机器识别优先、表现层翻译） |
| 外部安装/预装技能 | **Skills**（住 Plugins 页） | 用户可随时增删改，不影响系统运行 |
| Artifacts | **Workspace** | 功能待详设（§8） |
| Sessions | **History** | 过去派过的任务，可回放 |
| suspended scope | 🔔 **Notification** | 红徽标 + 右侧抽屉（Azure 式） |
| Kernel / worker bus | **System** | 健康条点开的进阶视图 |

> ⚠️ 名词迁移：`Skills` 从此**专指**外部可插拔技能；系统自学的东西改叫 `Emergence`。引擎内部仍叫 `Lesson` / crystallization。

---

## 5. 信息架构

**主导航**（人话、单受众）：

```
Overview(/)  ·  Now  ·  Chat  ·  History  ·  Workspace  ·  Emergence  ·  Plugins  ·  Settings
```

| 路由 | 人话名 | 来自 | 备注 |
|---|---|---|---|
| `/` | Overview | Activity 统计图 | **保留作首屏**（性能考量：长时间挂着活树会卡，故首屏用轻量图表） |
| `/now` | **Now** | 取代 `/topology` | 英雄页，见 §6。独立页，只在查看时实时渲染 |
| `/chat` | Chat | Chat | 不变 |
| `/history` | History | Sessions | 改名 |
| `/workspace` | Workspace | Artifacts | 改名；功能待详设 |
| `/emergence` | Emergence | Crystallized lessons | 翻成人话 |
| `/plugins` | Plugins | 新建 | 外部 Skills 增删改 + onboarding 接线 |
| `/settings` | Settings | 已存在 | 保留 |

**删除 / 降级：**
- 左栏 **"Scopes" 列表 → 整个删掉**（对人类无意义）
- **Alerts → 🔔 Notification 徽标 + 右抽屉**（不占顶层导航）
- **Kernel → System**（健康条点开，进阶）

---

## 6. Now — 英雄页（可缩放宇宙）

### 6.1 形态：森林优先 + 语义缩放

像宇宙模拟游戏，连续缩放切换层级：

| 层级 | 看到什么 | 数据 | 渲染成本 |
|---|---|---|---|
| **L0 宇宙** | 所有 channel 是**星系**（Telegram / Slack / Discord / Email / Cron / Console），大小=活跃度。顶部森林一行字住这层 | 按 `intent` 前缀聚合计数 | 极低 |
| **L1 星系**（单 channel） | 该渠道生出的任务树成簇，每棵=一个 session 任务，按子任务数定大小、状态定色、活跃时脉动 | 该 channel 的根 scopes | 低（剪影） |
| **L2 树**（单任务） | `scope_lineage` 子树：根 `intent` → 子任务（depth≤3），人话标签 + 状态色 + 生长动画 | 一棵子树（小） | 中（仅此树渲全细节） |
| **L3 节点**（单 scope） | 节点详情 + 旁白流过滤到这条（plan→spawn→…→closed 翻成人话） | 该 scope 的事件 | 中 |

**树 = 空间英雄，旁白流 = 旁白。** 旁白流随层级变焦：L0/L1 是"全局刚刚发生了什么"滚动条；L2/L3 收敛到这棵树/这个节点。

### 6.2 星系 = Channel（数据已验证）

每棵根任务树能解析出来源 channel：gateway-bot 用 `buildSessionKey('<platform>', chatId)` → 写进根 scope 的 `intent = session:<platform>::<chatId>`；子任务经 `parent_scope_id` 自动归属。解析不出的归入 **Direct/Console** 星系（优雅降级）。

> 注：channel 现在从 `intent` 字符串 parse，非独立字段。够用、可降级；若字符串解析变脆，加 `scope_lineage.source` 列是干净收尾——属引擎改动，可推迟。

### 6.3 实时：SSE 脉冲 + REST 对账（混合）

- **推（SSE `/v1/stream`）= 心跳/触发器**：`pg_notify('graph_event_ready')` → gateway 点查 `{event_type, scope_id, event_id, timestamp}` → 毫秒级推前端。每条事件立刻驱动动画（脉动 / 冒新节点 / 变色）。
- **拉（REST）= 填细节 + 兜底**：首屏拉森林快照打底；见新 scope 时懒加载 `intent`/lineage；断线重连用点查对账。

> SSE 是**脉冲**（ADR 32，断线可能丢、靠点查补），不带 payload 细节。故状态真相由图 + REST 兜底，felt 体验仍全实时。**不违背"图是 SSOT"。**

### 6.4 渲染模型：分层（性能红线落地）

- 缩进的那棵树（L2/L3）：跑 `requestAnimationFrame` 持续游戏循环（生长缓动、脉冲涟漪、呼吸）。范围有界 → 便宜。
- 全宇宙（L0/L1）：事件触发的微光/脉冲，不常驻物理。

### 6.5 引擎：react-force-graph-2d + 2.5D 美术

- **库**：`react-force-graph-2d` + `d3-force`。Next.js 里 `dynamic(() => import(...), { ssr:false })` 客户端加载（依赖 `window`）。
- **2.5D**：`nodeCanvasObject(node, ctx, globalScale)` 画等距/带阴影的精灵；宇宙纵深靠美术（视差星空背景、节点投影、非聚焦星系景深虚化）。
- **语义缩放 LOD**：`globalScale` 直接驱动——缩远画剪影、缩近画全细节。
- **活气**：`linkDirectionalParticles` + `linkDirectionalParticleSpeed`，因果在树枝上流动。

> 游戏化「手感」规格（动效 token、因果即动效、缩放惯性、LOD 美术、性能红线、reduced-motion canvas 守则）见**附录 B**。

---

## 7. 引擎决策记录（含翻案）

| 时间 | 决策 | 理由 |
|---|---|---|
| Phase 3（UI-SPEC v1.0） | 锁定 `@antv/g6 v5` | 当时方案 |
| 本次初判 | 倾向 react-force-graph | 缺证据下的推荐（不知 g6 已是锁定在用引擎） |
| 翻案核实 | 摆回 g6（DRY + Combo=星系 + 已锁定） | g6 v5 能力齐全且零新依赖 |
| **最终（用户对比真实例子）** | **react-force-graph-2d** | **视觉/UX 优先级压过 DRY：g6 太平面、互动弱、UI/UX 不够直观。视觉活气是本次重设计的核心诉求** |

**接受的代价：** 移除 `@antv/g6` 依赖；重写 `packages/console/src/components/TopologyCanvas.tsx`（从"单 scope entity 图" → "scope_lineage 森林渲染器"）。

---

## 8. 取代 UI-SPEC.md v1.0（已归档）

| UI-SPEC v1.0（过时） | 本设计 |
|---|---|
| 图引擎"锁死 @antv/g6 v5" | **react-force-graph-2d**（§7） |
| 数据 = HTTP polling | **SSE 脉冲 + REST 对账**（§6.3） |
| 三页架构（因果拓扑/内核指标/挂起告警） | **新 IA**（§5） |
| 只读 MVP，无写入 | 含显式写面（Settings/Plugins/Notification） |

> UI-SPEC.md 已于 2026-06-13 归档为 `docs/archive/UI-SPEC-v1-phase3.md`。唯一仍有效的「LLM Provider/Model 设置（可写）」基线已收编至本文档**附录 A**；其余（Status Ribbon / Web Worker 语法 / Tailwind 冷色调）作历史快照留在归档件，勿据此实现。

---

## 9. 落地前置 & 待决细节分支

**前置（新建，read-only SELECT over `scope_lineage`）：**
- `GET /v1/forest` — 根 scopes 按 channel 分组（星系）+ 计数/状态（L0/L1 快照）
- `GET /v1/scopes/:id/lineage` — 单任务的 `scope_lineage` 子树（L2）
  （现有 `/v1/scopes/:id/topology` 是 entity 级，不够用）

**待决细节（不动结构地基）：**
- Now 节点美术规格（每层 LOD 画什么、状态色板、生长动画曲线）
- 森林顶部那行字具体说什么、吃什么数据
- **Emergence**：机器学的东西怎么翻成人能懂（diagram / 文字 / 其他）
- **Plugins** 页：技能列表 + 增删改 + onboarding 接线
- **Notification** 右抽屉（Azure 式）的内容与交互
- **Overview 首屏自身仍带黑话**（"Total scopes"、event_type 原串、"trail mesh"）——按"去黑话"前提它也该翻译
- **Workspace** 页功能（用户明确：之后再说）
- **System**（Kernel）进阶视图的取舍

---

## 10. 建议落地顺序

1. **后端前置**：`GET /v1/forest` + `GET /v1/scopes/:id/lineage`（纯 SELECT，便宜、可独立测）
2. **引擎切换**：移除 g6，引入 `react-force-graph-2d`；`TopologyCanvas` → `ForestCanvas`（L2 单树先跑通）
3. **Now L2→L0 逐层**：单树生长（L2）→ 星系聚类（L1，channel 分组）→ 宇宙总览（L0）+ 语义缩放
4. **实时接线**：`EventSource('/v1/stream')` 驱动动画 + REST 对账
5. **IA/词汇**：导航改名、删 Scopes 列表、Alerts→Notification 抽屉、Kernel→System
6. **细节页**：Emergence 翻译、Plugins、Overview 去黑话、Workspace（最后）

---

## 附录 A — Settings 写能力基线：LLM Provider/Model（可写）

> 来源：原 `docs/UI-SPEC.md` v1.0「Phase 4+ 设计基线」节，2026-06-13 收编至此（UI-SPEC 已归档为 `docs/archive/UI-SPEC-v1-phase3.md`）。这是 console「只读投影」的**唯一已知写例外**：设计已收敛至结构核心，但**尚未实现为 UI 写面**——当前 Settings 仍是只读投影，编辑走 `memex onboard` CLI。Plugins/Settings 写面落地时可直接据此实现，无需重新调研。

| 维度 | 决定 | 依据 |
|---|---|---|
| 读写 | **可写** | `OpenAICompatibleProvider.chat()/embed()` 每次调用都现读 `this.config`（非构造时固化的 SDK client）；去掉 `readonly` + 加 setter 即可让单进程内实例热更新，成本接近零 |
| 持久化 | **独立 JSON/YAML 配置文件**，不进 `.env`、不进 graph、不进 `iii-config.yaml` | `.env` 无法持久化 UI 输入；写入 graph 会让 API key 进不可变执行轨迹（审计/快照安全顾虑）；`iii-config.yaml` 实际不携带任何 LLM 字段 |
| 架构形状 | **单槽位 + 独立 embedding 轴**：`{ chat: {...}, embedding: {...} }`，不引入 hermes 式 primary/secondary 多档位 | Memex 是异步图执行运行时，无实时延迟驱动的快/慢模型分层需求；chat 与 embedding 在 ADR 22 中已是两个独立接口，分开配置同时修正"同一 `model` 字段同时服务两个命名空间"的缺陷 |
| 跨进程一致性 | **gateway 进程内即时生效**（mutate 自身 `gatewayLlmProvider`）；**workers 下次重启后生效** | gateway 与 workers 各持独立 provider 实例；"重启后生效"顺着"凭证只在构造时读取一次"的不可变保证自然延伸，无需新建热重载基础设施 |
| 软重启 | **明确不做，独立问题留存** | 会重新打开已被禁用的 `iii-exec` 块，且需把范围从"代码变更触发重启"扩大到"配置变更触发优雅重载"——独立的基础设施项目 |

---

## 附录 B — 游戏化 UX & 动效规格（gamer 视角）

> 来源：2026-06-13 `/ui-ux-pro-max` 评审，受众设定为「挑剔 + 不懂技术 + 爱玩游戏」的操作者。**桌面 web 适配**：丢弃移动端专属规则（44pt 触控 / 安全区 / 底部导航），保留无障碍对比、动效语义、视觉层级、空状态、加载骨架等通用项。本附录**扩展 §6，不推翻**；建立在既有 observatory token 体系之上（不换调色板）。
>
> ⚠️ **未纳入（判为不现实，留待再讨论）**：Notification 的「呼吸信标」与 Emergence 的「成就解锁流」两个具体游戏化框法**未采纳**，不作为设计决定。Notification / Emergence 的形态仍是 §9 的开放待决项，需另开讨论后再定。

### B.1 判断重心（trim tab）

这类用户的判断 90% 压在 **Now 页的「手感」**——流畅度 + juice（视觉回馈密度）+ 一眼看懂的状态。IA 与词汇（§4/§5）是入场券，手感才是成败手。

### B.2 设计系统 delta（建立在 observatory 之上）

调色板不换。游戏感来自**动效语言 + 状态语义 + 美术纵深**。

**状态色 → HUD 语义（复用现有 token；状态绝不只靠颜色，叠加形状 + 脉动节奏 —— 规则 `color-not-only`）**

| 任务状态 | 现 token | HUD 含义 | 形状/节奏编码 |
|---|---|---|---|
| active/生长中 | `--glacier-500` | "在动脑" | 脉动光环 + 实心圆 |
| converged/健康 | `--moss-500` | "干得好" | 稳定光晕 + 对勾微章 |
| suspended/卡住 | `--rust-500` | "需要你" | 显著脉冲 + 感叹环（**具体交互形态待 Notification 讨论**）|
| closed/完成 | `--ink-400` | "归档" | 暗淡 + 无脉动 |

**需补的 token（零风险地基，无页面改动）**

- **动效 token**（现 `materials.css` 仅有 `prefers-reduced-motion` 兜底，无节奏令牌；游戏 juice 须先统一节奏 —— 规则 `motion-consistency`）：
  - `--dur-micro: 160ms` / `--dur-base: 240ms` / `--dur-enter: 320ms` / `--dur-exit: 200ms`（出场 ≈ 入场 × 0.65 —— 规则 `exit-faster-than-enter`）
  - `--ease-out: cubic-bezier(.16,1,.3,1)`（入场）/ `--ease-in: cubic-bezier(.5,0,.75,0)`（出场）
  - spring 曲线用于节点冒出（spring/physics 优先于线性 —— 规则 `spring-physics`）
- **tabular figures**（HUD 计数/计时跳动防抖 —— 规则 `number-tabular`）：`font-variant-numeric: tabular-nums` 的数据字型变体。

### B.3 Now 宇宙 juice 规格（补 §6）

**① 因果即动效（每个动画 = 一个真实图事件，禁纯装饰 —— 规则 `motion-meaning`）**

| 图事件 | 视觉 juice |
|---|---|
| `task_spawned` | 父节点弹出子节点：spring scale 0→1 + 根处粒子迸发 |
| 边建立 | `linkDirectionalParticles` 沿枝流动（§6.5 已定）|
| `memory_updated` | 节点莫斯绿一闪（crossfade 200ms）|
| `scope_closed` | 收束脉冲 → 节点沉降变暗 |
| `suspended` | 切换到显著脉冲状态（**视觉细节随 Notification 讨论定**）|

**② 缩放手感（像宇宙模拟游戏，非阶跃切页）**

- 滚轮带惯性 + 阻尼；语义 LOD 由 `globalScale` 驱动（§6.5）
- 钻入用共享元素过渡（规则 `shared-element-transition`）：点星系 → 该簇放大充满视口，不闪白切页
- 非聚焦层景深虚化 + 视差星空（§6.5 已列）

**③ 节点 LOD 美术（落实 §9「Now 节点美术规格」待决项）**

- L0 星系：发光圆盘，大小 = 活跃度，缓慢自转微光
- L1 任务簇：剪影树冠 + 顶部状态色描边
- L2 节点：等距圆角卡片 + 投影（2.5D），人话标签
- 悬停：scale 1.03 + 升起阴影（规则 `scale-feedback`）；**点击才是主交互，不可只靠 hover**（规则 `hover-vs-tap` 桌面适配）

**④ 性能红线（CRITICAL —— 规则组 §3 + §6.4）**

- rAF 持续循环**只在 L2/L3 单树**（§6.4 已定）；L0/L1 仅事件触发微光
- 每帧 < 16ms（规则 `main-thread-budget`）；节点 > 50 降级粒子
- **`prefers-reduced-motion`：宇宙降为静态布局 + 状态色 + 离散刷新。** 注意 canvas 的 rAF 循环**不受 CSS 媒体查询管**，必须在 JS 里 `matchMedia('(prefers-reduced-motion: reduce)')` 显式停循环（规则 `reduced-motion` / `animation-optional`）——**最易漏的无障碍坑**。

### B.4 跨页游戏化升级（已采纳部分）

| 页 | 升级 | 状态 |
|---|---|---|
| **Overview（首屏）** | 改"指挥中心"：今天派了几个活 / 在跑 / 等你 / 系统学到几条；空数据 = 邀请卡「派个活儿，看它长起来」+ 种子演示（规则 `empty-states` / `empty-data-state`）| 采纳 |
| **History** | 每条带状态色 + 一句话结果；点开可在 Now 重播那棵树的生长 | 采纳 |
| **加载** | 所有 > 300ms 用骨架/微光，不用空轴或转圈（规则 `progressive-loading` / `loading-chart`）| 采纳 |
| **Notification** | 形态待讨论（§9 开放项），**不预设信标方案** | 待讨论 |
| **Emergence** | 翻译形态待讨论（§9 开放项），**不预设解锁流方案** | 待讨论 |

### B.5 无障碍守门（CRITICAL，先于美观）

1. **reduced-motion**：canvas rAF 循环须 JS 显式关（CSS 兜底管不到，见 B.3④）。
2. **对比**：desaturated 调色板里 `--moss-500`/`--glacier-500` 直接作文字色可能 < 4.5:1；HUD 文字用 `--text-primary`，颜色只做状态点（沿用 token 注释里标好的 `*-solid` WCAG 变体）。
3. **不靠颜色**：状态 = 色 + 形 + 脉动节奏三重编码（B.2）。

### B.6 落地：作为 §10 各步的附加验收（不另开弧）

- **§10 步骤 1 前置 / 现在可做（零风险）**：补 B.2 动效 + tabular token；本附录即设计固化。
- **§10 步骤 2（引擎切换）**：节点 LOD 美术 + hover scale + spring 冒出。
- **§10 步骤 3–4（分层 + 实时）**：B.3① 因果动效表 + 缩放惯性 + 共享元素过渡 + 性能降级 + reduced-motion canvas 守则。
- **§10 步骤 6（细节页）**：Overview 指挥中心、空状态、加载骨架；Notification / Emergence **待各自讨论后再排**。
