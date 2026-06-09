# Token Budget Prediction — Design Findings

**Source:** /grill-me session, 2026-06-06/07
**Status:** CONCLUDED — not pursuing (see Conclusion section at bottom, 2026-06-07)

---

## Context / Pain Point

LLM runtime 的 context window 有限制，用户必须手动用 `/compact` 压缩上下文，导致上下文漂移。
目标：系统能预测 token 消耗，让 LLM 拥有足够信息在业务层面主动决策（spawn subagent 等），避免被动压缩。

---

## Confirmed Decisions

### 1. 预测锚点：模板级 (procedural_memory)
`procedural_memory` 的每个 template 新增 `token_stats JSONB`，存储该拓扑模式的历史 token 消耗分布。
`TemplateProposalWorker` 在每次 scope 关闭后，更新对应模板的 token_stats。

**New schema fields (to add to procedural_memory):**
```json
{
  "token_stats": {
    "sample_count": 0,
    "template_mean": null,
    "avg_payload_tokens": null,
    "p95": null,
    "alpha": null,
    "beta": null,
    "sample_count_v2": 0
  }
}
```

### 2. 自适应预测机制（TemplateProposalWorker 自动切换）

**阶段 0 — 绝对冷启动 (sample_count = 0)**
- 无任何历史数据
- LLM 看不到预算信息
- LLM 纯粹从业务层面推理，正常 spawn subtask
- 系统不干预

**阶段 A — 冷启动 (sample_count < 10)**
- 线性缩放降级
- `Y_predicted = template_mean × (Tokens(Payload_current) / avg_payload_tokens)`
- 物理语义：当前输入是历史均值的 N 倍 → 预测消耗也是 N 倍

**阶段 B — 成熟收敛 (sample_count_v2 >= 10)**
- 线性回归
- `Y_predicted = α × Tokens(Payload_current) + β`
- α（边际消耗速率）：任务对输入体积的敏感度
  - 高 α：代码重构（代码越长，上下文暴涨）
  - α ≈ 0：编译检查（错误日志长度相对固定）
- β（固有结构开销）：走完该拓扑的保底事件节点消耗（spawn/validate/converge）

### 3. 预测值交付方式：A+C
- **A（volatile 推送）**：每次 context assembly 时，把当前预算快照注入 volatile 层
  - 触发条件：sample_count > 0（有预测值时才推送，冷启动不推送）
- **C（工具）**：提供 `get_token_budget()` tool，LLM 需要时主动查询

### 4. Subagent 内容/决策 = Out of Scope
LLM 凭业务认知判断是否 spawn subagent。系统只提供信息，不自动触发。

### 5. ADR 56 — 主权隔离
- 系统不允许「让 LLM 看系统级指标，然后用系统指标代替业务判断」的设计
- 冷启动时不推送任何预算信息
- 有预测值时推送——但**呈现方式悬而未决**（见下方 Open Question）

---

## Letta Research Finding

Letta 的「virtual memory cache」实际机制（非预测，是约束+自管理）：
- Context window 切成有 character limit 的 **typed memory blocks**
- Agent 知道每个 block 的 limit，主动通过 tool call 决定换入换出
- **Sleeptime agent**：在两次对话之间异步运行做记忆整理 → 类比我们的 TemplateProposalWorker（scope 关闭后后台更新 token stats）

**对本系统的启发：**
- Volatile 里的预算快照可以**按 zone 分区汇报**（而不是一个总数），与 Letta 的 typed block 思路一致
- TemplateProposalWorker 的 token stats 更新本质是 sleeptime 模式

---

## Open Question (Stopped at Q10)

**预测值怎么呈现给 LLM？**

ADR 56 排斥「系统级指标语言」（`token_budget: { used: 45000, remaining: 62000 }`）。
但到底是：
- (A) 数字本身有问题（不应该暴露 token 计数）
- (B) 「用系统指标代替业务判断」这个行为有问题（数字可以出现，但语义框架要是业务的）

两种表达方式对比：

**方案 A（系统指标语言）：**
```json
{ "token_budget": { "used": 45000, "predicted_remaining": 62000, "w_max": 200000 } }
```

**方案 B（业务信号语言）：**
```json
{ "workflow_complexity_signal": { "pattern": "code-refactor", "historical_depth": "deep", "estimated_continuation": "substantial" } }
```

**用户尚未回答此问题。下次继续从 Q10 开始。**

---

## Spike 006 Correction (also from this session)

原始 Spike 006 README 把 Mem0/Zep/Letta 判为「INVALIDATED（与我们系统不兼容）」——**这个框架本身是错的**。

正确研究目的：
- 这些是**参考标本**，不是替代候选
- 研究目标：提取压缩算法、交互机制、设计模式
- 需重写 Spike 006 README，verdict 改为研究性结论

**Spike 006 README 需要重写。**（独立任务，与本设计走向无关，继续作为单独待办项保留）

---

## 结论（收尾，2026-06-07）

**经 /fuller 系统性重新审视后判定：本设计方向为 over-design，正式收尾，不予推进。**

### 诊断

1. **前提假设有误**：原始痛点描述（"LLM 必须手动 `/compact`，导致上下文漂移"）描述的是*外部* LLM CLI（如 Claude Code）的体验，并不成立于本系统——本系统从未有人工压缩这回事。ADR 30 早已用 `ReverseChronologicalDiscarder`（Zero-LLM，确定性，对主 LLM 完全不可见）取代了这一切，且明文"Option B（同步 LLM 压缩）永久废除"。

2. **真正的潜在缺口已被原始架构解决**：唯一合理的剩余顾虑——"机械丢弃会不会让 Worker 失去还需要的因果信息"——原始设计早有应对：
   - **默认路径**：完全机械、对主 LLM 不可见的滑动窗口丢弃（ADR 30 D-2）
   - **极端升级路径**：仅当 `Size(N_root)+Size(N_current) > W_max` 的罕见灾难性场景，才升级到 ADR 13 的三级降级链——且第一级蒸馏调用的是*小型本地辅助模型*（Llama-3-8B/Qwen），执行的是窄域摘要任务，而非主 LLM 做战略判断

3. **新设计的姿态与原始设计哲学方向相反**：本设计提议的是"持续运行的统计预测系统，把信号推给主 LLM，让它做业务级战略决策（spawn subagent 等）"——这不是填补空白，而是引入了原始架构特意回避的模式（让主 LLM 对预算保持无感、压力完全由机制层吸收）。"ADR 56 主权隔离"这条新原则，本质上是在为一个方向本就有问题的设计打补丁。

### 决定

- **不写新 ADR**，不实现 `token_stats` schema、`TemplateProposalWorker` 扩展、`get_token_budget()` 工具、volatile 预算注入
- **不保留任何残余方案**（包括"纯 pull 式查询 `_meta.tokens`"的极简版本）——目前没有任何观察到的真实痛点驱动它；ADR 30 已明确"Worker can re-query the graph if needed"是已授权能力，无需专门补原语来"支持"它。如未来出现真实需求，届时按需添加不迟
- Q1-Q9 的所有"确认决策"作废——它们建立在已被推翻的前提之上，不构成对未来设计的约束

### 唯一保留的独立待办

Spike 006 README 重写（与本设计走向无关，研究框架定位纠正）——继续作为单独任务推进。
