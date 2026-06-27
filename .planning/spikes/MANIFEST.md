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
| 003 | shadow-adapter | standard | ✓ VALIDATED | `sql.startsWith('WITH new_version AS')` 精确拦截 OCC 写，SELECT 穿透，NOTIFY 隔离免费 |
| 004 | pi-extension | standard | ✓ VALIDATED | Pi ExtensionAPI 可注册 spawn_task/complete_task，/fork 激活 InMemoryShadowAdapter，无需活跃 Pi 实例 |
| 005 | connect-pi | standard | ✓ VALIDATED | 原子写 + backup + 幂等检查，agentmemory stub 升级为完整自动安装 |
| 006 | mem0-zep-letta-fit | research | ✗ INVALIDATED | All 3 assume they are SSOT; incompatible with append-only PostgreSQL execution graph. Custom 4-layer build justified (CoALA arXiv:2309.02427) |
| 007a | canonical-json-fss | standard | ✓ VALIDATED | fast-json-stable-stringify is byte-for-byte identical to custom canonicalJson() across 22 test cases incl. -0, unicode, nested objects |
| 007b | canonical-json-rfc | standard | ✓ VALIDATED | canonical-json (RFC 8785) is byte-for-byte identical across 23 test cases incl. float edge cases (1e308, 5e-324) |
| 008 | token-bucket-limiter | standard | ✓ VALIDATED (migration NOT recommended) | limiter.TokenBucket achieves parity with pre-fill fix, but migration adds npm dep + non-drop-in API for zero functional gain |
| 009 | dead-occwrite-removal | standard | ✓ VALIDATED | occWrite in graph-handle.ts exported but zero external callers — inlined into write() and dead export removed; 163 tests pass |
| 010 | skill-crystallization-quality (learning-engine PoC cores) | research | ◑ MECHANISMS PROVEN (live pending) | 4 deterministic cores on the faithful-ab DAG: PoC-1 step-DAG is verifiable-at-crystallization (rejects corruption a text Lesson keeps); PoC-2 cue from failure traces converges P=R=100% (beats push-all/pure-pull); PoC-3 error-transfer 24→18 monotone, oracle gate is load-bearing (no oracle = poison); PoC-4 stigmergic 3-agent convergence, OCC no-dup, deadlock floor. **Live n=1 paired §5 gate experiment STRONG POSITIVE**: OFF (ungated) locks into 121/converged=false runs 4-10; ON (admission gate) rejects 3 DAG-contradicting crystallizations → converges to optimum 38/gateFails 0 and holds. Env root-cause along the way: embedding endpoint (dead llamacpp → NVIDIA bge-m3), not dirty data. NOT statistically VALIDATED — needs the 8-curve campaign (collapse-rate OFF vs ON). See `FINDINGS.md` + `docs/VALIDATION-PLAN.md` |

## Pi Sandbox — Phase 4 Architecture (from spikes 003–005)

Pi = `@earendil-works/pi-coding-agent`（外部 AI coding agent，非我们自己的组件）

```
packages/
  pi-extension/           ← Spike 004 的生产实现
    src/index.ts          ← ExtensionAPI entry (spawn_task, complete_task, /fork, /fork-end)
    package.json          ← { "pi": { "extensions": ["./src/index.ts"] } }

  shared/src/
    write-guard.ts        ← InMemoryShadowAdapter（Spike 003 的生产实现）

  cli/src/connect/
    pi.ts                 ← connect-pi CLI（Spike 005 的生产实现）
```

**双轨生命周期:**
- Interactive Mode: Pi + 我们的扩展 → `PostgresWriteAdapter` → PostgreSQL → DB Trigger → NOTIFY → real Workers
- Rehearsal Mode: `/fork <entryId>` → `runtime.fork()` + `InMemoryShadowAdapter.proxy` → `Map<string,ShadowEntry[]>` → `/fork-end` → `clear()` 阅后即焚
