# Phase 16: memexos-one — Phase Spec

**写入：** 2026-06-12
**用途：** Phase 16 planner 前置输入。
**基线：** `.harness/ROADMAP.md` §16-memexos-one；docs/THREAT-MODEL-DRAFT.md（Phase 14 G8 素材）；`.harness/analysis/uat-journey-2026-06-07.md`（journey 雏形）；hermes skills_guard / SECURITY.md 模式。

---

## 1. 目标与定位

MemexOS 1.0 收口：skill 生态双向、端到端验收与 eval、文档与发布管道。"完整产品"的定义在此兑现——之后的开发进入 post-1.0 节奏。

## 2. 设计要点

### 2a. Skill 生态双向（安装侧补齐）

- 导出侧已有（Phase 5 agentskills.io）；本阶段补 `memex skills search / install / inspect`
- registry 抽象：agentskills.io / ClawHub 双 registry 兼容（注入式 fetch，URL 模板差异收在 registry 描述对象里，不写两套客户端）
- **skills-guard**（hermes skills_guard.py 模式）：安装前对 SKILL.md 做注入模式扫描（prompt-injection 指令、外呼 URL、凭据索取、编码混淆），输出分级告警 + 须确认；**明确定位 review aid 而非安全边界**（边界仍是容器，ADR-47）
- 安装落点 `~/.memex/skills/<name>/`；inspect 显示已装 skill 的 guard 复扫结果

### 2b. E2E 验收场景集 + eval harness

- `memex eval`（或 scripts/eval）两层：
  1. **journey 层**（live-gated）：UAT journey 固化为可重复脚本——创建 scope → 事件写入 → OCC 冲突 → 记忆蒸馏 → reflect 检索 → erase，每步断言
  2. **指标层**（SQL，可单测）：Memex 特有质量指标的查询定形：
     - Trail Discovery 命中率 = `success_count / injection_count`（Phase 10 reinforcement 数据）
     - Lesson 留存率 / 强化率（Ebbinghaus 数据：reinforcement_count 分布、superseded 比率）
     - Knapsack 压缩比（assembleContext 的 volatileTokens vs contextLayerTokens，Phase 8 已记录）
- 回归门定义：发布前 doctor → 全量测试 → journey（活体）→ 指标不退化（与上次发布快照对比）

### 2c. 文档与发布管道

- `docs/QUICKSTART.md`：一键安装 → 第一条 Trail 五分钟内（用户视角，不是 ADR 复述）
- `SECURITY.md`（仓库根）：THREAT-MODEL-DRAFT 编辑成文——边界声明（in-process 不是边界）、已知边界（备份保留期语义、redistill 窗口）、漏洞披露渠道（GitHub Security Advisories）+ 响应承诺
- `CHANGELOG.md` + 版本化：git tag `vX.Y.Z`；`memex --version`（package.json 单一版本源，Phase 15 戳记同源）
- **发布完整性**：`scripts/release-checksums` 对发布物（install.sh/install.ps1/docker-compose.yml/Dockerfile）生成 SHA-256SUMS；签名（cosign/minisign）文档化为发布者手工步骤，不在仓库存私钥
- doctor 更新检查：**不做**自动检查（可选项，静默外呼与本地优先原则冲突）；`memex --version` 输出当前版本即止，README 指引手动 `git pull`/`docker pull`

### 2d. 遥测：刻意不实现

ROADMAP 标记"可选、本地优先、默认关闭"。决策：**不实现独立遥测**——"自己的使用数据首先服务于自己的 Trail Discovery"这一条已经天然成立（全部使用数据本来就在图里，eval 指标层直接消费）。外发遥测零实现 = 最强的"默认关闭"。ADR 一段话记录此决策即可。

## 3. 范围 Spec

**In scope：** 2a–2d；1.0 收口 ADR（发布流程、遥测决策、回归门定义）。
**Out of scope：** 自动更新机制；遥测上报；skill 市场 UI（CLI 即 1.0 形态）；多模态/ACP/联邦 Mesh（post-1.0 清单已在 ROADMAP）。

## 4. DoR

- [ ] Phase 15 完成（发布物清单定形、doctor 可用）
- [x] THREAT-MODEL-DRAFT.md 存在（Phase 14 G8）
- [x] UAT journey 雏形存在（.harness/analysis/uat-journey-2026-06-07.md）
- [x] Phase 10 reinforcement 数据结构（template_injection、success_count/injection_count）可查

## 5. DoD — 完成定义

| # | 门 | 验证方式 |
|---|---|---|
| G1 | skills search/install/inspect 全链路单测（注入 fetch + 临时目录）；双 registry 描述对象覆盖 | 单测 |
| G2 | skills-guard：注入模式样本集（恶意 SKILL.md 夹具 ≥6 类）全部被标记；干净样本零误报断言 | 红线式单测 |
| G3 | 指标层 SQL 三项指标有单测（夹具数据 → 期望值）；journey 脚本存在且 live-gated | 单测 + skipIf |
| G4 | QUICKSTART.md / SECURITY.md / CHANGELOG.md 成文；SECURITY.md 含披露渠道与边界声明 | 人工评审 |
| G5 | checksums 脚本对发布物清单生成 SHA-256SUMS 且可验证（损坏一字节 → 校验失败测试） | 单测 |
| G6 | `memex --version` 输出 package.json 版本 | 单测 |
| G7 | 1.0 收口 ADR（发布流程 + 遥测决策 + 回归门定义） | 人工评审 |
| G8 | 全量测试 + tsc clean | CI |

## 6. 前向铺路契约（post-1.0）

1. **回归门是 post-1.0 一切变更的固定闸**：doctor → tests → journey → 指标对比，顺序与内容写入 ADR，后续不重新协商。
2. **指标层查询是 Dashboard 质量视图（post-1.0）的现成数据接口**——SQL 定形后 UI 只消费。
3. **skills-guard 模式集是活清单**：新注入手法追加模式即可，架构不动。

## 7. 风险与开放问题

- journey 层活体验证依赖运行中的 Postgres + gateway——无环境会话只能交付脚本与断言结构，活体跑通记 implementation-notes 遗留（与 11–14 惯例一致）。
- agentskills.io / ClawHub 的真实 API 形态未在本环境核验——registry 描述对象按公开文档写，标注"首次活体调用时校正"（与 A2A 推迟同款处理，但这里有注入 fetch 的单测兜底）。

---
*Phase 链：15（发布物、doctor）→ **16** → post-1.0（回归门治理一切）*
