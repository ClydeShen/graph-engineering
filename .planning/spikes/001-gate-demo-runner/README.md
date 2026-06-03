---
spike: "001"
name: gate-demo-runner
type: standard
validates: "Given Gate 1 的 5 个 Scenario，when 运行交互式 CLI 引导用户操作，then 每步 pass/fail + 自由观察被写入 feedback/gate-N-YYYY-MM-DD.json"
verdict: VALIDATED
related: ["002"]
tags: [feedback, cli, testing, gate]
---

# Spike 001: gate-demo-runner

## What This Validates

Given Gate 1 的 5 个测试 Scenario，when 用户运行 `npx tsx scripts/demo-runner.ts`，then 系统引导用户逐步完成每个 Scenario，捕获 pass/fail 和观察内容，并写出结构化 `feedback/gate-1-YYYY-MM-DD.json`。

## How to Run

```bash
npx tsx scripts/demo-runner.ts          # Gate 1 (默认)
npx tsx scripts/demo-runner.ts 1        # 显式指定 Gate 1
```

## What to Expect

1. 打印 banner 和 setup checklist
2. 询问 setup 是否通过（p/f/s）
3. 逐一展示每个 Scenario 的 curl 命令和期望结果
4. 询问每个 Scenario 的 pass/fail 和观察
5. 写入 `feedback/gate-1-YYYY-MM-DD.json`
6. 打印下一步指令

## Investigation Trail

**尝试 1:** 用 Node.js 内置 `readline` 实现交互，不引入额外依赖（`inquirer`/`prompts`）。
- 结果：readline 工作正常，但多行输入需要空行结束，略显笨拙
- 决定：接受这个 UX 限制，因为 LLM 用户通常在粘贴 pino 日志时会有换行，加一行说明即可

**关于 JSON Schema 设计:**
- 最初想要 `signals_for_next_phase` 字段让用户填写，但这太重了
- 改为 runner 只捕获原始观察，由 Spike 002 analyzer 提取 signals
- `free_feedback` 字段给用户一个自由文字表达整体感受的空间

**Windows 兼容性:** 脚本使用 `path.join(process.cwd(), 'feedback')` 处理路径，兼容 Windows 和 Unix。

## Results

**Verdict: VALIDATED**

脚本运行无 tsc 错误（使用仅 Node.js 内置模块）。JSON schema 包含足够的字段供分析器提取信号：
- `status` per scenario → pass/fail 率
- `observations` free text → blocker 关键词匹配
- `pino_log_sample` → 日志片段保存，便于事后 debug
- `free_feedback` → 用户整体反馈

**局限性:**
- 多行输入用空行结束，对于复杂 pino 日志有轻微摩擦
- 不验证 curl 命令是否真的执行了——完全靠用户诚实报告
