# ADR 53｜自主助理：能力获取审批协议、ask_user、凭据保险库、受控浏览器

status: accepted
日期: 2026-06-12

---

## 上下文

Phase 20（autonomous-assistant，S3 场景）。Phase 12–19 的件恰好都是为此预留的接口：审批流（ADR-47 D-2）、信任分级（D-7）、执行后端抽象（D-4）、DeliveryRouter、会话连续性（TD-E）、能力图（ADR-51）、artifact（ADR-52）。本阶段是组合 + 四块新设计。

## 决策

### D-1：自主能力获取 = 两段式审批协议（"agent 不能给自己授权"）

MCP 工具族（ADR-51 动词：search_catalog / install / inspect，无 select）：

- `capability_search(query)`：统一搜 presets + skill registries；某个 registry 挂了不遮蔽其余结果
- `capability_install(install_ref)`【第一段】：**当场下载并 guard 扫描**，扫描报告嵌入审批请求正文（人带着报告做决定）→ 返回 `approval_id`，状态 pending
- `capability_install(install_ref, approval_id)`【第二段】：审批状态门——仅 `approved` 执行；执行时 `installSkill` 内部**重新下载重扫**（TOCTOU 防护：内容可能在请求与批准之间被换）；安装事件带 `initiated_by` + `approval_id` 入能力图
- 审批基建复用 ADR-47 状态机原样：silence is not consent（5 分钟超时即拒）、once/session/always、审计事件
- v1 范围：`skill:<registry>:<id>` 全自动；`preset:<name>` 返回操作员指引（preset 可能要交互式 env/OAuth，只有 CLI 能驱动）

### D-2：ask_user = 审批状态机的自由问答泛化

`user_question` 表（migration 019）镜像 `approval_request` 形态：pending → answered | timed_out（10 分钟沉默扫除）。工具面 `ask_user` + `ask_user_status`（轮询）；人侧入口 `POST /v1/questions/:id/answer`（渠道命令 `/answer` 与 `/approve` 同批活体接线）。问答对是一等 Trail 数据（`memex::ask_user::*` 审计事件）——"agent 总在同一步骤求助"是 Trail Discovery 信号。

### D-3：凭据保险库 = ADR-43 crypto-shredding 下沉到 service 粒度

- **信封加密**：per-service 随机 DEK（AES-256-GCM 包密文），DEK 由操作员 KEK（`MEMEX_VAULT_KEK`，32B base64）包裹；`shred` 销毁 wrapped DEK 行 = 密文永久死亡（备份语义沿 ADR-48 D-4）
- **边界纪律（核心不变量）**：凭据值**永不**进账本或 LLM context——prompt 携带 `{{vault:<service>}}` 占位符（redact 方向）；占位符**仅在工具执行边界**解析为明文（inject 方向，subprocess/transport 使用前一刻）；未知/已 shred 的 service 解析失败时 fail closed
- KEK 缺失 = 保险库整体不可用（显式报错，不静默降级）

### D-4：受控浏览器 = 类目解析 + 容器不变量

- browser 是 capability **类目**：worker 面签名固定（navigate / read / fill / click / screenshot），实现由 ADR-51 `bound_to` 链决定（预设推荐 agent-browser；映射表按实现扩展）
- **不变量是隔离边界而非实现选型**：一律跑在 docker 执行后端（`_BASE_SECURITY_ARGS` 全保留，仅 network 改 bridge——没有 egress 的浏览器是镇纸）；**明确不控宿主浏览器**（宿主级 computer use 仍属 post-1.0）；登录态只存在于容器卷
- 截图 = artifact（ADR-52 首个强制生产者：base64 出容器 → saveArtifact → 账本经 `artifact_hash` 引用）
- fill 文本中的 vault 占位符在容器命令组装边界注入（D-3）；账本记 op 与实现名，**永不记 fill 值**
- 工具受 `MEMEX_BROWSER_ENABLED` 门控（execute_bash 同款）

### D-5：信任面扩展

`capability_install` 与 `browser` 加入 PAIRED_DENIED（触达磁盘/执行边界，与 execute_bash 同级）——paired principal 需显式升级；untrusted 维持 WEBHOOK_SAFE_TOOLS。HTTP MCP 路由的 `isToolAllowed` 拦截自动覆盖新工具。

### D-6：北极星 journey 进回归门

网球场故事固化进 `scripts/eval/journey.ts`（步骤 5a–5d，外部端点 mock）：获取审批门（pending 阻塞→批准放行）/ ask_user 往返 / vault redact→inject→shred 生命周期（KEK 门控跳过）/ 背书浮现（activation → cold-start evidence）。随 ADR-49 发布门必跑。

### D-7：结构迁移——skills client + guard 下沉 @graph/shared

`skills-guard.ts` → `shared/src/skills/guard.ts`、`skills.ts` → `shared/src/skills/registry.ts`：gateway（D-1 扫描与安装）与 cli 都消费，二者互不依赖。纯逻辑零新依赖；cli 经 `@graph/shared` 导入。

## 后果

- S3 自主性的全部红线有了可执行形态：人审装、问人、密文凭据、容器浏览器
- 渠道命令路由（/approve /answer /pair）仍是活体接线批次——REST 决策入口先行可用
- `memex-browser` 容器镜像（含 agent-browser 的镜像）属部署物，随活体批次构建验证

## 关联

ADR-47（审批状态机、信任分级、执行后端——全部原样复用）、ADR-51（动词族、bound_to、背书）、ADR-52（截图 artifact）、ADR-43（crypto-shredding 机制）、ADR-49（回归门顺序）
