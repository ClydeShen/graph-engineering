# Spike Manifest — Graph-Native Agent Runtime

## Idea

每个阶段完成后，需要有一个用户可自行 demo 的任务，收集结构化 feedback，生成 log 文件，分析 log 并调整下一阶段的侧重点。

## Requirements (from spiking)

- R1: Demo runner 引导用户逐步完成 Gate 测试，每步捕获 pass/fail + 自由文字观察
- R2: 每次 demo 产出一个持久化的 `feedback/gate-N-YYYY-MM-DD.json` 文件
- R3: Feedback JSON 格式要能承载足够信号以驱动 phase-adjustment 分析
- R4: Analyzer 读取 feedback logs，产出 `feedback/ANALYSIS-gate-N.md` 含阻断项 + 建议

## Spikes

| # | Name | Type | Verdict | Key Finding |
|---|------|------|---------|-------------|
| 001 | gate-demo-runner | standard | ✓ VALIDATED | readline CLI 可引导用户完成 Gate 测试，JSON schema 足够捕捉 blocker 信号 |
| 002 | feedback-phase-analyzer | standard | ✓ VALIDATED | 关键词匹配 + 场景规则足以提取 phase 调整信号，无需 LLM |
