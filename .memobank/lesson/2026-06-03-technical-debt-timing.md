---
name: technical-debt-timing
description: "区分\"现在爆炸的 bug\"和\"触发点风险\"，后者定点还清比立即还清或无限推迟更优"
metadata: 
  node_type: memory
  type: lesson
  tags: 
    - technical-debt
    - planning
    - phase-management
  created: 2026-06-03T00:00:00.000Z
  status: active
  confidence: high
  originSessionId: 9e5694c0-52b6-4763-8711-2bb249ea72b9
---

## 教训

不是所有技术债都应该立刻还。关键是区分两类：

| 类型 | 特征 | 正确处置 |
|------|------|----------|
| **立即爆炸的 bug** | 当前阶段已产生错误行为 | 立即修复（D1 task_spawned 失明、D6 OOM 误判收敛） |
| **触发点风险** | 当前静止，在某个未来边界开始累积利息 | 识别精确触发点，定点还清（D3 LLMProvider 位置、D4 SecurityException） |

## 反面案例（graph-native-runtime D3/D4）

D3/D4 在 Phase 1（无真实 LLM Tool）时是静止的。如果强行在 Phase 1 修复，干扰 Gate 1 测试节奏，引入范围蔓延。如果无限推迟，债务会蔓延到 Phase 2 的复杂实现里，修复成本乘数级上升。

正确决策：设定"Phase 2 Day 0 commit"作为精确还债点——第一个真实 Tool 实现之前必须到位，不早不晚。

## 应用规则

遇到技术债时，问两个问题：
1. 这个债务**现在**会产生错误行为吗？→ 是则立即修。
2. 它在哪个**具体事件**下开始有害？→ 把那个事件作为触发点，加入对应 phase 的 Day 0 前置任务，并写入 implementation-notes.md 追踪。
