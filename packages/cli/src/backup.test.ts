import { describe, it, expect, vi } from 'vitest';
import { backupFilename, buildBackupArgs, buildRestoreArgs, runBackup, runRestore } from './backup.js';
import { generateServiceFiles, systemdUnit, launchdPlist, scheduledTaskCommand } from './service.js';

const DB = 'postgres://u:p@localhost:5432/memex';

describe('memex backup / restore (Phase 15 G6)', () => {
  it('backupFilename is timestamped and sortable', () => {
    const f = backupFilename(new Date(2026, 5, 12, 3, 4, 5));
    expect(f).toBe('memex-20260612-030405.dump');
  });

  it('builds pg_dump custom-format args and pg_restore clean args', () => {
    expect(buildBackupArgs(DB, '/b/out.dump')).toEqual([
      '--format=custom',
      `--dbname=${DB}`,
      '--file=/b/out.dump',
    ]);
    expect(buildRestoreArgs(DB, '/b/out.dump')).toEqual([
      '--clean',
      '--if-exists',
      `--dbname=${DB}`,
      '/b/out.dump',
    ]);
  });

  it('runBackup invokes pg_dump and surfaces failures with stderr', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const { file } = await runBackup({ exec }, DB, '/backups', new Date(2026, 5, 12));
    expect(file).toContain('memex-20260612');
    expect(exec).toHaveBeenCalledWith('pg_dump', expect.arrayContaining(['--format=custom']));

    const failing = vi.fn().mockResolvedValue({ code: 1, stderr: 'connection refused' });
    await expect(runBackup({ exec: failing }, DB, '/backups')).rejects.toThrow('connection refused');
  });

  it('runRestore runs pg_restore then the injected hash-chain gate', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const verify = vi.fn().mockResolvedValue({ status: 'ok', detail: '3 scope(s) sampled' });
    const result = await runRestore({ exec }, DB, '/b/x.dump', verify);
    expect(exec).toHaveBeenCalledWith('pg_restore', expect.arrayContaining(['--clean']));
    expect(verify).toHaveBeenCalledOnce();
    expect(result.chainStatus).toBe('ok');
  });

  it('runRestore reports a broken chain from the gate without swallowing it', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const verify = vi.fn().mockResolvedValue({ status: 'fail', detail: 'dangling links' });
    const result = await runRestore({ exec }, DB, '/b/x.dump', verify);
    expect(result.chainStatus).toBe('fail');
    expect(result.chainDetail).toContain('dangling');
  });
});

describe('memex service generators (Phase 15 G6)', () => {
  const opts = {
    nodeBin: '/usr/bin/node',
    repoDir: '/opt/memex',
    databaseUrl: DB,
    profile: 'prod',
  };

  it('systemd unit carries ExecStart, env, and restart policy', () => {
    const unit = systemdUnit(opts, 'gateway');
    expect(unit).toContain('ExecStart=/usr/bin/node --import tsx/esm packages/gateway/src/index.ts');
    expect(unit).toContain(`Environment=DATABASE_URL=${DB}`);
    expect(unit).toContain('Environment=MEMEX_PROFILE=prod');
    expect(unit).toContain('Restart=on-failure');
  });

  it('launchd plist is well-formed and carries program args + env', () => {
    const plist = launchdPlist(opts, 'workers');
    expect(plist).toContain('<string>io.memex.workers</string>');
    expect(plist).toContain('<string>/usr/bin/node</string>');
    expect(plist).toContain('<string>packages/workers/src/index.ts</string>');
    expect(plist).toContain('<key>MEMEX_PROFILE</key>');
    // balanced dict tags (cheap well-formedness signal)
    expect((plist.match(/<dict>/g) ?? []).length).toBe((plist.match(/<\/dict>/g) ?? []).length);
  });

  it('scheduled task command targets ONSTART without elevation flags', () => {
    const cmd = scheduledTaskCommand(opts, 'gateway');
    expect(cmd).toContain('schtasks /create');
    expect(cmd).toContain('/sc onstart');
    expect(cmd).toContain('/rl limited'); // never silently elevated
    expect(cmd).toContain('MEMEX_PROFILE=prod');
  });

  it('generateServiceFiles emits per-platform files with user-run instructions', () => {
    for (const [platform, fileHint, instrHint] of [
      ['linux', 'memex-gateway.service', 'systemctl --user'],
      ['darwin', 'io.memex.gateway.plist', 'launchctl load'],
      ['win32', 'register-memex-gateway.cmd', 'review then run'],
    ] as const) {
      const files = generateServiceFiles(platform, opts);
      expect(files).toHaveLength(2); // gateway + workers
      expect(files[0]!.filename).toBe(fileHint);
      expect(files[0]!.instructions).toContain(instrHint);
    }
  });
});
