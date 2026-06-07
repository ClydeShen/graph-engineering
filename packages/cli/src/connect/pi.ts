import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSafe, writeJsonAtomic, backupIfExists } from './util.js';

const PI_DIR = join(homedir(), '.pi');
const PI_SETTINGS = join(PI_DIR, 'agent', 'settings.json');
const PI_EXT_DIR = join(PI_DIR, 'agent', 'extensions', 'graph-runtime');
const EXT_ENTRY = './src/index.ts';

interface PiSettings {
  extensions?: string[];
  [key: string]: unknown;
}

function isAlreadyWired(settings: PiSettings | null): boolean {
  return settings?.extensions?.some(
    (e) => e.includes('graph-runtime'),
  ) ?? false;
}

export type PiResult = {
  kind: 'installed' | 'already-wired' | 'no-pi';
  extDir?: string;
  backup?: string | null;
  note?: string;
};

export async function connectPi(opts: { force?: boolean } = {}): Promise<PiResult> {
  if (!existsSync(PI_DIR)) {
    return { kind: 'no-pi', note: 'Pi not installed. Install Pi first: https://pi.dev' };
  }

  const existing = readJsonSafe<PiSettings>(PI_SETTINGS);
  if (isAlreadyWired(existing) && !opts.force) {
    return { kind: 'already-wired', extDir: PI_EXT_DIR, note: 'Use --force to reinstall.' };
  }

  // Create extension directory and copy source files from the monorepo package
  mkdirSync(join(PI_EXT_DIR, 'src'), { recursive: true });

  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../../../pi-extension/src');
  copyFileSync(join(srcDir, 'index.ts'), join(PI_EXT_DIR, 'src', 'index.ts'));
  copyFileSync(join(srcDir, 'pi-types.shim.ts'), join(PI_EXT_DIR, 'src', 'pi-types.shim.ts'));

  writeJsonAtomic(join(PI_EXT_DIR, 'package.json'), {
    name: '@graph/pi-extension',
    version: '0.1.0',
    private: true,
    pi: { extensions: [EXT_ENTRY] },
    dependencies: { '@earendil-works/pi-coding-agent': '*' },
  });

  const backup = backupIfExists(PI_SETTINGS);
  const settings: PiSettings = existing ?? {};
  settings.extensions = [
    ...(settings.extensions ?? []).filter((e) => !e.includes('graph-runtime')),
    PI_EXT_DIR,
  ];

  mkdirSync(dirname(PI_SETTINGS), { recursive: true });
  writeJsonAtomic(PI_SETTINGS, settings);

  // Post-write verification
  const verified = readJsonSafe<PiSettings>(PI_SETTINGS);
  if (!isAlreadyWired(verified)) {
    throw new Error('Post-write verification failed — settings.json does not contain graph-runtime');
  }

  return { kind: 'installed', extDir: PI_EXT_DIR, backup };
}
