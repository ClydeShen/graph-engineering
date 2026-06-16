---
name: reference-headroom-learning-directions
description: headroom 标本的 6 个学习方向及其对应的 Memex roadmap 阶段映射（2026-06-10）
metadata: 
  node_type: memory
  type: reference
  originSessionId: 922356e0-f326-4a2b-8fe9-24b3041a650e
---

来源：`D:\Repo\specimens\headroom`（已 roam 索引）。分析时间：2026-06-10。

## 6 个学习方向 → Roadmap 阶段映射

| 学习方向 | headroom 来源文件 | 对应 Memex 问题 | 目标阶段 |
|---------|----------------|--------------|---------|
| SmartCrusher 统计压缩策略 | `transforms/smart_crusher.py` | Knapsack Slicing 算法实现（ADR-13）| **Phase 08-context-assembly** |
| CCR 可逆压缩 + 检索工具注入 | `ccr/` | Context OOM Level-3 的可逆兜底 | **Phase 08-context-assembly** |
| Pipeline lifecycle hooks | `hooks.py`, `transforms/pipeline.py` | Worker 扩展点接口设计 | **Phase 08-context-assembly**（架构准备） |
| Memory supersession chains | `memory/` | `semantic_memory.superseded_by` 实现细节 | **Phase 09-memory-layers** |
| CCR feedback loop（检索率→压缩调参） | `cache/compression_feedback.py` | Ebbinghaus reinforcement 闭环 | **Phase 10-trail-discovery**（ROADMAP item #6） |
| headroom learn 失败→success correlation | `cli/learn.py` | TemplateProposalWorker 负样本挖掘逻辑 | **Phase 10-trail-discovery** |

## 三个目标阶段的职责边界

**Phase 08-context-assembly（新阶段，待写入 ROADMAP）**
- Knapsack Slicing 算法落地实现（ADR-13 规格 → 代码）
- Context OOM 三级降级 + CCR 可逆兜底替代 Level-3 硬截断
- Worker lifecycle hook 扩展点（on_pipeline_event 模式）
- 参考：headroom SmartCrusher 变点检测 + CCR tool_injection + response_handler

**Phase 09-memory-layers（新阶段，待写入 ROADMAP）**
- Episodic Memory 写入（scope_closed → episodic_memory）
- Semantic Memory + supersession chains（`superseded_by` + 部分 HNSW 索引）
- BM25+HNSW RRF 混合检索（ADR-20 规格）
- 参考：headroom HierarchicalMemory supersede() 实现细节

**Phase 10-trail-discovery（新阶段，待写入 ROADMAP）**
- TemplateProposalWorker：正负样本提取 + success correlation（参考 headroom learn）
- PatternDiscoveryWorker：cross-domain topology 算法（ADR-25）
- Procedural Memory + Ebbinghaus reinforcement（参考 headroom CCR feedback）
- CrystallizeWorker "外科式蒸馏"（ROADMAP Phase 7+ item #6）

## 注意：已在 ROADMAP 中的关联项

- **ROADMAP Phase 7+ item #6**（CrystallizeWorker 外科式蒸馏）→ 由 Phase 10 落地，headroom CCR feedback 提供实现参考
- **ADR-13 supplement**（context OOM 三级降级）→ 已有规格，Phase 08 补充 CCR 可逆路径
