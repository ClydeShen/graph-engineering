/**
 * WSL2 first-class support helpers (Phase 18 deliverable #2, ADR-48 WSL2
 * appendix). Pure detection + command selection; injectable fs/spawn for tests.
 */

import { existsSync, readFileSync } from 'node:fs';

/** WSL detection: /proc/version contains "microsoft" (case-insensitive). */
export function isWsl(
  readFile: (p: string) => string = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  },
): boolean {
  if (process.platform !== 'linux') return false;
  return readFile('/proc/version').toLowerCase().includes('microsoft');
}

/** systemd enabled? (WSL2 ships with it off unless /etc/wsl.conf enables it). */
export function hasSystemd(exists: (p: string) => boolean = existsSync): boolean {
  return exists('/run/systemd/system');
}

/** Guidance printed instead of failing when systemd is off under WSL. */
export const WSL_SYSTEMD_HINT = `systemd is not enabled in this WSL distro.
Enable it, then restart WSL:
  printf '[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf
  # from Windows: wsl --shutdown
Until then, start services manually: npm run dev (or memex service for the files).`;

/**
 * Browser-open command for a URL. WSL2 localhost forwarding lets the Windows
 * browser reach localhost:<port> directly; prefer wslview (wslu), fall back to
 * explorer.exe, then the platform defaults.
 */
export function browserOpenCommand(
  url: string,
  opts: { wsl?: boolean; platform?: NodeJS.Platform; hasBin?: (bin: string) => boolean } = {},
): { command: string; args: string[] } {
  const platform = opts.platform ?? process.platform;
  const wsl = opts.wsl ?? isWsl();
  const hasBin = opts.hasBin ?? (() => false);
  if (wsl) {
    return hasBin('wslview')
      ? { command: 'wslview', args: [url] }
      : { command: 'explorer.exe', args: [url] };
  }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

/** Fire-and-forget browser open; never throws (headless = the caller prints the URL). */
export function openUrl(url: string): void {
  void import('node:child_process').then(({ spawn, execSync }) => {
    const hasBin = (bin: string): boolean => {
      try {
        execSync(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`, {
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    const { command, args } = browserOpenCommand(url, { hasBin });
    try {
      spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* URL already printed by callers */
    }
  });
}
