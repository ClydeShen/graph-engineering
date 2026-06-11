# Phase 11: MemexShell — 设计笔记（标本对比分析）

**来源：** nanobot vs hermes-agent 对比分析会话，2026-06-10
**状态：** 预规划输入 — 供 `/gsd:discuss-phase 11` / `gsd-planner` 消化，尚未转化为 D-xx 决策
**关联：** `.harness/ROADMAP.md` 11-memex-shell 章节；`09-DESIGN-NOTES.md`（Phase 9 内存层差异化笔记，交叉引用）

---

## 背景

对比了 nanobot 和 hermes-agent 在以下三个维度上的实现：多渠道接入架构、系统权限/沙箱、以及（作为 Shell 层前置）pairing 身份审批流程。hermes-agent 相对 nanobot 在这三块都有显著工程演进，直接影响 Phase 11 的设计决策。

---

## 1. 渠道/连接器注册表：从 pkgutil 发现到声明式注册表

### nanobot 的做法
`channels/manager.py`：通过 `pkgutil.iter_modules` + `importlib.metadata.entry_points` 在启动时扫描所有 `BaseChannel` 子类，按 `config.json` 里 `enabled: true` 实例化。适配器是隐式发现的，Gateway 只知道"找到了几个 Channel 类"，没有关于它们能力的元数据。

### hermes-agent 的优化
`gateway/platform_registry.py`：每个适配器注册一个 `PlatformEntry` dataclass，声明：
- `check_fn`：依赖是否安装（`pip install ...` 缺失时 graceful skip）
- `validate_config`：配置是否完整（而非等到 connect() 报错才发现）
- `required_env`：Setup 界面展示所需 env var 清单
- `cron_deliver_env_var`：该渠道是否支持作为 cron 投递目标（以及读取哪个 env var 获取 home channel）
- `standalone_sender_fn`：cron 在独立进程运行时，不依赖 live gateway adapter 也能发消息
- `apply_yaml_config_fn`：YAML config → env var 的桥接，插件自己拥有配置翻译逻辑，不需要 core 知道每个平台的 schema
- `platform_hint`：注入 system prompt 的平台上下文（如"你在 IRC，不要用 markdown"）
- `pii_safe`：是否需要 PII 脱敏（session description 处理）

**核心变化：** 渠道从"实现了接口的类"升级为"带完整自描述元数据的可编程注册表条目"。状态面板、setup UI、cron 投递路由都直接消费这些元数据，而不需要用反射式探测。

### Memex 借鉴与差异化

**直接借鉴：** MemexShell 的 Connector 注册表应采用 `PlatformEntry` 式声明式设计。每个 Connector（Telegram/Discord/Slack/WebUI/etc.）注册时声明 `check_fn`/`validate_config`/`required_env`/`standalone_sender_fn`，Dashboard 的"已连接渠道"状态面板可直接消费，无需反射探测。

**差异化空间：** hermes 的 `PlatformEntry` 是纯运行时对象，Connector 的配置变更历史是不可见的（`config.yaml` diff 要靠 git）。Memex 中每次 Connector 配置变更本身可以作为 Trail Mesh 上的 Entity Snapshot——`connector::config_updated` Association——使配置变更历史可追溯，且可被 Trail Discovery 分析（如"每次 Telegram token 过期后通常下一步是什么"）。这不是 Phase 11 的必选项，但 Connector 注册表的数据结构设计时不应封死这个可能性。

---

## 2. 实时事件流：WSS vs SSE 的双轨选择

### nanobot 的做法
单一 WebSocket endpoint（`/ws`）：WebUI channel 直连，双向通信，适合高频交互（typing indicators、streaming deltas）。

### hermes-agent 的优化
分层网络隔离（`docs/security/network-egress-isolation.md`）：两个 Docker 网络——`internal`（无互联网，agent + dashboard + gateway 在此）+ `egress`（有互联网，经 squid proxy allowlist）。Gateway 双宿主，可对外通信但 agent 本身不直接出网。`hermes-dashboard` 只在 `internal` 网络，无需 egress。

这是针对"prompt injection → curl 外泄数据"的第二道防线，补充了 bwrap/exec 层的不足。

### Memex 双轨设计确认

ROADMAP 已锁定双轨（SSE for Dashboard，WebSocket for MemexTerminal）。来自标本对比的具体指导：

- **SSE 足够 Dashboard 所需**：Dashboard 是只读 Trail 消费者（新 Trail 写入通知、scope 状态推送），SSE 单向推送满足需求，HTTP/2 兼容，不需要 WS 握手升级。
- **WebSocket 是 MemexTerminal 的必须**：MemexTerminal 需要发送用户消息、接收 token streaming deltas，是双向交互——WebSocket 是正确选择。
- **安全参考**：若 MemexOS 支持 Docker 部署，hermes 的 `internal`/`egress` 双网络 + squid allowlist 模式直接可用作 compose 配置参考。参考文件：`D:\Repo\specimens\hermes-agent\docs\security\network-egress-isolation.md`。

---

## 3. Pairing / 身份审批：安全加固点

### nanobot 的做法
`pairing/store.py`：明文 8 位 code（字符串 key），10 分钟 TTL，threading.Lock + atomic write。简单可用，但 code 以明文存储在 `~/.nanobot/pairing.json`，读文件即可获取有效 code。

### hermes-agent 的优化（`gateway/pairing.py`）

六项安全加固，均来自 OWASP + NIST SP 800-63-4 指导：
1. **Code 不明文存储**：salted SHA-256 哈希（`hashlib.sha256(salt + code.encode())`.hexdigest()），随机 16 字节 salt，entry 以 `entry_id = secrets.token_hex(8)` 为 key（而非 code 本身）
2. **无歧义字母表**：32 字符（排除 0/O、1/I，防止肉眼混淆）
3. **速率限制**：同一用户同平台 10 分钟内只能请求 1 次 code
4. **平台最大 pending 数**：每平台最多 3 个 pending code（防止枚举攻击制造大量 pending）
5. **失败锁定**：5 次错误 approve 后平台锁定 1 小时（`_record_failed_attempt` → `_lockout`）
6. **文件权限**：所有 pairing 数据文件 `chmod 0600`（仅 owner 可读写）

approve_code() 使用 `secrets.compare_digest()`（constant-time 比较，防时序攻击）。

### Memex 借鉴

Phase 6 已交付 `cryptographic agent pairing`。Phase 11 的 MemexTerminal 连接 Gateway 时，如果引入"新设备审批"流程，应直接采用 hermes pairing 的六项加固标准，而不是重新发明。具体：
- Code 不明文存储（salted hash）
- 无歧义字母表
- rate limit + lockout

这是"工程安全细节抄作业"的标准场景——nanobot 的原始设计有已知缺陷，hermes 已做了修复，Memex 不需要经历同样的演进路径。

---

## 4. 环境变量两段式过滤（`execute_bash` 加固，非 Phase 11 主线）

来自 hermes `tools/code_execution_tool.py`（`_SECRET_SUBSTRINGS` + `_SAFE_ENV_PREFIXES`）：

```
# 先黑名单挡密钥
_SECRET_SUBSTRINGS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PASSWD", "AUTH", "DSN", "WEBHOOK")

# 再白名单放行
_SAFE_ENV_PREFIXES = ("PATH", "HOME", "USER", "LANG", "LC_", "TERM", "TMPDIR", ...)
```

Phase 6 已交付 `execute_bash` MCP tool，但其 env 处理可能没有这种双重过滤。这是个小型安全加固，可作为 Phase 11 的附带任务（或独立 micro-task），与 MemexShell 工作并行处理。

---

## 5. 跨渠道身份归一化（Phase 11+ 长期演进方向）

### hermes 的做法
硬编码规则文件 `gateway/whatsapp_identity.py`：WhatsApp 号码的各种格式变体（+1234、001234、1234等）展开为 alias set，`PairingStore._user_ids_match()` 用 alias 交集判断是否同一用户。每个新渠道需要自己写一套归一化函数。

### Memex 差异化空间
同一个用户在不同渠道（Telegram user_id `@alice` ≡ Slack user `U12345` ≡ Discord `alice#0001`）本质上是**同一个 Entity 的多个别名 Snapshot**。可以用图上的 Association 表达：`channel_identity_telegram:alice --[same_as]--> channel_identity_slack:U12345 --[same_as]--> entity:user:alice_principal`。

这种身份解析关系本身可以被 Trail Discovery 统计发现（同一时间窗口内不同渠道的相似行为模式 → 建议合并身份），而不需要为每个渠道硬写归一化函数。

**此项不是 Phase 11 必选**——Phase 11 可以先用简单的 `allow_from` + pairing 列表，身份归一化作为 Phase 12+ 的 MemexShell 演进项。但 Connector 的 `sender_id` 数据结构设计时应预留"同一 Entity 多渠道别名"的可能性（建议 `sender_id` 带 `channel_prefix`，如 `telegram:12345678`，而不是裸数字 ID），避免后续迁移成本。

---

## 不采纳的点

- **不引入 `MemoryProvider` 式 Connector 抽象层**：hermes 的 `PlatformRegistry` 已经足够声明式，不需要再加一层 Provider ABC。MemexShell 的 Connector 直接 implements `ConnectorAdapter` interface + 注册 metadata dataclass 即可。
- **不在 Phase 11 实现完整跨渠道身份图**（见上文第5点）——先交付可用的 pairing 列表，身份归一化推后。
- **不在 Phase 11 引入 cron 定时任务**：nanobot/hermes 的 cron 功能对 MemexShell 当前范围无必要，且 cron-as-graph-entity 的正确设计需要 Phase 9/10 的 Trail Mesh 完全就位后才能做好（参见 `09-DESIGN-NOTES.md` 交叉引用第3条）。
