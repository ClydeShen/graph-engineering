# Phase 14: trust-isolation — Phase Spec

**写入：** 2026-06-11
**用途：** `/gsd:discuss-phase 14` 与 planner 的前置输入。
**基线：** `.harness/ROADMAP.md` §14-trust-isolation；ADR-43（accepted，D-2 第二步在本阶段落地）；hermes SECURITY.md 信任模型；Phase 5 CommandGate / Phase 6 pairing 存量。

---

## 1. 目标与定位

把"个人自托管玩具"硬化为可对外开放的系统。这是 Phase 15"任何人都能装"的安全前置门，也是产品在真实场景可托付的分水岭。采纳 hermes 核心原则：**no in-process mechanism is a security boundary——只有 OS 级隔离构成真正的遏制**。本阶段一切 in-process 防线（CommandGate、env 过滤、PII 脱敏）定位为纵深防御层，不是边界；边界是容器。

## 2. 设计要点（规划前必须消化）

### 2a. 执行后端抽象（新 ADR）

`execute_bash` local / docker 双后端：
- docker 后端复刻 hermes `_BASE_SECURITY_ARGS`：`--cap-drop ALL` + 最小 cap-add、`--security-opt no-new-privileges`、`--pids-limit`、nosuid/noexec tmpfs、内存/CPU 限额
- **容器内命令绕过审批**（hermes rationale：容器内破坏性命令触不到宿主机）——审批流的负载因此大幅下降，这是设计耦合点：2a 与 2b 一起定
- orphan container reaper（进程崩溃后的容器回收）
- 后端选择入 config.json；SSH/cloud 后端明确不做（post-1.0）

### 2b. 跨渠道审批流（新 ADR：异步审批状态机）

- 审批请求经 DeliveryRouter 推 home channel（Phase 12 `expects_reply` 标记位已留）；`/approve` `/deny` 回流
- **"Silence is not consent"**：超时（默认 5 分钟）即拒绝；审批请求/批准/拒绝/超时全部入图（D-5 同款审计模式）
- 范围：once / session / always（always 写 config allowlist，写入本身也要审批——防自我提权）
- CommandGate 升三层：硬线 blocklist（任何模式不可绕过）→ pattern 审批（YOLO 模式可绕过）→ 可选 aux-LLM smart approval（Phase 5 起悬置的 tier-3，在此落地；**LLM 判断只能收紧不能放宽**——LLM 说危险则升级审批，LLM 说安全不构成放行）
- 状态机要点：审批是跨进程异步事件（请求在 worker，回应在渠道）——状态存图，不存内存

### 2c. ADR-43 落地（crypto-shredding，D-2 第二步）

discuss 阶段第一个决策：**payload vault（旁路表存密文）vs 列级密文（原表加密列）**。倾向 vault：账本表 DDL 不动（append-only 表加列有迁移风险）、密文集中便于备份策略对齐、erased 即 vault 行删除。决策后落地：
- `key_registry`（per-Scope DEK，KEK 包裹）；KEK 来源：config.json 引用的 env/文件，**KEK 轮换语义在 ADR 中声明**（重包裹 DEK，不重加密数据）
- `erase(scope)` 工作流：销毁 DEK → 派生数据级联（episodic/semantic/procedural 行 + embedding 物理删除；多源 Lesson 摘除 scope + `needs_redistill`）→ GIN/HNSW 索引行同步清理（ADR-20 关联）→ 写 `memex::payload::erase` 事件
- 账本表加 `erased_at`（D-3：验证器跳过内容重验、链路验证保留）——本阶段唯一触碰账本 DDL 的迁移
- **Knapsack 对接**：erased 节点零 token 参与装包（ADR-13 关联）——reflect 与 assemble 路径都要测

### 2d. Secrets 与 PII

- env 两段式过滤（`_SECRET_SUBSTRINGS` 黑名单 → `_SAFE_ENV_PREFIXES` 白名单）用于一切 subprocess（execute_bash 与未来后端共用一个过滤函数）
- env denylist：`LD_PRELOAD`/`PYTHONPATH`/`PATH` 等永不可被 agent 写入（hermes `config.py:116` 模式）
- PII 脱敏（hermes `privacy.redact_pii`）：发送 LLM 前 + 写账本前两个卡点；与现有 `writeGuard()`（API key 正则）合并为一个 redaction 管道，避免两套正则两处维护。与 erasure 的分工按 ADR-43 D-6（写入前防御 vs 事后救济）

### 2e. 信任分级执行

- Phase 13 定形的 `trust_level` 枚举 → 工具集映射表（AgentCard.trust_level → allowed tools）
- Webhook 渠道默认 webhook-safe 受限工具集（Phase 12 registry `allowed_toolset` 槽位填值）：不可信第三方内容不得触达文件/命令执行工具
- per-principal 白名单建立在 Phase 13 的统一 principal 模型上——本阶段不碰身份建模

### 2f. 安全事件入图

审批全流程、blocklist 阻断、信任降级、erase 操作都是 Association——可查询、可被 Trail Discovery 分析（"这个 agent 总在尝试越权"是涌现信号，Phase 13 冲突归因语料的延伸）。

## 3. 范围 Spec

**In scope：** 执行后端抽象 ADR + local/docker 实现；审批流 ADR + 状态机实现；CommandGate 三层化（含 tier-3 aux-LLM）；crypto-shredding 全链路（vault 决策、key_registry、erase 工作流、账本 erased_at 迁移、Knapsack 对接）；env 过滤 + denylist；PII redaction 管道（与 writeGuard 合并）；信任分级 → 工具集映射；webhook-safe 工具集执行；安全事件入图；静态加密部署指引（文档，非代码）。

**Out of scope：**
- SSH/cloud 执行后端 → post-1.0
- 备份加密实现 → Phase 15（但 key_registry 语义本阶段定义时必须满足 §6.2 约束）
- SECURITY.md 成文 → Phase 16（本阶段产出其素材：威胁模型、已知边界清单）
- 多租户隔离——MemexOS 1.0 是单租户自托管，租户间隔离不在范围

## 4. DoR — 进入规划的就绪条件

- [ ] Phase 12 DoD G4（DeliveryRouter——审批推送通道）；Phase 13 的 `trust_level` 枚举与 principal 模型定形（13 可与 14 部分并行，但 §2e 依赖 13 的这两项产出）
- [ ] ADR-43 accepted（已满足，commit 19199ca9）
- [ ] vault vs 列级密文决策材料准备：账本表当前体积、pgcrypto vs 应用层加密的性能短测（≤1 天）
- [ ] hermes `_BASE_SECURITY_ARGS` / SECURITY.md / `network-egress-isolation.md` 三份参考精读（标本在 `D:\Repo\specimens\hermes-agent`）
- [ ] discuss 议题定序：① vault 决策 ② 审批状态机 ③ 后端抽象（②③ 有耦合点 §2a）

## 5. DoD — 完成定义（可观测门）

| # | 门 | 验证方式 |
|---|---|---|
| G1 | docker 后端：容器以 cap-drop ALL 等全套参数运行（`docker inspect` 断言）；容器内 `rm -rf /` 类命令执行不触宿主机；orphan reaper 回收崩溃残留 | 沙箱测试集 |
| G2 | 审批流：危险命令 → home channel 收到请求 → `/approve` 放行 / `/deny` 拒绝 / 5 分钟无回应自动拒绝；全流程事件在图中可查 | E2E + 超时夹具 |
| G3 | 硬线 blocklist 在 YOLO 模式下仍然阻断（不可绕过性测试）；aux-LLM 判断只升级不放行（构造 LLM 说"安全"的用例，pattern 该拦截仍拦截） | 安全测试（红线） |
| G4 | erase(scope) 端到端：执行后密文不可解、三表派生行与 embedding 消失、多源 Lesson 标记 `needs_redistill`、`memex::payload::erase` 事件存在、**链路验证仍通过**（D-3）、Knapsack/reflect 不再返回该 Scope 内容 | erase 全链路测试（红线） |
| G5 | env 过滤：种植 `MY_API_KEY`/`GITHUB_TOKEN` → 子进程 env 中不存在；`PATH` 写入尝试被拒 | 过滤测试 |
| G6 | PII redaction：邮箱/电话/API key 在 LLM 请求体与账本 payload 中均为 `[REDACTED:*]`；redaction 管道单一实现（grep 无第二套正则） | 卡点测试 + grep |
| G7 | webhook 来源消息的 agent turn 中，文件/命令工具调用被拒且写安全事件；trust_level 映射对 MCP peer 生效 | 信任分级测试 |
| G8 | 威胁模型文档草稿（Phase 16 SECURITY.md 素材）：边界声明、已知边界清单（ADR-43 备份窗口、redistill 窗口）成文 | 人工评审 |
| G9 | 性能回归：加密路径上的写入延迟增幅 <20%（vault 决策时实测定基线）；全量测试 + tsc | 基准对比 + CI |

## 6. 前向铺路契约

1. **Phase 15 的安装默认值即本阶段的硬化产物**：docker 后端 + 审批开启 + redaction 开启是 install 脚本的出厂默认——"任何人都能装"装到的就是安全形态，不安全模式需显式 opt-out。
2. **key_registry 语义约束**（ADR-43 后果条款）：备份加密密钥体系必须与 key_registry 同源可达——本阶段设计 key_registry 时即写明"备份消费接口"（导出 KEK 包裹结构的稳定格式），Phase 15 backup 不重新设计密钥语义。
3. **Phase 16 SECURITY.md 直接由 G8 素材成文**：威胁模型、"什么不是安全边界"声明、已知边界——16 只做编辑整理，不做安全设计。
4. **安全事件 schema 稳定**：`memex::security::*` 事件类型枚举一次定齐（approval_requested/granted/denied/timeout、blocklist_hit、trust_downgrade、payload_erase）——Dashboard 安全视图（post-1.0 或 16）只消费不新增。

## 7. 风险与开放问题

- **本阶段红线测试（G3/G4/G5）的意义不同于功能测试**——它们是对抗性断言，规划时应作为独立 plan 任务（先写攻击用例再实现防御），不是实现完顺手补测。
- **vault 决策影响半径大**（备份、性能、erase 实现）：discuss 阶段第一个拍板，且短测数据先行，不拍脑袋。
- **审批疲劳**：容器内绕过审批 + always allowlist 是两个泄压阀，但 local 后端用户的审批频率仍可能过高——G2 验收后用真实 UAT journey 数一数审批次数，过高则调整 pattern 分层（这是 value-change，便宜）。
- **aux-LLM smart approval 的模型选择**：审批判断用小模型（成本）还是主模型（质量）——讨论阶段定，倾向独立小模型 + provider 注册表已支持多 provider（Phase 11 产物）。

---
*Phase 链：12（DeliveryRouter）+ 13（trust_level/principal）→ **14** → 15（安装默认值、key_registry 备份接口）、16（SECURITY.md 素材）*
