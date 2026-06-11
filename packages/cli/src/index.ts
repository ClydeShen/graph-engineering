#!/usr/bin/env node
import { intro, outro, multiselect, spinner, log } from '@clack/prompts';
import { connectClaudeCode } from './connect/claude-code.js';
import { connectPi } from './connect/pi.js';
import { runOnboard } from './onboard.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`memex <command>

Commands:
  onboard       First-run setup — writes ~/.memex/config.json (providers, gateway)
  connect       Connect coding agents to the Graph Runtime (default)
  doctor        Diagnose the installation (config, postgres, hash chain, providers)
  backup [dir]  pg_dump custom-format backup (default dir: ~/.memex/backups)
  restore <f>   pg_restore a backup, then re-verify the hash chain
  service       Generate system service files (systemd/launchd/schtasks)

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

const KNOWN = ['onboard', 'doctor', 'backup', 'restore', 'service'] as const;
const subcommand = (KNOWN as readonly string[]).includes(process.argv[2] ?? '')
  ? (process.argv[2] as (typeof KNOWN)[number])
  : 'connect';

async function resolveDbUrl(): Promise<string> {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'];
  const { loadMemexConfig } = await import('@graph/shared');
  const url = loadMemexConfig()?.database?.url;
  if (url) return url;
  throw new Error('DATABASE_URL not set and no database.url in the active profile config');
}

async function runBackupCommand(): Promise<void> {
  const [{ runBackup }, { profileDir }, { mkdirSync }, { join }, { execFile }] = await Promise.all([
    import('./backup.js'),
    import('@graph/shared'),
    import('node:fs'),
    import('node:path'),
    import('node:child_process'),
  ]);
  const runner = {
    exec: (cmd: string, args: string[]) =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(cmd, args, (err, _stdout, stderr) => {
          resolve({ code: err === null ? 0 : 1, stderr: String(stderr) });
        });
      }),
  };
  const outDir = process.argv[3] ?? join(profileDir(), 'backups');
  mkdirSync(outDir, { recursive: true });
  const { file } = await runBackup(runner, await resolveDbUrl(), outDir);
  console.log(`backup written: ${file}`);
  console.log('note: backups taken before an erase still contain the erased content');
  console.log('      (backup retention period = erase effectiveness delay, ADR-57)');
}

async function runRestoreCommand(): Promise<void> {
  const file = process.argv[3];
  if (!file) throw new Error('usage: memex restore <backup-file>');
  const [{ runRestore }, { checkHashChain, buildRealProbes }, { execFile }] = await Promise.all([
    import('./backup.js'),
    import('./doctor.js'),
    import('node:child_process'),
  ]);
  const runner = {
    exec: (cmd: string, args: string[]) =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(cmd, args, (err, _stdout, stderr) => {
          resolve({ code: err === null ? 0 : 1, stderr: String(stderr) });
        });
      }),
  };
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
    const result = await connectClaudeCode();
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

const entry =
  subcommand === 'onboard' ? runOnboard()
  : subcommand === 'doctor' ? runDoctorCommand()
  : subcommand === 'backup' ? runBackupCommand()
  : subcommand === 'restore' ? runRestoreCommand()
  : subcommand === 'service' ? runServiceCommand()
  : main();
entry.catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
