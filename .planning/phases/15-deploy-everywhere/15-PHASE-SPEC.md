# Phase 15: deploy-everywhere — Phase Spec

**写入：** 2026-06-12
**用途：** Phase 15 planner 前置输入。
**基线：** `.harness/ROADMAP.md` §15-deploy-everywhere；hermes 安装矩阵（install.sh/install.ps1/doctor/profiles）；Phase 11 Onboarding TUI；Phase 14 硬化产物（ADR-47）。

---

## 1. 目标与定位

任何人在任何主流环境一条命令起 MemexOS。产品的"外壳工程"：安装、诊断、多环境隔离、服务化、远程访问、备份。Phase 14 的安全形态是出厂默认——"任何人都能装"装到的就是安全形态。

## 2. 设计要点

### 2a. TD-M 决策：运行时收敛到 Node 22（本阶段拍板）

现状：Gateway 入口是 Bun.serve 形态（`export default {port, fetch, websocket}`），WS 挂载 `hono/bun`（动态 import，Bun-only）；Workers/Control-Plane 是 Node 22。**决策：收敛到 Node 单运行时**——

- Hono 本身跨运行时；`@hono/node-server` 提供 `serve()`，`@hono/node-ws` 提供 `createNodeWebSocket`（与 `hono/bun` 的 `upgradeWebSocket` 同形 API）
- ws-protocol.ts（Phase 11）已经是 Bun-free 的纯逻辑层——只有 buildWsRoute 的 upgrade 适配层和入口需要 Node 路径
- 收益：安装矩阵从"Node 22 + Bun"降为"Node 22"；Docker 镜像单基底；doctor 检查项少一类
- Bun 路径保留为兼容分支（`globalThis.Bun` 探测已存在），不删除——但 Node 是受支持的主路径，install/Docker/服务化全部走 Node

### 2b. 一键安装脚本

- `scripts/install.sh`（Linux/macOS/WSL2，`curl | bash`）+ `scripts/install.ps1`（Windows，`iex (irm ...)`）
- 依赖检测：Node ≥22（无则指引 fnm/nvm/winget，不静默替用户装系统级运行时）；PostgreSQL：本机可达 → 复用，否则引导 Docker 路径（`docker compose up -d postgres`）
- git clone → pnpm install → migrations → 安装方式戳记写入 `~/.memex/install.json`（`{method: git|docker, version, installed_at}`）→ 收尾进入 `memex onboard`（Phase 11 已建）
- managed 模式（docker 安装）下 onboarding 禁改 gateway 端口等 compose 管理项

### 2c. Docker 一键部署

- 根 `docker-compose.yml`：`postgres`（pgvector/pgvector 镜像 + 挂载 migrations 为 initdb）+ `gateway` + `workers`；数据卷 `pgdata` + `memex-home`
- `Dockerfile`（Node 22 单基底，2a 的直接收益）；healthcheck → gateway `/healthz`
- `docker-compose.hardened.yml` override：`internal`/`egress` 双网络 + 出口代理 allowlist（hermes network-egress-isolation 模式，Phase 14 衔接）
- 验证门：`docker compose config` 通过 + 本机 `docker compose up` 冒烟（环境允许时）

### 2d. `memex doctor`（纯诊断，不改配置）

检查项（每项独立、可注入探针、失败不中断后续）：
1. config.json 可解析 + profile 解析正确
2. Postgres 连通 + `pgvector`/`pgcrypto` 扩展存在 + migrations 水位
3. **hash chain 完整性抽查**（随机 scope 重算 version_hash 链；**erased_at 行跳过内容重验、保留链验**——Phase 14 遗留的验证器规则在此落地）
4. LLM provider 连通性逐个探测（registry 驱动）
5. Gateway 存活（/healthz）+ Node 版本 ≥22
6. channel token 存在性（不验真伪，避免 doctor 触发外呼）

### 2e. Profiles 多环境

- `~/.memex/profiles/<name>/config.json`；`MEMEX_PROFILE` env var 选择；默认 profile = 顶层 `~/.memex/config.json`（向后兼容，零迁移）
- 数据库隔离：per-profile `database` 字段约定（不自动建库，doctor 检查存在性）
- 子进程显式传递 `MEMEX_PROFILE`（env-filter 的 SAFE 前缀已含 MEMEX_）

### 2f. 服务化 + 远程 Gateway

- `memex service install`：生成 systemd unit / launchd plist / Windows Scheduled Task XML（生成文本可单测；实际注册需对应平台，输出指令由用户执行——不偷偷 sudo）
- `memex connect` 支持远程 gateway 地址 + token（MEMEX_REALTIME_TOKEN 语义复用）；TLS 由反代承担（文档声明，不内置证书管理）
- **TD-G 收尾**：`isPaired()` 内存 miss 时回查 DB（write-through 已有，跨副本/重启后新配对此前不可见）——一行语义补齐 + 测试

### 2g. 备份与恢复

- `memex backup` / `memex restore`：pg_dump/pg_restore 包装（自定义格式 -Fc），注入式命令执行器（单测不依赖真实 pg_dump）
- 恢复后自动跑 doctor 的 hash chain 抽查
- **备份加密约束（ADR-43 后果条款）的 1.0 答案：文档化"备份保留期 = 删除生效延迟"**。理由：Phase 14 D-1 修订后活库 erase=payload 置空，加密的独特价值只剩备份失效；备份加密密钥体系（与 key_registry 同源）的收益在单租户自托管 1.0 不及其运维复杂度（密钥丢失=全部备份不可恢复）。doctor 输出备份目录存在 erase 事件后旧备份的提示。ADR 记录此取舍，post-1.0 可重开。

## 3. 范围 Spec

**In scope：** 2a–2g 全部；部署拓扑 ADR（单机 all-in-one / Core 远程 + Shell 本地 / docker compose 三形态）。
**Out of scope：** 自动 TLS/证书管理（反代职责）；Nix/Termux 安装（post-1.0）；多副本高可用（单租户 1.0 无此需求）；备份加密实现（文档化取舍，见 2g）。

## 4. DoR

- [x] Phase 14 完成（安全前置门，a709c9d8）
- [x] Phase 11 Onboarding TUI 存在（packages/cli onboard.ts）
- [x] TD-M 评估材料：gateway 入口 Bun 依赖面已勘（仅 WS 适配层 + serve 形态）
- [x] pairing DB 持久化已有（migration 014 + write-through）——TD-G 只剩回查语义

## 5. DoD — 完成定义

| # | 门 | 验证方式 |
|---|---|---|
| G1 | Gateway 在 Node 22 下启动并服务 REST+WS（无 Bun）；Bun 路径回归不破 | 单测（Node WS 适配）+ tsc |
| G2 | install.sh 通过 `bash -n`，install.ps1 通过 PSParser；幂等（重复运行不破坏现有安装） | 语法门 + 干跑测试 |
| G3 | `docker compose config` 通过（base + hardened override 两份）；镜像可构建 | compose 校验（+环境允许时冒烟） |
| G4 | doctor 全部检查项有单测（探针注入）；erased_at 跳过规则有专门用例 | 单测 |
| G5 | profile 解析：`MEMEX_PROFILE=x` → profiles/x/config.json；未设 → 顶层 config（向后兼容测试） | 单测 |
| G6 | 服务文件生成器三平台输出可单测断言；backup/restore 命令构造 + 恢复后校验链路有测试 | 单测 |
| G7 | TD-G：isPaired DB 回查用例（内存 miss + DB hit → 配对有效） | 单测 |
| G8 | 部署拓扑 ADR 写就（含 TD-M 决策记录、备份加密取舍） | 人工评审 |
| G9 | 全量测试 + tsc clean | CI |

## 6. 前向铺路契约

1. **Phase 16 的发布物清单在此定形**：install.sh/install.ps1/docker-compose.yml/Dockerfile 是 Phase 16 发布管道的 checksum 对象——本阶段产出后路径不再移动。
2. **doctor 是 Phase 16 回归门的运行前提**：eval harness 先跑 doctor 再跑 journey。
3. **`memex --version` 的版本源**（package.json version）在 install 戳记中即统一，16 不重新发明。

## 7. 风险与开放问题

- 活体验证（docker compose up、三平台安装）在无对应环境的会话只能做到校验级——遗留项按惯例记入 implementation-notes。
- `@hono/node-ws` 与现有 ws-protocol 的 upgrade 适配差异需实测（API 同形但生命周期钩子可能有差异）。

---
*Phase 链：14（安全默认值）→ **15** → 16（发布物 checksum、回归门）*
