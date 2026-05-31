---
gsd_state_version: 1.0
milestone: v0.5
milestone_name: milestone
status: planning
last_updated: "2026-05-31T10:28:25.208Z"
---

# Project State

**Last updated:** 2026-05-31 (design verification complete — 3 research agents, ADR 02 corrected)
**Active phase:** Phase 1 — MVP
**Status:** Research complete — ready to plan

## Current Position

- [x] Domain model finalized (CONTEXT.md, RFC_v4, ADR_v4)
- [x] Project initialized (.planning/ artifacts written)
- [x] Domain + tech research complete (.planning/research/domain.md, tech.md)
- [x] Pi SDK research complete (.planning/research/pi-sdk.md)
- [x] iii-engine research complete (.planning/research/iii-engine.md)
- [x] Requirements written (REQUIREMENTS.md)
- [x] Roadmap written (ROADMAP.md)
- [ ] Phase 1 plan (`/gsd-plan-phase 1`)
- [ ] Phase 1 execution

## Pi SDK Key Findings (2026-05-31)

- **Pi** = `@earendil-works/pi-coding-agent`，编码 Agent CLI/SDK（类 Claude Code），**不是** event bus
- **Pi 与 iii-engine 是独立产品**，来自不同团队（Pi 文档中无 iii-engine 内容）
- **Worker 实现** = iii-engine `spawn("pi", ["--mode","rpc","--no-session"])` 子进程，JSONL stdin/stdout 通信
- **自定义工具** = `pi.registerTool()` 注册图读写工具；`terminate: true` 控制 Worker 生命周期
- **Pi Compaction** = session 内对话历史摘要（有损，trigger: `contextTokens > W - 16384`）；与 Knapsack Slicing 互补不竞争
- **Pi Sandbox（Phase 4）** = `runtime.fork(entryId)` + `SessionManager.inMemory()` 候选实现路径

## iii-engine Key Findings (2026-05-31)

- **iii-engine** = 官方产品名 **iii**，Rust 编写（74.7%），Elastic License 2.0，**可自托管二进制**，非托管服务
- **安装** = `curl -fsSL https://install.iii.dev/iii/main/install.sh | sh`，当前稳定版 0.16.1
- **引擎启动** = `iii --config config.yaml`，默认 WebSocket 端口 49134，REST 3111，Stream 3112
- **Worker 连接** = SDK 通过 WebSocket 连接，`III_URL=ws://localhost:49134`，语言无关
- **Pi Agent 集成** = iii-exec worker 托管 Pi 子进程，或 Pi Worker 作为独立进程连接引擎
- **HWM** = iii-engine **无内置 HWM**，`bus_state.last_processed_event_id` 必须自建（ADR 09 不变）
- **llm-budget 等 Worker 不存在** = 公开注册表无此 Worker，`harness` bundle 内容待查

## Open Questions / Risks

1. ~~**iii-engine 部署形态**~~ ✅ **已解决（2026-05-31）** — 可自托管二进制，`curl install.sh | sh` 安装，Elastic License 2.0
2. ~~**jsonb::text key-sort**~~ ✅ **已解决（2026-05-31）** — PostgreSQL jsonb 不保证字母序 key。`canonical_json()` 在应用层（TypeScript BTreeMap 递归排序）实现；PostgreSQL 接收预规范化 TEXT；ADR 02 已更正，禁止 `payload::jsonb::text`。
3. ~~**tokio-postgres 通知 API**~~ ✅ **已解决（2026-06-01）** — 不适用。Control Plane Daemon 改为 TypeScript + `pg-listen`；iii 是现成二进制，非自行实现 Rust。tokio-postgres 内部 API 不在项目范围内。
4. **中文 tsvector tokenization** 🟡 — `'simple'` 字典对中文无效，BM25 静默返回空结果；需决策：加 jieba 预分词或向量 only
5. ~~**iii-database change feeds**~~ 🟡 **降级（2026-05-31）** — `database` worker 存在（v0.2.2）且声称支持 change feeds，但底层机制不透明（WAL vs pg_notify vs 轮询），文档缺失。**决策：维持 ADR 09 自建 LISTEN/NOTIFY + HWM，不依赖黑盒 CDC**
6. ~~**workers.iii.dev 可用性**~~ ✅ **已解决（2026-05-31）** — `llm-budget`、`context-compaction`、`approval-gate`、`turn-orchestrator` **不在公开注册表**，无法 `iii worker add`；`harness` bundle (v0.4.7) 存在但内容不公开
7. **OCC 反压** 🟢 — ConflictResolverWorker 无速率限制（Phase 3 问题，不阻塞 MVP）
8. **harness bundle 内容** 🟡 — `harness` v0.4.7 存在于注册表，但无公开描述，需 `iii worker add harness` 后检查是否含 agent 编排工具
9. **Pi spawn 跨平台** 🔴 — Windows 上 `spawn("pi", ...)` 需 `{ shell: true }`，否则静默 ENOENT；Phase 1 Worker 实现必须统一用 `spawnPi()` 工厂函数（见 NF6.1，iii-engine.md §11.3）
10. **iii Windows 原生安装** 🟡 — curl 脚本依赖 `sh`，Windows 不可用；Phase 1 开发路径：Docker（首选）或 WSL2；PowerShell 安装方式待验证（iii-engine.md U-6）

## Next Action

Run `/gsd-plan-phase 1` to generate the detailed execution plan for Phase 1 (MVP).
