# ADR 52｜Artifact 写图约定 + Skill 安装作用域

status: accepted
日期: 2026-06-12

---

## 上下文

Phase 19（console-and-artifacts）。图里此前没有 "artifact" 概念——工作产出散落为事件 payload 与磁盘文件，Console 没有"可展示交付物"可渲染。同时 skill 安装只有全局一种作用域，S2 场景要求拍板作用域语义。

## 决策

### D-1：Artifact = 哈希寻址内容 + 类型化读模型 + payload 引用（修订 ROADMAP 原案）

ROADMAP 原文设想 `memex::artifact::created` Association 事件。实装时被两条既有红线修正：

- **migration 002**：payload 是 TEXT，禁止 payload::jsonb 查询——artifact 元数据必须走类型化列
- **migration 013 判例**：mid-scope infra 事件会抢占 agent 的 OCC predecessor 槽位（ADR-41 唯一性 = `(predecessor_hash, scope_id)`），把 agent 下一笔写降级为 conflict

最终形态（migration 018）：

- **内容**：SHA-256 哈希寻址落盘 `<profile>/artifacts/<hash>`（与 Snapshot 内容哈希语义一致；不可变，HTTP 缓存 immutable）
- **元数据**：`artifact` 表，PK `(content_hash, scope_id)`——同一内容出现在两个 scope 是两行 provenance、一个磁盘文件
- **账本关联**：生产者在自己的结果 payload 里带 `artifact_hash` 字段引用——零额外账本事件，trail 自然引用 artifact；不发明 mid-scope infra 写
- **Entity 身份**：`artifactEntityId(hash)` 内容派生（与 ADR-51 capability id 同方案）

### D-2：erase 级联（ADR-43）

`erase(scope)` 步骤 2.5：该 scope 的 artifact 行打 `erased_at`；某 hash 失去全部存活引用时 unlink 磁盘文件。Gateway `GET /v1/artifacts/:hash` 对已 erase 的返回 410 Gone。migration 018 未应用的旧库按零处理（不阻塞 erase）。

### D-3：生产者接入是 opt-in

`saveArtifact()` 是机制；调用方（execute_bash 产物、MCP 工具产物、research 汇总）按需声明。首个强制消费者是 Phase 20 浏览器截图（容器内产物声明为 artifact）。不做"所有工具结果自动 artifact 化"——账本里已有结果 payload，重复存储无收益。

### D-4：Skill 安装作用域 = 复用 Lesson 可见性三级模型（ADR-46）

不发明第四套作用域词表：

| 级 | 实现 | 状态 |
|---|---|---|
| `global` | `~/.memex/skills`（所有 profile 可见） | 已实装（`--scope global`） |
| `profile` | `<profileDir>/skills`（默认；无 profile 时与 global 同路径） | 已实装（默认值，与既有行为零迁移） |
| `principal` | per-agent 可见性，挂 principal Entity 模型 | **Phase 20 接线**（agent 发起安装时随审批协议落地） |

### D-5：Console 交付形态

UI-SPEC.md 为设计基线：Next.js 15（Turbopack）+ React 19 + G6 v5（拓扑画布，动态导入独占 canvas）+ Recharts（内核指标，300 点环形缓冲）+ Tailwind 工业冷色调。五页：Topology（增量 diff 渲染 + Inspector）/ Kernel / Alerts / Artifacts（D-1 消费端，markdown/code/html 内联预览）/ Skills（两阶段加载）。补齐 UI-SPEC 缺失的两个后端契约：`GET /v1/metrics/infra`、`GET /v1/scopes/audit/suspended`。Gateway 自包含 live view v0 保留为零安装 fallback。

**验证边界（诚实声明）**：`next build` 全路由编译+预渲染通过、topology-diff 纯逻辑单测覆盖；G6 画布的视觉行为需活体 gateway 验证——列入活体遗留批次。Web Worker force layout（UI-SPEC 性能项）v1 未做：G6 v5 内置布局先行，画布卡顿实测出现时再上 Worker（值变更而非类型变更）。

## 后果

- Console 有真东西可渲染；artifact 经哈希可校验、可缓存、可 erase
- 账本零膨胀（payload 引用而非内容入账本）
- skill 作用域与 Lesson 可见性共用一个心智模型，Phase 20 的 per-principal 有明确挂点

## 关联

ADR-43（erase 级联）、ADR-46（可见性三级判例）、ADR-51（能力图——Console skills 面板展示的安装态来自同一观察层）、UI-SPEC.md（设计基线）、migration 002/013（约束来源）
