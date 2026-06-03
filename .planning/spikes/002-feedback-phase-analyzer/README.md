---
spike: "002"
name: feedback-phase-analyzer
type: standard
validates: "Given 1+ feedback/gate-N-*.json 文件，when 运行 analyze-feedback.ts，then 输出 feedback/ANALYSIS-gate-N.md 含阻断项、风险项、已验证信号和 Phase N+1 调整建议"
verdict: VALIDATED
related: ["001"]
tags: [feedback, analysis, phase-planning, markdown]
---

# Spike 002: feedback-phase-analyzer

## What This Validates

Given 一个或多个 gate feedback JSON 文件（由 Spike 001 的 demo runner 生成），when 运行分析脚本，then 自动提取阻断项、已验证信号，并产出可直接作为下一阶段 planning 输入的 markdown 报告。

## How to Run

```bash
# 先运行 demo runner 生成 feedback logs
npx tsx scripts/demo-runner.ts 1

# 然后分析
npx tsx scripts/analyze-feedback.ts        # Gate 1 (默认)
npx tsx scripts/analyze-feedback.ts 1      # 显式指定
```

## What to Expect

输出 `feedback/ANALYSIS-gate-N.md`，包含：
- 概览表（运行次数、pass/fail 总计、整体状态）
- Scenario 结果汇总表
- 阻断项（BLOCKER）列表
- 风险项列表
- 已验证信号列表（从 observations 和 pino 日志中提取）
- Phase N+1 调整建议
- 用户原文反馈
- 失败 Scenario 详情（含 pino 日志片段）

## Investigation Trail

**关键设计决策：关键词匹配 vs 语义分析**

最初考虑用 LLM 分析 observations 文本，但这对一个本地 demo 工具来说太重了。
选择：
1. 关键词列表匹配（BLOCKER_KEYWORDS、RISK_KEYWORDS）用于分类
2. 模式匹配（pino 字段名、OCC/hash 关键词）用于提取信号
3. 基于 scenario ID 的规则用于生成 phase 调整建议

这个方案足够捕捉关键信号，且在没有 LLM 的环境下也能工作。

**已验证：用样本数据测试**

样本场景：4 pass + 1 fail（Scenario E，OCC 返回 500 而非 demoted）。
分析器正确输出：
- Scenario E 为 BLOCKER
- Hash chain、scope.created、OCC、Zod 为 verified signals
- Phase 2 建议：先稳定 OCC，再 LLM worker

## Results

**Verdict: VALIDATED**

分析器成功从结构化 JSON 中提取信号，markdown 输出可读性好，可直接贴入 GitHub issue 或作为 Phase 2 planning 的输入依据。

**局限性：**
- 关键词匹配在中文观察内容中可能遗漏部分信号（中英文都在 BLOCKER_KEYWORDS 中有覆盖）
- 跨多次运行的趋势分析（"Scenario E 三次都失败了"）目前只做基本汇总，不做深度趋势分析
- phase 调整规则是硬编码的，Gate 2/3 需要扩展 `NEXT_PHASE` map 和 adjustment logic
