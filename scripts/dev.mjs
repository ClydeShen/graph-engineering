/**
 * dev.mjs — start all services for local development.
 *
 * Usage: node scripts/dev.mjs   (or: npm run dev)
 *
 * Startup order: iii → (2s) → workers → (3s) → ctrl + gateway
 * Workers must register their functions with iii before the Control Plane
 * starts pulse-fetch, otherwise pulse-replay fires before handlers exist.
 */

import { spawn, spawnSync, execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Log sink (inspection hatch) ──────────────────────────────────────────────
// Everything printed to the terminal is also appended (ANSI-stripped) to
// ~/.memex/logs/dev.log so agents and post-mortems can read what happened
// without having owned the terminal. One file, append-only, per-boot header.
const logDir = join(homedir(), '.memex', 'logs');
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, 'dev.log');
const logSink = createWriteStream(logFile, { flags: 'a' });
logSink.write(`\n──── dev boot ${new Date().toISOString()} ────\n`);
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function sinkLine(line) {
  logSink.write(line.replace(ANSI_RE, '') + '\n');
}

// ── Load .env ─────────────────────────────────────────────────────────────────
const appEnv = { ...process.env };
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]\w*)=(.*)/);
    if (m) appEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ── Resolve bun — add ~/.bun/bin to PATH so cmd.exe finds it ─────────────────
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const bunBin = join(home, '.bun', 'bin');
const sep = process.platform === 'win32' ? ';' : ':';
if (!appEnv.PATH?.includes(bunBin)) {
  appEnv.PATH = bunBin + sep + (appEnv.PATH ?? '');
}

// ── Derive ports from env (never hardcode) ────────────────────────────────────
const iiiPort = Number((appEnv.III_URL ?? 'ws://localhost:4001').match(/:(\d+)$/)?.[1] ?? '4001');
const gatewayPort = Number(appEnv.PORT ?? 4000);

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  blue: '\x1b[94m', green: '\x1b[92m', yellow: '\x1b[93m',
  magenta: '\x1b[95m', cyan: '\x1b[96m', red: '\x1b[91m',
};

// ── Format one log line ───────────────────────────────────────────────────────
const PINO_LEVELS = { 10: 'TRC', 20: 'DBG', 30: 'INF', 40: 'WRN', 50: 'ERR', 60: 'FTL' };
const PINO_SKIP   = new Set(['level','time','pid','hostname','service','component','msg']);

function fmtLine(tag, color, raw) {
  const s = raw.trim();
  if (!s) return null;
  const label = `${color}[${tag}]${C.reset}`;
  try {
    const j = JSON.parse(s);
    const lvl  = PINO_LEVELS[j.level] ?? '   ';
    const lvlC = j.level >= 50 ? C.red : j.level >= 40 ? C.yellow : j.level < 30 ? C.dim : '';
    const comp = j.component ? `${C.dim}[${j.component}]${C.reset} ` : '';
    const extra = Object.entries(j)
      .filter(([k]) => !PINO_SKIP.has(k))
      .map(([k, v]) => `${C.dim}${k}=${typeof v === 'object' ? JSON.stringify(v) : v}${C.reset}`)
      .join(' ');
    return `${label} ${lvlC}${lvl}${C.reset} ${comp}${j.msg}${extra ? ' ' + extra : ''}`;
  } catch {
    return `${label} ${s}`;
  }
}

function attachLineBuffer(tag, color, stream) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    for (const line of parts) {
      const out = fmtLine(tag, color, line);
      if (out) { console.log(out); sinkLine(out); }
    }
  });
  stream.on('end', () => {
    if (buf.trim()) {
      const out = fmtLine(tag, color, buf);
      if (out) { console.log(out); sinkLine(out); }
    }
  });
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Kill any process occupying the given TCP port (Windows: netstat + taskkill)
function freePort(port) {
  try {
    const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] });
    const pids = new Set(
      out.split(/\r?\n/)
        .map(l => l.trim().split(/\s+/).pop())
        .filter(p => p && /^\d+$/.test(p) && p !== '0')
    );
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
    }
    if (pids.size) console.log(`${C.dim}  freed port ${port} (pid ${[...pids].join(',')})${C.reset}`);
  } catch {
    // port not in use — nothing to do
  }
}

function start({ tag, color, cmd, args, env, cwd }) {
  const proc = spawn(cmd, args, { env, shell: true, cwd: cwd ?? process.cwd() });
  attachLineBuffer(tag, color, proc.stdout);
  attachLineBuffer(tag, color, proc.stderr);
  proc.on('exit', (code) => {
    console.log(`${color}[${tag}]${C.reset} ${C.dim}process exited (${code ?? 'signal'})${C.reset}`);
  });
  return proc;
}

// ── Startup banner ────────────────────────────────────────────────────────────
console.log(`
${C.bold}${C.cyan}  Graph-Native Agent Runtime${C.reset}  ${C.dim}dev${C.reset}
  ${C.dim}────────────────────────────────────────${C.reset}
  ${C.dim}DB     ${C.reset} ${appEnv.DATABASE_URL ?? 'postgres://localhost:5432/graph_test'}
  ${C.dim}iii    ${C.reset} ${appEnv.III_URL ?? `ws://localhost:${iiiPort}`}
  ${C.dim}HTTP   ${C.reset} http://localhost:${gatewayPort}
  ${C.dim}────────────────────────────────────────${C.reset}
  ${C.dim}[iii    ]${C.reset} ${C.blue}iii engine${C.reset}      ${appEnv.III_URL ?? 'ws://localhost:4001'}
  ${C.dim}[ctrl   ]${C.reset} ${C.green}control plane${C.reset}   DDL · Pulse-Fetch · Watchdog
  ${C.dim}[workers]${C.reset} ${C.yellow}workers${C.reset}         Frontier · PatternDiscovery · Context
  ${C.dim}[gateway]${C.reset} ${C.magenta}gateway${C.reset}         http://localhost:${gatewayPort}
  ${C.dim}[console]${C.reset} ${C.cyan}console${C.reset}         http://localhost:3000
  ${C.dim}────────────────────────────────────────${C.reset}
`);

// ── Sequential startup ────────────────────────────────────────────────────────
// Order matters: iii first, then workers (register functions), then ctrl + gw.
// Control Plane's pulse-fetch replays DB events immediately on connect —
// workers must be registered before ctrl starts or pulse-replay hits function_not_found.

const procs = [];

// ── Onboarding gate (ADR 56 D-5) ─────────────────────────────────────────────
// First run with no ~/.memex/config.json: run the interactive onboarding TUI
// before booting services, so the stack starts with a real provider config.
function onboardingGate() {
  const profile = process.env.MEMEX_PROFILE;
  const configPath = profile && /^[A-Za-z0-9_-]+$/.test(profile)
    ? join(homedir(), '.memex', 'profiles', profile, 'config.json')
    : join(homedir(), '.memex', 'config.json');
  if (existsSync(configPath)) return;
  // Non-TTY (agent-driven / piped boot): the interactive wizard would hang —
  // print guidance and boot from env vars instead.
  if (!process.stdin.isTTY) {
    console.log(`${C.yellow}  No ${configPath} and no TTY — skipping onboarding (run: memex onboard). Booting from .env.${C.reset}\n`);
    return;
  }
  console.log(`${C.yellow}  No ${configPath} found — running onboarding first.${C.reset}\n`);
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', 'packages/cli/src/index.ts', 'onboard'],
    { stdio: 'inherit', env: appEnv, shell: false },
  );
  if (r.status !== 0 || !existsSync(configPath)) {
    console.log(`${C.yellow}  Onboarding incomplete — booting from env vars only (.env).${C.reset}\n`);
  }
}

async function boot() {
  onboardingGate();

  // 0. Free ports from any leftover processes (3000: a stale console would
  // make Next.js silently move to another port while the banner still says
  // 3000 — UX-audit U16)
  freePort(iiiPort);
  freePort(gatewayPort);
  freePort(3000);

  // 1. iii engine
  procs.push(start({
    tag: 'iii    ', color: C.blue,
    cmd: 'iii', args: ['-c', 'iii-config.yaml'],
    env: process.env,
  }));

  // 2. Workers — wait for iii to accept connections
  await wait(2000);
  procs.push(start({
    tag: 'workers', color: C.yellow,
    cmd: process.execPath, args: ['--import', 'tsx/esm', 'packages/workers/src/index.ts'],
    env: appEnv,
  }));

  // 3. Ctrl + Gateway — wait for workers to register their functions with iii
  await wait(3000);
  procs.push(start({
    tag: 'ctrl   ', color: C.green,
    cmd: process.execPath, args: ['--import', 'tsx/esm', 'packages/control-plane/src/index.ts'],
    env: appEnv,
  }));
  procs.push(start({
    tag: 'gateway', color: C.magenta,
    // TD-M (ADR-57): Node 22 single runtime — gateway no longer needs Bun.
    cmd: process.execPath, args: ['--import', 'tsx/esm', 'packages/gateway/src/index.ts'],
    env: appEnv,
  }));

  // 4. Console (Next.js) — starts alongside gateway.
  // PORT is scrubbed from the child env: Next.js honours PORT, and inheriting
  // the gateway's port made the console bind 4000 on another interface (N1).
  const consoleEnv = { ...appEnv, NEXT_PUBLIC_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` };
  delete consoleEnv.PORT;
  procs.push(start({
    tag: 'console', color: C.cyan,
    cmd: 'npm', args: ['run', 'dev'],
    env: consoleEnv,
    cwd: join(process.cwd(), 'packages', 'console'),
  }));
}

boot();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log(`\n${C.dim}  Ctrl+C — shutting down all services...${C.reset}`);
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
});
