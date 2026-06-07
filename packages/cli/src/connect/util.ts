import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${tmpdir()}/.graph-tmp-${process.pid}-${randomBytes(4).toString('hex')}.json`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path); // atomic on same filesystem
}

export function backupIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backup);
  return backup;
}
