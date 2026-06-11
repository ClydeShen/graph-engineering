# ADR 48｜部署拓扑：单运行时收敛、三形态部署、profiles、备份语义

status: accepted
日期: 2026-06-12

---

## 上下文

Phase 15 (deploy-everywhere) 把开发者手工部署（clone、npm install、手配 Postgres、手写 env）变为"任何人一条命令"。前置是 Phase 14 的安全硬化——install 装到的默认形态就是安全形态。本 ADR 记录四个结构性决策；实现细节见 15-PHASE-SPEC。

## 决策

### D-1：TD-M 关账——Gateway 收敛到 Node 22 单运行时

**现状**：Gateway 入口是 Bun.serve 形态（`export default {port, fetch, websocket}`），WS 挂载经 `hono/bun`；Workers/Control-Plane 一直是 Node 22。双运行时让安装矩阵、Docker 镜像、doctor 检查全部 ×2。

**决策**：Node 22 是唯一受支持的主运行时。

- WS 协议层（ws-protocol.ts）本就 Bun-free；连接生命周期提取为 `makeWsConnectionHandlers()`（运行时无关核心），Bun/Node 各自的 upgrade 适配器消费同一工厂
- Node 路径：`@hono/node-server` serve + `@hono/node-ws` createNodeWebSocket（**注意**：hono.dev 当前文档展示的 `upgradeWebSocket` from '@hono/node-server' 在已发布的 1.19.x 不存在——实装验证 `@hono/node-ws` 才是稳定路径）
- Bun 路径保留为兼容分支（`globalThis.Bun` 探测），不删除、不维护新特性
- 活体验证：Node 22 下 REST `/v1/sys/health` + WS 协议回包全部通过，零 Bun 依赖

**后果**：install 脚本只检测 Node ≥22；Docker 镜像单基底 `node:22-slim`；dev.mjs 全组件统一 `node --import tsx/esm`。

### D-2：三形态部署拓扑

| 形态 | 组成 | 适用 |
|---|---|---|
| **dev** | 根 `docker-compose.yml`（仅 Postgres）+ `npm run dev`（iii→workers→ctrl+gateway 顺序启动） | 开发 |
| **all-in-one** | `deploy/docker-compose.yml`：postgres + migrate(一次性) + iii + workers + control-plane + gateway，单机六服务 | 自托管默认 |
| **Core 远程 + Shell 本地** | Gateway 暴露（MEMEX_BIND + token + 反代 TLS），MemexTerminal/Dashboard/cli 经 `shell.gateway_url` 远连 | 跨机器连续性 |

- 启动顺序镜像 dev.mjs 的根据（workers 必须先于 control-plane 注册 iii functions，否则 pulse-replay 打 function_not_found）——compose 用 `depends_on` 编码同一约束
- iii 引擎进镜像：`curl -fsSL https://install.iii.dev/iii/main/install.sh | sh`（**需要 jq**，install 脚本硬依赖，镜像构建实测发现）
- hardened override（hermes network-egress-isolation 模式）：`internal`（internal: true）+ `egress` 双网络；postgres/iii/control-plane 仅 internal（永远触不到外网、外网也触不到它们）；workers/gateway 双网络；app 服务全部 cap_drop ALL + no-new-privileges + pids_limit。egress 代理 allowlist 是文档化扩展点，不默认交付
- TLS 不内置：反代（caddy/nginx）职责，文档声明

### D-3：Profiles 多环境隔离

`MEMEX_PROFILE=<name>` → `~/.memex/profiles/<name>/config.json`；未设 → 顶层 `~/.memex/config.json`（零迁移向后兼容）。profile 名白名单 `[A-Za-z0-9_-]+`（路径穿越防护，非法名回落默认）。数据库隔离经 config `database.url` 槽位——不自动建库，doctor 检查可达性。子进程经 env 显式传递（`MEMEX_` 已在 SAFE_ENV_PREFIXES 白名单）。

### D-4：备份语义——保留期即删除延迟，加密刻意不做

`memex backup`/`restore` = pg_dump -Fc / pg_restore --clean --if-exists 包装 + 恢复后强制 hash-chain 验证（doctor 同一检查，erased_at 规则一致：内容重验跳过、链路验证保留）。

**备份加密（ADR-43 后果条款）的 1.0 答案：不实现，文档化语义。**

- ADR-47 D-1 修订后，活库 erase = payload 置空；加密的独特价值只剩"销毁 DEK 使旧备份失效"
- 单租户自托管下，备份密钥体系的运维风险（密钥丢失 = 全部备份不可恢复）超过其收益
- **文档化语义：备份保留期 = 删除生效延迟**——erase 之前的备份在老化淘汰前仍含已删内容；`memex backup` 输出时直接打印此提示
- post-1.0 重开条件：多租户、合规要求、或托管化部署出现时

### D-5：服务化与升级权限红线

`memex service` 生成 systemd unit / launchd plist / schtasks 命令文件 + 用户自行执行的注册指令。**memex 永不静默提权**（无 sudo、schtasks 用 `/rl limited`）。install 脚本同理：检测依赖并指引安装，不替用户装系统级运行时。

## 后果

- Phase 16 发布物清单定形：`scripts/install.sh`、`scripts/install.ps1`、`deploy/Dockerfile`、`deploy/docker-compose.yml`、`deploy/docker-compose.hardened.yml`——checksum 对象，路径不再移动
- TD-G 关账：`isPairedAsync` DB 回查使配对跨副本/跨重启可见（write-through + 读穿透 + 缓存水合）
- 活体遗留：compose 六服务全栈 up 的端到端冒烟（iii 容器间 ws 绑定行为待验证）记入 implementation-notes
