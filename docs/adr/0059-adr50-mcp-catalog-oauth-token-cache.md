# ADR 50｜MCP Catalog Manifest Schema 与 OAuth Token Cache

status: accepted
日期: 2026-06-12

---

## 上下文

Phase 6 交付的 `McpClientWorker` 仅支持 HTTP/Streamable transport、读取裸 `MCP_SERVER_URLS` env var——无目录、无鉴权、不分工具开关。Phase 17 补齐与 hermes-agent 对比的最大剩余差距：MCP server 目录、远程 MCP 的 OAuth PKCE、`memex mcp` CLI 管理命令。约束：配置形态必须让 Claude Code（`~/.claude.json` `mcpServers`）与 Hermes（`mcp_servers` YAML）用户零上手成本迁移；以 Phase 6 worker 为扩展基线不重写；MCP TypeScript SDK 自带 `OAuthClientProvider` 接口与 `auth()` 流程，不手搓 OAuth。

## 决策

### D-1：Manifest schema（`optional-mcps/<name>/manifest.yaml`）

PR-gated 仓库内目录（skills-guard 同款"预审但可审查"信任模型）。字段为 Claude Code / Hermes 条目的无损超集：

```yaml
name: <id>                  # 必须与目录名一致（SKILL.md name 同规则）
description: <string>
transport:                  # command XOR url（二选一，schema 强制）
  command: <string>         # stdio
  args: [<string>]
  env: {KEY: "${ENV_VAR}"}
  url: <string>             # http/streamable
  headers: {Authorization: "Bearer ${TOKEN}"}
  auth: oauth               # 触发 D-2 流程
requires_env: [<string>]    # 安装时未设置则提示（值仅入会话 env，永不落盘）
tools:
  default_enabled: [<tool>] # → config tools.include
```

`memex mcp install` 将 manifest 映射为 `~/.memex/config.json` 的 `mcp_servers.<name>` 条目（`McpServerEntrySchema`，additive 顶层字段）。安装前 manifest 内容过 `scanSkillContent` 扫描（目录内容同样是"来自 registry 的内容"）。

### D-2：OAuth PKCE + token 缓存

- `MemexOAuthProvider implements OAuthClientProvider`（SDK 接口），落盘 `<profileDir>/mcp-tokens/<server>.json`（0600；单文件含 tokens / client registration / PKCE verifier；按 profile 隔离）
- 放在 `@graph/shared`：CLI（login 流程）与 workers（transport authProvider）都消费，SDK 类型 type-only 导入零运行时成本
- `memex mcp login <name>`：本地 ephemeral 端口起 callback server → SDK `auth(provider, {serverUrl})` → REDIRECT 时开系统浏览器（headless 打印 URL）→ callback 收 code → `auth(..., {authorizationCode})` 完成交换落盘。token 刷新由 SDK 经 provider 自动处理
- public client + PKCE（`token_endpoint_auth_method: none`），动态 client 注册经 `saveClientInformation` 缓存

### D-3：transport 选择与工具过滤语义

- 条目有 `command` → `StdioClientTransport`；有 `url` → `StreamableHTTPClientTransport`（XOR 由 schema 保证）
- `tools.include` 先于 `exclude` 应用（include 圈定、exclude 剔除，exclude 胜于重叠）；过滤发生在注册前
- **ADR-51 切分**：`tools`/`enabled` 是期望态输入（兼容字段）；连接后实际生效工具面经 `memex::capability::surface_changed` 入图，图为语义权威。`notifications/tools/list_changed` 订阅 → 重列 → 重过滤 → 重注册 → 重观察
- 工具命名：config/catalog 条目用条目名作命名空间段（`graph::mcp-ext::<name>::<tool>`）；env var 匿名条目沿用裸 host（Phase 6 命名 grandfathered）；调用事件 payload 带确定性 `tool_entity_id`（`sha256('mcp-tool|<ns>|<tool>')` 截断成 UUID 形）

### D-4：CLI 命令族与配置写入纪律

`memex mcp catalog | install | configure | login | list | uninstall`。配置写入操作 RAW 文件（不经 `${ENV_VAR}` 展开）——secret 引用永不以解析值落盘；loader 仅在读取时解析。`uninstall` 同时删除 token 缓存。能力图事件（installed/uninstalled/configured）经 `capability:registry` 单例 scope 追加（CLI 经 nestScope 确保 scope——scope 创建权不下放 worker；DB 不可达时警告不阻塞，配置写入照常生效）。

### D-5：Claude Code 镜像

`memex connect claude-code --include-mcp-servers`：把已启用的 `mcp_servers` 条目镜像进 `~/.claude.json`（stdio→`type:"stdio"`，http→`type:"http"`）。同名条目以用户文件为准不覆盖；OAuth token 不复制（Claude Code 走自己的授权流）。

## 后果

- Claude Code / Hermes 用户的现有条目可逐字段照搬（见 `docs/mcp-config-compat.md` 映射表）
- 工具面动态性成为一等公民：list_changed 驱动的重注册意味着工具集变化不需要重启 worker
- `MCP_SERVER_URLS` 继续可用（降级为匿名 http 条目），Phase 6 部署零迁移
- 安全边界不变：`graph::mcp-ext::*` 工具不绕过 ADR-47 `isToolAllowed`；token 文件 0600 + profile 隔离；guard 扫描挡 manifest 注入

## 关联

ADR-22（声明式 registry 哲学）、ADR-47（信任分级）、ADR-51（能力图——本 ADR 的 D-3/D-4 实现其 Phase 17 最小增量）、Phase 16 skills-guard（D-1 复用其扫描与信任模型）
