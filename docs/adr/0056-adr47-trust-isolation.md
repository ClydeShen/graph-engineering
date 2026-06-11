# ADR 47｜信任硬化：erase 落地、审批状态机、执行后端、secrets/PII、信任分级执行

status: accepted
日期: 2026-06-11

---

## 上下文

Phase 14 把"个人自托管玩具"硬化为可对外开放的系统。原则采纳 hermes SECURITY.md："**no in-process mechanism is a security boundary**——只有 OS 级隔离构成真正的遏制"。本 ADR 内一切 in-process 防线（CommandGate、env 过滤、PII 脱敏）定位为纵深防御层；边界是容器。

## 决策

### D-1：erase(scope) 落地——活库 payload 置空，crypto-shredding 推迟到备份耦合点（ADR-43 D-2 修订）

ADR-43 D-2 设想 payload 加密存储 + 销毁 DEK。实施发现：对**活库**，payload 置空（`UPDATE payload='', erased_at=NOW()`）与销毁密钥达成**完全相同的语义**——ADR-43 D-3 的验证规则（erased 节点跳过内容重验、version_hash 保留为承诺、链路验证照常）本来就是为此设计的。加密的独特价值在**备份**（销毁 DEK 使旧备份同步失效），而备份密钥体系（KEK 来源、轮换）是 Phase 15 备份设计的核心议题。

**因此**：
- Phase 14 落地：`erase(scope)` = 账本 payload 置空 + `erased_at` 标记 + 派生数据级联（ADR-43 D-4 表）+ `memex::payload::erase` 审计事件（D-5）
- `key_registry` 表建好（migration 016），DEK 加密路径与备份密钥同源耦合在 Phase 15 落地——届时旧备份保留期语义按 ADR-43 后果条款文档化
- Knapsack/reflect：erased 行天然零 token（payload 为空）；派生行已物理删除

**级联语义（ADR-43 D-4 原文执行）**：单源 episodic/semantic/procedural 行物理删除（含 embedding）；多源 Lesson 从 `source_scope_ids` 摘除 + `needs_redistill`（当前 schema 单 `source_scope_id`，多源行即 fingerprint Lesson——按 `source_scope_id` 匹配删除，fingerprint Lesson 标记 redistill）。

### D-2：跨渠道审批状态机

- `approval_request` 投影表（migration 016）+ 全流程审计事件入图（请求/批准/拒绝/超时各一条 `memex::security::approval_*`）
- 流转：`pending` → `/approve`→`approved` / `/deny`→`denied` / 超时（默认 5 分钟）→`timed_out`（**Silence is not consent**）
- 审批范围：`once`（本次）/ `session`（该 scope 存续期）/ `always`（写 config allowlist——**写入动作本身需要一次审批**，防自我提权）
- 推送经 DeliveryRouter（`expects_reply: true`，Phase 12 预留位）到 home channel

### D-3：CommandGate 三层化

1. **硬线 blocklist**：任何模式（含 YOLO）不可绕过——现有 hardline 层不变
2. **pattern 审批**：dangerous 命中 → 审批流（D-2）；YOLO 模式可绕过
3. **aux-LLM smart approval（tier-3，Phase 5 起悬置）**：**只收紧不放宽**——LLM 判定 dangerous → 升级审批；LLM 判定 safe **不构成放行**（pattern 该拦截仍拦截）。模型用独立小模型（provider 注册表已支持）

### D-4：执行后端抽象

- `local` / `docker` 双后端；docker 参数复刻 hermes `_BASE_SECURITY_ARGS`：`--cap-drop ALL`、`--security-opt no-new-privileges`、`--pids-limit`、nosuid/noexec tmpfs、内存/CPU 限额、`--network none`（默认无网，显式开egress）
- **容器内命令绕过 pattern 审批**（hermes rationale：容器内破坏性命令触不到宿主机）；硬线 blocklist 仍生效（防 fork 炸弹类资源攻击的第一道筛）
- 后端选择入 `~/.memex/config.json`；SSH/cloud 后端不做（post-1.0）
- orphan container reaper：`--rm` + label 扫描兜底

### D-5：Secrets 两段式过滤 + 写入 denylist

- subprocess env：先黑名单挡密钥子串（`KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/PASSWD/AUTH/DSN/WEBHOOK`）再白名单放行前缀（`PATH/HOME/USER/LANG/LC_/TERM/TMPDIR/SYSTEMROOT/COMSPEC` 等）——共享实现，local 与 docker 后端同源
- env 写入 denylist：`LD_PRELOAD/LD_LIBRARY_PATH/PYTHONPATH/NODE_OPTIONS/PATH` 永不可被 agent 设置（hermes config.py:116 模式）

### D-6：PII 脱敏与分工

- `redactPii()`（email/电话/IP 模式）独立于 `writeGuard()`（密钥，永远生效）——PII 模式在 `pii_safe` 渠道与 LLM 发送边界应用，不全局套用（email 渠道的正文必须含邮箱地址，全局脱敏会破坏功能）
- 与 erasure 的分工按 ADR-43 D-6：写入前防御 vs 事后救济

### D-7：信任分级 → 工具集映射

```
trusted   → 全部工具
paired    → 全部工具 − execute_bash（须显式升级 trusted）
untrusted → webhook-safe 集（只读检索类：search/wait/agent-card；不得触达文件/命令/写图工具）
```

执行点：MCP 路由按 `X-Agent-ID` → `agent_registry.trust_level` → 工具 allowlist 校验（in-process 纵深层，非边界——边界是 D-4 容器）。webhook 渠道消息的 turn 天然以 untrusted principal 运行。

### D-8：安全事件枚举（一次定齐）

`memex::security::approval_requested / approval_granted / approval_denied / approval_timeout / blocklist_hit / trust_downgrade / payload_erase`——全部经 writeInfraEvent('archived') 入图，可查询、可被 Trail Discovery 分析。

## 后果

- 删除权可用（G4 红线：erase 后内容不可得、级联完成、链验证仍过）
- 已知边界（SECURITY.md 素材，G8）：旧备份不受活库置空影响（Phase 15 密钥耦合解决）；多源 Lesson redistill 窗口期；in-process 防线非边界声明
- aux-LLM 只收紧的不对称设计杜绝"LLM 被骗放行"攻击面

## 关联

ADR-43（宿主：删除权——D-1 为其 D-2 的实施修订）；ADR-46（trust_level/principal）；ADR-44（审批推送的通道）；Phase 5 CommandGate；migration 016；Phase 15（备份密钥耦合、hardened compose）；Phase 16（SECURITY.md）。
