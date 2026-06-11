/**
 * memex backup / restore — pg_dump/pg_restore wrappers (Phase 15 G6).
 *
 * Backup is a custom-format dump (-Fc: compressed, pg_restore-selectable).
 * Restore runs --clean --if-exists, then re-verifies the hash chain via the
 * doctor check — a restore that breaks the ledger chain is reported loudly.
 *
 * Backup encryption is deliberately NOT implemented (ADR-57): with live-DB
 * erase implemented as payload blanking (ADR-47 D-1), backups taken BEFORE an
 * erase still contain the erased content until they age out. Documented
 * semantics: backup retention period = erase effectiveness delay.
 */

import { join } from 'node:path';

export interface CommandRunner {
  /** Resolve with the exit code; stderr collected for error reporting. */
  exec(cmd: string, args: string[]): Promise<{ code: number; stderr: string }>;
}

/** Timestamped dump filename: memex-YYYYMMDD-HHMMSS.dump */
export function backupFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `memex-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.dump`;
}

export function buildBackupArgs(dbUrl: string, outFile: string): string[] {
  return ['--format=custom', `--dbname=${dbUrl}`, `--file=${outFile}`];
}

export function buildRestoreArgs(dbUrl: string, inFile: string): string[] {
  return ['--clean', '--if-exists', `--dbname=${dbUrl}`, inFile];
}

export async function runBackup(
  runner: CommandRunner,
  dbUrl: string,
  outDir: string,
  now: Date = new Date(),
): Promise<{ file: string }> {
  const file = join(outDir, backupFilename(now));
  const { code, stderr } = await runner.exec('pg_dump', buildBackupArgs(dbUrl, file));
  if (code !== 0) throw new Error(`pg_dump failed (exit ${code}): ${stderr}`);
  return { file };
}

export async function runRestore(
  runner: CommandRunner,
  dbUrl: string,
  file: string,
  /** Post-restore integrity gate — doctor's hash-chain check, injected. */
  verifyChain: () => Promise<{ status: string; detail: string }>,
): Promise<{ chainStatus: string; chainDetail: string }> {
  const { code, stderr } = await runner.exec('pg_restore', buildRestoreArgs(dbUrl, file));
  if (code !== 0) throw new Error(`pg_restore failed (exit ${code}): ${stderr}`);
  const chain = await verifyChain();
  return { chainStatus: chain.status, chainDetail: chain.detail };
}
