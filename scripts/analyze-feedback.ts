/**
 * Feedback Log Analyzer
 *
 * Reads all feedback/gate-N-*.json files for a given gate,
 * aggregates results, and writes feedback/ANALYSIS-gate-N.md
 * with blockers, risks, and Phase N+1 adjustment signals.
 *
 * Usage: npx tsx scripts/analyze-feedback.ts [gate-number]
 * Default gate: 1
 *
 * Output: feedback/ANALYSIS-gate-N.md
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScenarioResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  observations: string;
  pino_log_sample: string;
}

interface FeedbackLog {
  schema_version: '1.0';
  gate: string;
  phase: string;
  run_at: string;
  environment: { node_version: string; platform: string };
  setup_status: 'pass' | 'fail' | 'skip';
  setup_notes: string;
  scenarios: ScenarioResult[];
  gate_result: 'pass' | 'fail' | 'partial';
  pass_count: number;
  fail_count: number;
  skip_count: number;
  free_feedback: string;
}

// ─── Analysis logic ───────────────────────────────────────────────────────────

const NEXT_PHASE: Record<string, string> = {
  '01-core-graph-engine': 'Phase 2 (Agent Integration)',
};

// Keywords that indicate a blocker (case-insensitive)
const BLOCKER_KEYWORDS = [
  'cannot connect',
  'connection refused',
  'econnrefused',
  'error',
  'failed',
  'crash',
  'timeout',
  'FATAL',
  '500',
  'unhandled',
  'exception',
  '找不到',
  '无法连接',
  '失败',
  '崩溃',
];

// Keywords that indicate a risk worth noting
const RISK_KEYWORDS = [
  'slow',
  'slow',
  'unexpected',
  'weird',
  'wrong',
  '慢',
  '奇怪',
  '意外',
  '不对',
  'warn',
  'warning',
];

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function extractSignals(observations: string, pinoLog: string): string[] {
  const signals: string[] = [];
  const combined = `${observations}\n${pinoLog}`.toLowerCase();

  if (combined.includes('occ') || combined.includes('conflict') || combined.includes('demoted')) {
    signals.push('OCC 冲突路径已验证');
  }
  if (combined.includes('hash') || combined.includes('version_hash') || combined.includes('plan_hash')) {
    signals.push('Hash chain 连通性验证');
  }
  if (combined.includes('scope.created') || combined.includes('scope_id')) {
    signals.push('Scope 创建路径正常');
  }
  if (combined.includes('400') || combined.includes('zod') || combined.includes('validation')) {
    signals.push('Zod 校验拒绝无效输入');
  }
  if (combined.includes('pulse') || combined.includes('replay')) {
    signals.push('Control Plane pulse-fetch 正常');
  }

  return signals;
}

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport(gateNum: number, logs: FeedbackLog[]): string {
  const gateKey = `gate-${gateNum}`;
  const phase = logs[0]?.phase ?? 'unknown';
  const nextPhase = NEXT_PHASE[phase] ?? `Phase ${gateNum + 1}`;
  const runCount = logs.length;
  const totalPasses = logs.reduce((n, l) => n + l.pass_count, 0);
  const totalFails = logs.reduce((n, l) => n + l.fail_count, 0);
  const overallPassed = logs.filter((l) => l.gate_result === 'pass').length;

  // Collect all failed scenarios across all runs
  const failedScenarios = logs.flatMap((log) =>
    log.scenarios
      .filter((s) => s.status === 'fail')
      .map((s) => ({ ...s, run_at: log.run_at })),
  );

  // Setup failures
  const setupFailures = logs.filter((l) => l.setup_status === 'fail');

  // Unique signals extracted from observations
  const allSignals = new Set<string>();
  logs.forEach((log) => {
    log.scenarios.forEach((s) => {
      extractSignals(s.observations, s.pino_log_sample).forEach((sig) => allSignals.add(sig));
    });
  });

  // Free feedback collected
  const freeFeedbacks = logs
    .map((l) => l.free_feedback)
    .filter((f) => f.trim().length > 0);

  // Classify blockers vs risks
  const blockers: string[] = [];
  const risks: string[] = [];

  failedScenarios.forEach((s) => {
    const text = `${s.observations} ${s.pino_log_sample}`;
    const desc = `Scenario ${s.id} (${s.name})`;
    if (hasKeyword(text, BLOCKER_KEYWORDS) || text.trim().length === 0) {
      blockers.push(`${desc}: ${s.observations.split('\n')[0] || '无观察记录'}`);
    } else if (hasKeyword(text, RISK_KEYWORDS)) {
      risks.push(`${desc}: ${s.observations.split('\n')[0]}`);
    } else {
      blockers.push(`${desc}: ${s.observations.split('\n')[0] || '无观察记录'}`);
    }
  });

  if (setupFailures.length > 0) {
    blockers.unshift(
      `Setup 失败 (${setupFailures.length} 次运行): ${setupFailures[0]?.setup_notes?.split('\n')[0] ?? '无详情'}`,
    );
  }

  // Phase adjustment signals
  const adjustmentSignals: string[] = [];

  if (failedScenarios.some((s) => s.id === 'E')) {
    adjustmentSignals.push('OCC 冲突处理 — ConflictResolver Phase 2 需要 LLM-assisted merge，优先级提升');
  }
  if (failedScenarios.some((s) => s.id === 'B')) {
    adjustmentSignals.push('Hash chain 连通性失败 — Phase 2 前需要修复 version_hash 计算路径');
  }
  if (failedScenarios.some((s) => s.id === 'A')) {
    adjustmentSignals.push('Scope 创建阻断 — Phase 2 规划需推迟直到 Gate 1 完全通过');
  }
  if (failedScenarios.some((s) => s.id === 'D')) {
    adjustmentSignals.push('Zod 验证边界 — Phase 2 增加更多 API 端点时需要加强 schema 验证');
  }
  if (overallPassed === runCount && runCount > 0) {
    adjustmentSignals.push('Gate 1 全部通过 — 可以开始 Phase 2 planning（Agent Integration + 真实 LLM 调用）');
    adjustmentSignals.push('Phase 2 优先级：ContextAssembly Worker 真实调用 > ConflictResolver LLM merge > MCP adapter');
  }

  // Free feedback signals
  freeFeedbacks.forEach((fb) => {
    if (fb.trim()) {
      adjustmentSignals.push(`[用户反馈] ${fb.split('\n')[0]}`);
    }
  });

  // Build markdown
  const lines: string[] = [];

  lines.push(`# Gate ${gateNum} Feedback Analysis`);
  lines.push('');
  lines.push(`> 自动生成于 ${new Date().toISOString()} | 运行次数: ${runCount}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 概览');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|----|`);
  lines.push(`| Gate | ${gateKey} |`);
  lines.push(`| Phase | ${phase} |`);
  lines.push(`| 运行次数 | ${runCount} |`);
  lines.push(`| Gate 通过次数 | ${overallPassed} / ${runCount} |`);
  lines.push(`| 总 Scenario Pass | ${totalPasses} |`);
  lines.push(`| 总 Scenario Fail | ${totalFails} |`);
  lines.push(`| 整体状态 | ${overallPassed === runCount && runCount > 0 ? '✓ PASSED' : overallPassed > 0 ? '⚠ PARTIAL' : '✗ FAILED'} |`);
  lines.push('');

  // Per-scenario summary
  lines.push('## Scenario 结果汇总');
  lines.push('');

  // Collect scenario stats
  const scenarioIds = [...new Set(logs.flatMap((l) => l.scenarios.map((s) => s.id)))].sort();
  lines.push('| Scenario | 名称 | Pass | Fail | Skip |');
  lines.push('|----------|------|------|------|------|');
  for (const id of scenarioIds) {
    const allForId = logs.flatMap((l) => l.scenarios.filter((s) => s.id === id));
    const p = allForId.filter((s) => s.status === 'pass').length;
    const f = allForId.filter((s) => s.status === 'fail').length;
    const sk = allForId.filter((s) => s.status === 'skip').length;
    const name = allForId[0]?.name ?? '—';
    lines.push(`| ${id} | ${name} | ${p} | ${f} | ${sk} |`);
  }
  lines.push('');

  // Blockers
  if (blockers.length > 0) {
    lines.push('## 阻断项（必须修复后才能推进）');
    lines.push('');
    blockers.forEach((b) => lines.push(`- **[BLOCKER]** ${b}`));
    lines.push('');
  } else {
    lines.push('## 阻断项');
    lines.push('');
    lines.push('无阻断项。');
    lines.push('');
  }

  // Risks
  if (risks.length > 0) {
    lines.push('## 风险项（需要关注）');
    lines.push('');
    risks.forEach((r) => lines.push(`- **[RISK]** ${r}`));
    lines.push('');
  }

  // Verified signals
  if (allSignals.size > 0) {
    lines.push('## 已验证信号');
    lines.push('');
    [...allSignals].forEach((s) => lines.push(`- ✓ ${s}`));
    lines.push('');
  }

  // Phase adjustment
  lines.push(`## ${nextPhase} 调整建议`);
  lines.push('');
  if (adjustmentSignals.length > 0) {
    adjustmentSignals.forEach((s) => lines.push(`- ${s}`));
  } else {
    lines.push('- 无特殊调整信号，按原 Phase 2 计划推进');
  }
  lines.push('');

  // Free feedback
  if (freeFeedbacks.length > 0) {
    lines.push('## 用户原文反馈');
    lines.push('');
    freeFeedbacks.forEach((fb, i) => {
      lines.push(`### Run ${i + 1} (${logs[i]?.run_at ?? ''})`);
      lines.push('');
      lines.push('```');
      lines.push(fb);
      lines.push('```');
      lines.push('');
    });
  }

  // Failed scenario details
  if (failedScenarios.length > 0) {
    lines.push('## 失败 Scenario 详情');
    lines.push('');
    failedScenarios.forEach((s) => {
      lines.push(`### Scenario ${s.id}: ${s.name}`);
      lines.push(`**时间:** ${s.run_at}`);
      lines.push('');
      if (s.observations.trim()) {
        lines.push('**观察:**');
        lines.push('```');
        lines.push(s.observations);
        lines.push('```');
        lines.push('');
      }
      if (s.pino_log_sample.trim()) {
        lines.push('**pino 日志片段:**');
        lines.push('```json');
        lines.push(s.pino_log_sample);
        lines.push('```');
        lines.push('');
      }
    });
  }

  lines.push('---');
  lines.push(`*generated by scripts/analyze-feedback.ts · ${new Date().toISOString()}*`);

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const gateNum = parseInt(process.argv[2] ?? '1', 10);
  const feedbackDir = path.join(process.cwd(), 'feedback');

  if (!fs.existsSync(feedbackDir)) {
    console.error(`feedback/ 目录不存在。先运行: npx tsx scripts/demo-runner.ts ${gateNum}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(feedbackDir)
    .filter((f) => f.startsWith(`gate-${gateNum}-`) && f.endsWith('.json'))
    .map((f) => path.join(feedbackDir, f));

  if (files.length === 0) {
    console.error(`没有找到 gate-${gateNum}-*.json 文件。`);
    console.error(`先运行: npx tsx scripts/demo-runner.ts ${gateNum}`);
    process.exit(1);
  }

  console.log(`\n分析 ${files.length} 个 feedback 文件 (gate-${gateNum})...\n`);

  const logs: FeedbackLog[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      logs.push(JSON.parse(raw) as FeedbackLog);
      console.log(`  ✓ ${path.basename(file)}`);
    } catch (err) {
      console.warn(`  ✗ ${path.basename(file)}: 解析失败 — ${err}`);
    }
  }

  if (logs.length === 0) {
    console.error('所有文件解析失败，无法生成分析。');
    process.exit(1);
  }

  const report = buildReport(gateNum, logs);

  const outFile = path.join(feedbackDir, `ANALYSIS-gate-${gateNum}.md`);
  fs.writeFileSync(outFile, report, 'utf-8');

  console.log(`\n分析报告已写入: feedback/ANALYSIS-gate-${gateNum}.md`);
  console.log('\n预览:');
  console.log('─'.repeat(60));

  // Print first 40 lines of the report as preview
  const lines = report.split('\n');
  console.log(lines.slice(0, 40).join('\n'));
  if (lines.length > 40) console.log(`\n... (${lines.length - 40} 行更多内容，查看完整文件)`);
  console.log('─'.repeat(60));
}

main();
