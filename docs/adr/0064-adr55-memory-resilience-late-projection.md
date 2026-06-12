# ADR 55｜记忆韧性：embedding 作为迟到投影 + ADR-39 故障分类修订

status: proposed（提纲——结构核心已在 2026-06-12 fuller 会话拍板，实现细节待 plan-phase 展开）
日期: 2026-06-12

---

## 上下文

活体复现（P1）：embedding 端点不可达（`fetch failed`）触发 `writeContextOomThrottled`
→ `scope.suspended.lockout`——ADR-39 为"真上下文溢出"设计的永久锁死被环境性错误
误触发。叠加 `AnthropicProvider` 无 `embed()`：onboarding 只配 Anthropic 时第一句话
必锁死，是架构必然而非配置错误。

生命周期宪法条款（本次拍板）：网络抖动或单一云端能力缺失导致微内核核心能力坍塌，
不可原谅；但"跳过语义记忆"也是对四层记忆范式的弃守——**降级 = 替补顶上，而非弃守**。

关键结构事实：在 Memex 里 embedding **不是记忆本身，是记忆的索引**。Trail Mesh 是
SSOT，append-only 写入与 crystallization（chat LLM 蒸馏）均不依赖 embedding；
且 Snapshot 内容寻址（version_hash 不可变）使 embedding 计算**天然幂等、可重放**。
索引是图的投影——投影可以迟到，图永不缺席。

技术红线：向量空间不可混用——本地小模型向量与远端模型向量塞进同一 pgvector 索引
会令相似度检索整体失真（Hermes HRR 成立的前提恰是从不混用）。故"本地顶上"只能
顶**检索防线**，不能顶**向量写入**。

## 决策

### D-1：故障分类学——环境错误 ≠ 语义溢出

- **环境性/瞬时**（fetch failed、timeout、5xx、DNS）：记为 trail deviation（偏差是
  一等 trail 数据），对话照常，**不触发 lockout**
- **真上下文溢出**：维持 ADR-39 原语义，lockout 不变
- `writeContextOomThrottled` 的调用点按此分类改造；错误分类器为对话核心（ADR-54）
  与 memory 管线共用

### D-2：embedding = 迟到投影（写入防线不需要顶）

- embedding 不可达时，待算条目按 `version_hash` 进 pending 队列（幂等键）
- 回填 worker 在端点恢复后自愈补算；重复入队无害（内容寻址去重）
- 语义索引从"同步强一致"改为"最终一致的图投影"

### D-3：检索降级——pg 全文/BM25 顶上检索防线

- embedding 不可达期间，语义检索降级为 Postgres 全文检索/BM25（pg 是既有硬依赖，
  零新增依赖，确定性）
- 挂靠既有设计资产：ADR-20 supplement（hybrid retrieval BM25+RRF）——降级路径即
  混合检索去掉向量分量后的退化形态，评分位点天然兼容
- 远期方向（ROADMAP，非本弧）：本地为主的单空间记忆基座（Hermes HRR 式）

### D-4：doctor 与 onboarding 语义

- onboarding：LLM provider 一个即可，embedding 为**可选项**（Anthropic-only 可用）
- doctor：增加 embedding 端点探测，不可达 = **warn**（附降级状态说明），非 fail
- 探测项从 ADR-56 声明表派生，杜绝再次脱节

## 后果

- "第一句话锁死"（P1）根除；对话永不被记忆基础设施阻塞
- 记忆不丢：断网窗口期只损失检索质量与索引新鲜度，恢复后自愈
- N8 残渣（误锁死的 suspended scope）需一次性清理/解锁迁移——工程项

## 关联

- 修订 ADR-39（suspended lockout 边界收窄至真溢出）
- ADR-13 supplement（context OOM degradation）/ ADR-20 supplement（BM25+RRF）
- ADR-54（对话核心）/ ADR-56（provider 注册表：embedding 可选声明）
- `.harness/FINDINGS-install-flow.md` P1/N7/N8
