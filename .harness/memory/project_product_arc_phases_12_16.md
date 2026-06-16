---
name: project-product-arc-phases-12-16
description: 2026-06-11 规划的产品化弧线 Phase 12–16，已写入 .harness/ROADMAP.md；覆盖多终端/多agent协作/信任硬化/一键部署/1.0收口
metadata: 
  node_type: memory
  type: project
  originSessionId: 436c29a8-5ba4-483c-896d-79c7a265b32f
---

2026-06-11 用户要求规划 Phase 10（实际是 11）之后直到"完整产品"的 roadmap，已写入 `.harness/ROADMAP.md` 的"产品化弧线"章节：

- **12-connector-matrix**：ConnectorRegistry（hermes PlatformEntry 模式）、Slack/Email/Webhook 渠道、graph-native cron（job 存图）、DeliveryRouter、跨平台会话连续性（相对 hermes platform-scoped session 的结构性优势）
- **13-agent-federation**：内部 delegation（嵌套 Trail）、A2A 协议适配、graph-mediated collaboration（OCC 跨 agent 冲突归因）、Lesson 可见性域（agent-private/shared/global）、跨渠道身份归一化（same_as Association）
- **14-trust-isolation**：execute_bash docker 后端（cap-drop 等复刻 hermes）、跨渠道审批流（Silence is not consent）、secrets 两段式过滤、webhook-safe 受限工具集、安全事件入图
- **15-deploy-everywhere**：install.sh/ps1、docker-compose（含 internal/egress hardened override）、memex doctor、profiles、系统服务、远程 Gateway（落地 [[project_user_needs_cross_machine_continuity]]）、backup/restore
- **16-memexos-one**：skill 安装侧 + skills-guard、E2E eval（Trail Discovery 命中率等"越用越聪明"可测指标）、文档与发布管道

**排序原理**：12–13 自托管下扩能力面；14 是 15"任何人都能装"的安全前置门；16 质量收口。Post-1.0 候选（多模态、computer use、Federated Trail Mesh、ACP、SSH/cloud 后端）记录在 ROADMAP 末尾，不排期。

**Why:** Phase 11 设计笔记明确推迟的项（cron、跨渠道身份）被分配到 12/13；hermes 深度研究报告是主要素材来源。

**安全补充（同日，用户确认后写入）：** 安全缺口审查后补进 ROADMAP——Phase 11 WS/SSE ADR 范围加本地认证+限速；Phase 12 Webhook 加 HMAC 签名校验；Phase 14 加数据安全交付物（crypto-shredding 实现、静态加密、PII 脱敏）；Phase 15 备份加密约束；Phase 16 发布完整性（checksum+签名）+ SECURITY.md。**ADR-43 已接受并提交**（`docs/adr/0049-adr43-payload-erasure-crypto-shredding.md`，accepted，commit 19199ca9）：结构永久/内容可删、per-Scope DEK crypto-shredding 分两步落地、erased 节点跳过内容重验保留链路验证、**Phase 09 记忆表建表必须带 `source_scope_id` provenance + `erased_at`（唯一阻塞 Phase 09 的决策）**、erase 入图审计。

**How to apply:** 讨论 Phase 12+ 范围时以 ROADMAP 该章节为基线；调整顺序前先回看"排序原理"。Phase 09 规划时必须消化 ADR-43 D-4 的 provenance 约束。

**PHASE-SPEC 09–14（2026-06-11，commit 7af8311d）：** 每阶段一份 `.planning/phases/<NN-name>/<NN>-PHASE-SPEC.md`（设计要点/范围/DoR/DoD/前向铺路契约），各阶段 discuss/planning 启动时必读。DoR/DoD 跨阶段互锁；关键前向契约：09 语料质量→10、10 锁 template_graph schema、11 冻结 ConnectorAdapter+修 TD-E→12、12 留 trust_level/expects_reply 槽位→14、13 定 trust_level 枚举+principal 模型→14、14 硬化默认值→15 安装出厂态+16 SECURITY.md 素材。09 的 spec 是 retrofit（不重开已 PASS 的 plans）。

**技术债清偿轨道（2026-06-11 第二次盘点，已写入 ROADMAP）：** 13 项债务（TD-A~M）编入 Phase 09–15，原则是"编入自然属于的阶段，不设独立还债阶段"。关键项：TD-A provenance 列已确认在 Phase 09 plan（migration 012，无需返工）；TD-E `dispatchMessage` fresh-scope 修复编入 Phase 11 且是 **Phase 12 跨平台会话连续性的硬前置**；TD-C `template_graph` 结构化格式是 Phase 10 质量门（否则 Phase 16 命中率指标不可测）；TD-I skill 粒度（P1-G）是 Phase 13 多候选路由的前置决策。`docs/未决问题追踪.md` 脚注已指向 ROADMAP 该章节，不再双轨跟踪。

[[project_memex_final_product_is_hermes_like_e2e]]
[[project_memex_terminal_naming]]
[[reference_specimens_directory]]
