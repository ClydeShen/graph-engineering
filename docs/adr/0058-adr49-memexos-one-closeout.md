# ADR 49｜MemexOS 1.0 收口：回归门、发布流程、遥测决策

status: accepted
日期: 2026-06-12

---

## 上下文

Phase 16 兑现"完整产品"的定义：skill 生态双向、E2E 验收与 eval、文档与发布管道。本 ADR 固定三件 post-1.0 不再重新协商的事。

## 决策

### D-1：回归门——post-1.0 一切变更的固定闸

发布前固定顺序，缺一不可：

1. `memex doctor`（环境与链完整性）
2. 全量测试 + tsc（CI 门）
3. `scripts/eval/journey.ts`（7 步断言 E2E：scope 创建 → OCC won → 冲突 demoted → 上下文投影采样 → 检索路由 → erase 链完好 → 指标快照）
4. 快照对比：`compareSnapshots(prev, curr)`，比率指标绝对降幅 > 0.05 即拦截。**null 指标（尚无信号）不触发拦截**——门防退化，不强求增长
5. `scripts/release-checksums.ts` 重新生成 SHA-256SUMS → tag → 发布

指标三维（"越用越聪明"的可测定义）：
- **Trail Discovery 命中率** = Σsuccess_count / Σinjection_count（procedural_memory，Phase 10 闭环）
- **Lesson 留存率** = 未 superseded 比率 + 强化分布（**数据在 procedural_memory**——Ebbinghaus 列的家；活体跑通时纠正了 semantic_memory 的误设）
- **Knapsack 压缩比** = kept/(kept+dropped)，从上下文装配响应采样（token 数不落库，journey 运行时采样）

快照存 `.harness/analysis/eval-snapshot.json`；指标 SQL 即 post-1.0 Dashboard 质量视图的数据接口（只消费不重设计）。

### D-2：发布流程与完整性

- 版本单源：根 package.json；`memex --version` 与 install 戳记同源
- 发布物清单冻结（ADR-48）：install.sh / install.ps1 / Dockerfile / compose ×2——SHA-256SUMS 覆盖，损坏一字节即校验失败（测试断言）
- 签名（minisign/cosign）是发布者手工步骤，仓库不存私钥
- **不做自动更新检查**：静默外呼与本地优先原则冲突；README/QUICKSTART 指引手动更新

### D-3：遥测——零实现即最强默认关闭

ROADMAP 标记"可选、本地优先、默认关闭"。决策：**不实现外发遥测**。
"自己的使用数据首先服务于自己的 Trail Discovery"已天然成立——全部使用数据本来就在图里，eval 指标层直接消费账本。外发遥测的收益（横向产品改进信号）在单租户自托管 1.0 为零。post-1.0 若出现托管形态再议，且必须 opt-in + 仅聚合指标。

### D-4：skills-guard 的定位与演化模式

review aid，非安全边界（ADR-47 边界声明的延伸）。8 类模式（prompt-override / concealment / credential-harvest / secret-file-access / exfiltration / encoded-payload / destructive-command / env-hijack）是**活清单**：新注入手法追加 GuardRule 即可，架构不动。`inspect` 用当前模式集重扫已装 skill——昨天的干净扫描不自动有效。registry 描述对象按公开文档编写，首次活体调用时校正（注入 fetch 的单测兜底行为不变）。

## 后果

- MemexOS 1.0 的"完成"有了可操作定义：回归门全绿即可发布
- 活体遗留（implementation-notes）：真实 registry API 形态核验；带 LLM key 的全栈 journey（蒸馏/反思步进入断言）；三平台安装实跑
