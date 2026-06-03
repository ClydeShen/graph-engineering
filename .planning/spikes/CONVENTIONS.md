# Spike Conventions

## Stack

- TypeScript + tsx（直接运行，不需要 tsc build）
- Node.js 内置模块（readline, fs, path, os）—— 不引入 inquirer/prompts 等交互库
- 无额外依赖，`npx tsx scripts/<name>.ts` 即可运行

## Structure

```
scripts/
  demo-runner.ts          # Gate 交互式 demo + feedback 捕获
  analyze-feedback.ts     # Feedback logs 分析 → markdown 报告

feedback/
  gate-N-YYYY-MM-DD.json  # Demo runner 输出
  ANALYSIS-gate-N.md      # Analyzer 输出
```

## Patterns

- **readline 多行输入:** 空行结束多行 input，在 prompt 说明中告知用户
- **JSON schema versioning:** 所有 feedback log 带 `schema_version: "1.0"` 字段
- **分析关键词:** BLOCKER_KEYWORDS 和 RISK_KEYWORDS 分别维护，便于扩展
- **Gate/Phase 映射:** `NEXT_PHASE` 和 `GATES` 常量都在脚本顶部声明，Gate 2/3 直接扩展

## Tools & Libraries

- tsx 4.22.x — 直接运行 TypeScript，无需 build step
- Node.js `readline` — 跨平台交互 CLI，无需额外包
