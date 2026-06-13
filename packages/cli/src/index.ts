#!/usr/bin/env node
import { intro, outro, multiselect, spinner, log } from '@clack/prompts';
import { loadDotenv } from '@graph/shared';
import { connectClaudeCode } from './connect/claude-code.js';
import { connectPi } from './connect/pi.js';
import { runOnboard } from './onboard.js';

// ADR 56 D-5: the CLI sees the same repo-root .env as dev.mjs (never overrides
// already-set process env — priority: env > .env > config.json).
loadDotenv();

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`memex <command>

Commands:
  onboard       First-run setup — writes ~/.memex/config.json (providers, gateway)
  chat          Open MemexTerminal — converse with the running gateway
                  -m "text" [--scope <id>]  non-interactive single turn (scriptable)
  log           Tail the dev-stack logs (iii/workers/control-plane/gateway)
                  -n <N> last N lines (default 200) · --no-follow print and exit
  connect       Connect coding agents to the Graph Runtime (default)
  doctor        Diagnose the installation (config, postgres, hash chain, providers)
  backup [dir]  pg_dump custom-format backup (default dir: ~/.memex/backups)
  restore <f>   pg_restore a backup, then re-verify the hash chain
  service       Generate system service files (systemd/launchd/schtasks)
  skills        search <q> | install <registry> <id> [name] [--scope global|profile] | inspect [name]
  mcp           catalog | install <name> | configure <name> | login <name> | list | uninstall <name>
  capability    list | bind <category> <impl> | install <preset>
  --version     Print the MemexOS version

Install (repo checkout): npm install && npm link --workspace packages/cli
  → makes the global \`memex\` command available

Options:
  --help, -h    Show this help message

Agents (connect):
  claude-code   Claude Code (MCP) — patches ~/.claude.json
  pi            Pi Terminal (extension) — installs into ~/.pi/agent/extensions/

Environment:
  MEMEX_PROFILE   Select ~/.memex/profiles/<name>/config.json instead of the default
`);
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  // Single version source: root package.json (ADR-48 / 16 G6).
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const rootPkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
  const { version } = JSON.parse(readFileSync(rootPkg, 'utf8')) as { version: string };
  console.log(`memex ${version}`);
  process.exit(0);
}

const KNOWN = ['onboard', 'chat', 'log', 'doctor', 'backup', 'restore', 'service', 'skills', 'mcp', 'capability', 'connect'] as const;
const requested = process.argv[2];
// Unknown subcommands error out instead of silently falling through to
// `connect` (P5: `memex chta` must not open the connect multiselect).
if (requested !== undefined && !requested.startsWith('-') && !(KNOWN as readonly string[]).includes(requested)) {
  console.error(`unknown command: ${requested}\nrun \`memex --help\` for the command list`);
  process.exit(1);
}
// Bare `memex` shows help instead of dropping into the connect wizard
// (UX-audit U3: surprising, and crashes under non-TTY stdin).
if (requested === undefined) {
  console.error('usage: memex <command>\nrun `memex --help` for the command list');
  process.exit(1);
}
const subcommand = (KNOWN as readonly string[]).includes(requested)
  ? (requested as (typeof KNOWN)[number])
  : 'connect';

async function resolveDbUrl(): Promise<string> {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'];
  const { loadMemexConfig } = await import('@graph/shared');
  const url = loadMemexConfig()?.database?.url;
  if (url) return url;
  throw new Error('DATABASE_URL not set and no database.url in the active profile config');
}

// pg_dump/pg_restore runner. ENOENT gets an actionable message instead of an
// empty stderr (UX-audit U5: dockerized postgres hosts often lack client tools).
async function makePgToolRunner(): Promise<{ exec(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> }> {
  const { execFile } = await import('node:child_process');
  return {
    exec: (cmd: string, args: string[]) =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(cmd, args, (err, _stdout, stderr) => {
          if (err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({
              code: 1,
              stderr: `${cmd} not found on PATH — install the PostgreSQL client tools, or run it inside your postgres container (docker exec <container> ${cmd} …)`,
            });
            return;
          }
          resolve({ code: err === null ? 0 : 1, stderr: String(stderr) });
        });
      }),
  };
}

async function runBackupCommand(): Promise<void> {
  const [{ runBackup }, { profileDir }, { mkdirSync }, { join }] = await Promise.all([
    import('./backup.js'),
    import('@graph/shared'),
    import('node:fs'),
    import('node:path'),
  ]);
  const runner = await makePgToolRunner();
  const outDir = process.argv[3] ?? join(profileDir(), 'backups');
  mkdirSync(outDir, { recursive: true });
  const { file } = await runBackup(runner, await resolveDbUrl(), outDir);
  console.log(`backup written: ${file}`);
  console.log('note: backups taken before an erase still contain the erased content');
  console.log('      (backup retention period = erase effectiveness delay, ADR-48)');
}

async function runRestoreCommand(): Promise<void> {
  const file = process.argv[3];
  if (!file) throw new Error('usage: memex restore <backup-file>');
  const [{ runRestore }, { checkHashChain, buildRealProbes }] = await Promise.all([
    import('./backup.js'),
    import('./doctor.js'),
  ]);
  const runner = await makePgToolRunner();
  const result = await runRestore(runner, await resolveDbUrl(), file, async () =>
    checkHashChain(await buildRealProbes()),
  );
  console.log(`restore complete; hash chain: ${result.chainStatus} — ${result.chainDetail}`);
  if (result.chainStatus === 'fail') process.exit(1);
}

async function runServiceCommand(): Promise<void> {
  const [{ generateServiceFiles }, { writeFileSync, mkdirSync }, { join, resolve }] =
    await Promise.all([import('./service.js'), import('node:fs'), import('node:path')]);
  const outDir = join(process.cwd(), 'service-files');
  mkdirSync(outDir, { recursive: true });
  const files = generateServiceFiles(process.platform, {
    nodeBin: process.execPath,
    repoDir: resolve(process.cwd()),
    databaseUrl: await resolveDbUrl(),
    ...(process.env['MEMEX_PROFILE'] ? { profile: process.env['MEMEX_PROFILE'] } : {}),
  });
  console.log('memex service — generated files (registration is yours to run):\n');
  for (const f of files) {
    writeFileSync(join(outDir, f.filename), f.content, 'utf8');
    console.log(`  ${join(outDir, f.filename)}`);
    console.log(`    → ${f.instructions}\n`);
  }
}

async function runDoctorCommand(): Promise<void> {
  const { runDoctor, buildRealProbes, formatDoctorReport } = await import('./doctor.js');
  const results = await runDoctor(await buildRealProbes());
  console.log('memex doctor\n');
  console.log(formatDoctorReport(results));
  process.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}

async function main() {
  intro('graph-runtime connect');

  const agents = await multiselect({
    message: 'Which agents to connect?',
    options: [
      { value: 'claude-code', label: 'Claude Code (MCP)' },
      { value: 'pi', label: 'Pi Terminal (extension)' },
    ],
  });

  if (!agents || (agents as string[]).length === 0) {
    outro('No agents selected. Exiting.');
    process.exit(0);
  }

  const selected = agents as string[];
  const s = spinner();

  if (selected.includes('claude-code')) {
    s.start('Connecting Claude Code…');
    const result = await connectClaudeCode({
      includeMcpServers: process.argv.includes('--include-mcp-servers'),
    });
    s.stop(`Claude Code: ${result.kind}${result.backup ? ` (backup: ${result.backup})` : ''}`);
    if (result.kind === 'already-wired') log.warn('Already wired — use --force to reinstall.');
    else log.success('Claude Code MCP wired to ~/.claude.json');
  }

  if (selected.includes('pi')) {
    s.start('Connecting Pi Terminal…');
    const result = await connectPi();
    s.stop(`Pi: ${result.kind}${result.note ? ` — ${result.note}` : ''}`);
    if (result.kind === 'no-pi') log.warn(result.note ?? 'Pi not found.');
    else if (result.kind === 'already-wired') log.warn('Already wired — use --force to reinstall.');
    else log.success(`Pi extension installed at ${result.extDir}`);
  }

  outro('Done.');
}

async function runSkillsCommand(): Promise<void> {
  const action = process.argv[3];
  // skills client + guard moved to @graph/shared in Phase 20 (gateway needs them too)
  const {
    searchSkills, installSkill, inspectSkills, skillsRootForScope, REGISTRIES,
    formatGuardReport, profileDir, memexHome,
  } = await import('@graph/shared');
  // --scope global|profile (Phase 19, ADR-52): default profile (== prior behavior)
  const scopeArgIdx = process.argv.indexOf('--scope');
  const scope = scopeArgIdx !== -1 && process.argv[scopeArgIdx + 1] === 'global' ? 'global' : 'profile';
  const skillsRoot = skillsRootForScope(scope, { memexHome: memexHome(), profileDir: profileDir() });

  if (action === 'search') {
    const query = process.argv.slice(4).join(' ');
    if (!query) throw new Error('usage: memex skills search <query>');
    const results = await searchSkills(fetch, query);
    if (results.length === 0) { console.log('no skills found'); return; }
    for (const r of results) console.log(`  [${r.registry}] ${r.id} — ${r.name}: ${r.description}`);
    return;
  }
  if (action === 'install') {
    const [, , , , regName, id, maybeName] = process.argv;
    const registry = REGISTRIES.find((r) => r.name === regName);
    if (!registry || !id) throw new Error(`usage: memex skills install <${REGISTRIES.map((r) => r.name).join('|')}> <id> [name]`);
    const name = maybeName ?? id;
    const confirmed = process.argv.includes('--yes-despite-findings');
    const outcome = await installSkill(fetch, registry, id, name, skillsRoot, confirmed);
    console.log(formatGuardReport(outcome.findings));
    if (!outcome.written) {
      console.log('\ninstall withheld — review the findings, then re-run with --yes-despite-findings to proceed');
      process.exit(1);
    }
    console.log(`installed: ${outcome.dir}`);
    return;
  }
  if (action === 'inspect') {
    const results = inspectSkills(skillsRoot, process.argv[4]);
    if (results.length === 0) { console.log(`no installed skills under ${skillsRoot}`); return; }
    for (const r of results) {
      console.log(`\n${r.name}:`);
      console.log(formatGuardReport(r.findings));
    }
    return;
  }
  throw new Error('usage: memex skills <search|install|inspect>');
}

// clack prompts crash under non-TTY stdin (uv_tty_init EBADF) — guard the
// interactive commands at dispatch (UX-audit U4); non-interactive boots read .env.
if ((subcommand === 'onboard' || subcommand === 'connect') && !process.stdin.isTTY) {
  console.error(`memex ${subcommand} is interactive and needs a TTY`);
  process.exit(1);
}

const entry =
  subcommand === 'onboard' ? runOnboard()
  // memex chat — MemexTerminal REPL (its module entry starts the session).
  : subcommand === 'chat' ? import('@graph/terminal').then(() => {})
  : subcommand === 'log' ? import('./log.js').then((m) => m.runLogCommand())
  : subcommand === 'doctor' ? runDoctorCommand()
  : subcommand === 'backup' ? runBackupCommand()
  : subcommand === 'restore' ? runRestoreCommand()
  : subcommand === 'service' ? runServiceCommand()
  : subcommand === 'skills' ? runSkillsCommand()
  : subcommand === 'mcp' ? import('./mcp.js').then((m) => m.runMcpCommand())
  : subcommand === 'capability' ? import('./capability.js').then((m) => m.runCapabilityCommand())
  : process.argv[2] === 'connect' && process.argv[3] === 'telegram'
    ? import('./connect/telegram.js').then((m) => m.runConnectTelegram())
  : main();
entry.catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
