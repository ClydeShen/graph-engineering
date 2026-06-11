# MemexOS 威胁模型草稿（Phase 14 G8 → Phase 16 SECURITY.md 素材）

> 状态：草稿。Phase 16 编辑成正式 SECURITY.md（含漏洞披露政策）。

## 信任模型核心声明

**No in-process mechanism is a security boundary.** CommandGate、env 过滤、PII 脱敏、trust→toolset 映射都是纵深防御层；真正的遏制边界是 OS 级隔离（docker 执行后端，ADR-47 D-4）。local 后端 = 信任宿主环境的开发模式。

## 边界内（we defend against）

| 威胁 | 防线 |
|---|---|
| 不可信第三方内容（入站 webhook）驱动 agent 触达文件/命令工具 | untrusted principal → webhook-safe 工具集（D-7，红线测试）；HMAC 强制（未签 401 零图写入） |
| agent 提权执行破坏性命令 | CommandGate 硬线（任何模式不可绕）→ pattern 审批（跨渠道，silence=deny）→ aux-LLM 只收紧 |
| 密钥经 subprocess env 泄漏 | 两段式过滤（黑名单子串+白名单前缀），local/docker 同源实现 |
| 加载器劫持（LD_PRELOAD/PYTHONPATH/PATH 注入） | env 写入 denylist |
| 已写入内容的删除诉求 | erase(scope)：账本置空+erased_at、派生级联、审计不含内容（ADR-43/47） |
| 伪造 agent 接入 | pairing（盐哈希、无歧义字母表、限速、lockout、constant-time、DB 持久化） |
| 实时端点滥用 | token 认证（timingSafeEqual）+ 连接/消息限速 + localhost 默认绑定 |
| LLM 被骗放行危险命令 | tier-3 不对称设计：LLM 判定只能升级审批，永不放行 |

## 边界外（explicitly NOT defended，须文档化）

- **宿主被攻陷**：local 后端下 agent 与宿主同权——容器后端是开放部署的前置
- **旧备份中的已删内容**：活库置空触不到已落盘备份——Phase 15 备份密钥与 key_registry 同源耦合后解决；之前文档化"备份保留期 = 删除生效延迟"（ADR-43 后果条款）
- **多源 Lesson redistill 窗口**：erase 后到下次 reinforcement 之间，fingerprint Lesson 暂存旧蒸馏（抽象洞察，非原文）
- **DoS/资源耗尽**（单租户自托管，限速是公平性手段非 DoS 防御）
- **侧信道/时序攻击**（pairing/token 比较已用 constant-time，但不承诺全面侧信道防护）
- **多租户隔离**：1.0 是单租户自托管，不存在租户边界

## 安全事件可观测性

`memex::security::*` 枚举（ADR-47 D-8）全部入图：审批全流程、blocklist 阻断、信任降级、erase。"某 agent 反复尝试越权"是 Trail Discovery 可发现的涌现信号。

## 待 Phase 15/16 完成项

- hardened docker-compose（internal/egress 双网络 + proxy allowlist，hermes network-egress-isolation 复用）
- 备份加密与 key_registry 耦合（销毁 DEK 对备份生效）
- 发布完整性（checksum + 签名）
- SECURITY.md 正式化 + 漏洞披露渠道
