/**
 * Gate Demo Runner
 *
 * Guides the user through a gate's test scenarios, captures structured
 * feedback at each step, and writes a feedback log for phase analysis.
 *
 * Usage: npx tsx scripts/demo-runner.ts [gate-number]
 * Default gate: 1
 *
 * Output: feedback/gate-N-YYYY-MM-DD.json
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Read ports from env (fall back to project defaults 4000/4001)
const GATEWAY_PORT = process.env.PORT ?? '4000';
const GW = `http://localhost:${GATEWAY_PORT}`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  name: string;
  description: string;
  status: 'pass' | 'fail' | 'skip';
  observations: string;
  pino_log_sample: string;
}

interface FeedbackLog {
  schema_version: '1.0';
  gate: string;
  phase: string;
  run_at: string;
  environment: {
    node_version: string;
    platform: string;
  };
  setup_status: 'pass' | 'fail' | 'skip';
  setup_notes: string;
  scenarios: ScenarioResult[];
  gate_result: 'pass' | 'fail' | 'partial';
  pass_count: number;
  fail_count: number;
  skip_count: number;
  free_feedback: string;
}

// ─── Gate Definitions ─────────────────────────────────────────────────────────

const GATES: Record<number, Gate> = {
  1: {
    name: 'Gate 1 — Phase 1 核心基础设施',
    phase: '01-core-graph-engine',
    setup_instructions: `
  必须在测试前完成：
  1. PostgreSQL 15+ 正在运行，扩展 pgcrypto + pgvector 已安装
  2. 数据库迁移已执行（psql $DATABASE_URL -f migrations/00N-*.sql）
  3. iii Engine 已启动（iii --config iii-config.yaml）
  4. Workers 进程已启动（npx tsx packages/workers/src/index.ts）
  5. Control Plane 进程已启动（npx tsx packages/control-plane/src/index.ts）
  6. HTTP Gateway 进程已启动（npx tsx packages/gateway/src/index.ts）
  7. .env 文件包含 DATABASE_URL, III_URL, PORT=4000, LOG_LEVEL=debug
`,
    scenarios: [
      {
        id: 'A',
        name: '创建 Scope',
        description: `
  运行：
    curl -s -X POST ${GW}/v1/scopes \\
      -H "Content-Type: application/json" \\
      -d '{"intent": "Gate 1 smoke test"}' | jq .

  期望：
    • HTTP 201
    • 响应包含 scope_id (UUID) 和 plan_hash (64位 hex)
    • Gateway pino 日志出现 "scope.created" 含 scope_id 字段
    • psql 查询 execution_event_log 中出现 plan_created 事件，predecessor_hash 全为 0
`,
      },
      {
        id: 'B',
        name: '提交事件 + 验证 hash chain',
        description: `
  用 Scenario A 的 scope_id 和 plan_hash：
    SCOPE_ID="<A返回的scope_id>"
    PLAN_HASH="<A返回的plan_hash>"

    curl -s -X POST "${GW}/v1/scopes/$SCOPE_ID/events" \\
      -H "Content-Type: application/json" \\
      -d "{
        \\"event_type\\": \\"task_spawned\\",
        \\"entity_id\\": \\"$(uuidgen)\\",
        \\"predecessor_hash\\": \\"$PLAN_HASH\\",
        \\"payload\\": {\\"task\\": \\"test\\"}
      }" | jq .

  期望：
    • HTTP 200，occ_result: "won"
    • psql 查询 execution_event_log 中：
        第2行的 predecessor_hash = 第1行的 version_hash（hash chain 连通）
`,
      },
      {
        id: 'C',
        name: '读取 Scope 状态',
        description: `
  运行：
    curl -s "${GW}/v1/scopes/$SCOPE_ID" | jq .

  期望：
    • HTTP 200
    • 响应包含 scope_id, event_count: 2, latest_version_hash
`,
      },
      {
        id: 'D',
        name: 'Zod 验证拒绝无效请求',
        description: `
  运行：
    curl -s -X POST "${GW}/v1/scopes/not-a-uuid/events" \\
      -H "Content-Type: application/json" \\
      -d '{"event_type":"task_spawned","entity_id":"bad","predecessor_hash":"bad","payload":{}}' | jq .

  期望：
    • HTTP 400，响应包含 error 字段
    • Gateway 日志中无 event.written（证明未访问 DB）
`,
      },
      {
        id: 'E',
        name: 'OCC 并发冲突（同一 predecessor_hash 两次写入）',
        description: `
  运行（两次使用相同的 PLAN_HASH）：
    curl -s -X POST "${GW}/v1/scopes/$SCOPE_ID/events" \\
      -H "Content-Type: application/json" \\
      -d "{\\"event_type\\":\\"memory_updated\\",\\"entity_id\\":\\"$(uuidgen)\\",\\"predecessor_hash\\":\\"$PLAN_HASH\\",\\"payload\\":{\\"note\\":\\"A\\"}}" | jq .occ_result

    curl -s -X POST "${GW}/v1/scopes/$SCOPE_ID/events" \\
      -H "Content-Type: application/json" \\
      -d "{\\"event_type\\":\\"memory_updated\\",\\"entity_id\\":\\"$(uuidgen)\\",\\"predecessor_hash\\":\\"$PLAN_HASH\\",\\"payload\\":{\\"note\\":\\"B\\"}}" | jq .occ_result

  期望：
    • 第1次：occ_result: "won"
    • 第2次：occ_result: "demoted"（不是报错，正常 200）
`,
      },
    ],
  },
};

interface Gate {
  name: string;
  phase: string;
  setup_instructions: string;
  scenarios: Array<{ id: string; name: string; description: string }>;
}

// ─── CLI helpers ──────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function hr(char = '─', len = 60) {
  return char.repeat(len);
}

function statusLabel(s: 'pass' | 'fail' | 'skip'): string {
  return s === 'pass' ? '✓ PASS' : s === 'fail' ? '✗ FAIL' : '- SKIP';
}

async function promptStatus(label: string): Promise<'pass' | 'fail' | 'skip'> {
  while (true) {
    const raw = await ask(`\n  ${label} — 结果？[p=pass / f=fail / s=skip]: `);
    if (raw === 'p') return 'pass';
    if (raw === 'f') return 'fail';
    if (raw === 's') return 'skip';
    console.log('  请输入 p、f 或 s');
  }
}

async function promptMultiline(label: string): Promise<string> {
  console.log(`\n  ${label}`);
  console.log('  （输入完毕后按 Enter，然后输入空行结束）');
  const lines: string[] = [];
  while (true) {
    const line = await ask('  > ');
    if (line === '') break;
    lines.push(line);
  }
  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const gateNum = parseInt(process.argv[2] ?? '1', 10);
  const gate = GATES[gateNum];

  if (!gate) {
    console.error(`Gate ${gateNum} 未定义。可用: ${Object.keys(GATES).join(', ')}`);
    process.exit(1);
  }

  console.log('\n' + hr('━'));
  console.log(` Graph-Native Agent Runtime — ${gate.name}`);
  console.log(hr('━'));
  console.log('\n  本工具会引导你逐步完成每个 Scenario，');
  console.log('  记录 pass/fail 状态和观察，并生成结构化 feedback log。\n');

  // ── Setup check ──
  console.log(hr());
  console.log(' SETUP 检查\n');
  console.log(gate.setup_instructions);

  const setupStatus = await promptStatus('所有环境和进程');
  const setupNotes =
    setupStatus !== 'pass'
      ? await promptMultiline('描述问题（哪一步卡住了？）')
      : '';

  if (setupStatus === 'fail') {
    console.log('\n  Setup 失败 — 请先解决环境问题再运行 demo。');
    console.log('  参考: .planning/TESTING-PLAN.md §1.1 和 §1.2\n');
    rl.close();
    process.exit(0);
  }

  // ── Scenarios ──
  const results: ScenarioResult[] = [];

  for (const scenario of gate.scenarios) {
    console.log('\n' + hr());
    console.log(` Scenario ${scenario.id}: ${scenario.name}\n`);
    console.log(scenario.description);

    const status = await promptStatus(`Scenario ${scenario.id}`);
    const observations =
      status !== 'skip'
        ? await promptMultiline('观察到了什么？（HTTP 响应、pino 输出片段、错误信息）')
        : '';
    const pinoSample =
      status === 'fail'
        ? await promptMultiline('粘贴相关 pino 日志行（可选，直接 Enter 跳过）')
        : '';

    results.push({
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      status,
      observations,
      pino_log_sample: pinoSample,
    });

    console.log(`  → ${statusLabel(status)}`);
  }

  // ── Summary ──
  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const skipCount = results.filter((r) => r.status === 'skip').length;

  console.log('\n' + hr());
  console.log(' 结果汇总\n');
  for (const r of results) {
    console.log(`  Scenario ${r.id} (${r.name}): ${statusLabel(r.status)}`);
  }

  const gateResult: FeedbackLog['gate_result'] =
    failCount === 0 && skipCount === 0
      ? 'pass'
      : failCount > 0 && passCount === 0
        ? 'fail'
        : 'partial';

  console.log(`\n  Gate 结果: ${gateResult.toUpperCase()} (${passCount} pass, ${failCount} fail, ${skipCount} skip)\n`);

  const freeFeedback = await promptMultiline(
    '关于这个阶段的整体反馈（Phase 2 应该优先什么？有什么出乎意料的？）',
  );

  // ── Write output ──
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const log: FeedbackLog = {
    schema_version: '1.0',
    gate: `gate-${gateNum}`,
    phase: gate.phase,
    run_at: now.toISOString(),
    environment: {
      node_version: process.version,
      platform: os.platform(),
    },
    setup_status: setupStatus,
    setup_notes: setupNotes,
    scenarios: results,
    gate_result: gateResult,
    pass_count: passCount,
    fail_count: failCount,
    skip_count: skipCount,
    free_feedback: freeFeedback,
  };

  const outDir = path.join(process.cwd(), 'feedback');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, `gate-${gateNum}-${dateStr}.json`);
  fs.writeFileSync(outFile, JSON.stringify(log, null, 2), 'utf-8');

  console.log('\n' + hr('━'));
  console.log(` Feedback log 已写入: feedback/gate-${gateNum}-${dateStr}.json`);
  console.log(hr('━'));
  console.log('\n  下一步：运行分析器生成 Phase 调整建议');
  console.log(`  npx tsx scripts/analyze-feedback.ts ${gateNum}\n`);

  rl.close();
}

main().catch((err) => {
  console.error('Demo runner 出错:', err);
  process.exit(1);
});
