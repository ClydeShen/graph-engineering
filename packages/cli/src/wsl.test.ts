import { describe, expect, it } from 'vitest';
import { browserOpenCommand, hasSystemd, isWsl } from './wsl.js';
import { checkWsl } from './doctor.js';

describe('isWsl', () => {
  it('reads /proc/version via the injected reader on linux, false elsewhere', () => {
    const result = isWsl(() => 'Linux version 5.15 microsoft-standard-WSL2');
    if (process.platform === 'linux') expect(result).toBe(true);
    else expect(result).toBe(false);
  });
});

describe('hasSystemd', () => {
  it('delegates to the injected existence check', () => {
    expect(hasSystemd(() => true)).toBe(true);
    expect(hasSystemd(() => false)).toBe(false);
  });
});

describe('browserOpenCommand', () => {
  it('wsl + wslview present → wslview', () => {
    expect(browserOpenCommand('http://x', { wsl: true, hasBin: (b) => b === 'wslview' })).toEqual({
      command: 'wslview',
      args: ['http://x'],
    });
  });

  it('wsl without wslview → explorer.exe', () => {
    expect(browserOpenCommand('http://x', { wsl: true, hasBin: () => false })).toEqual({
      command: 'explorer.exe',
      args: ['http://x'],
    });
  });

  it('win32 → cmd start, darwin → open, linux → xdg-open', () => {
    expect(browserOpenCommand('u', { wsl: false, platform: 'win32' }).command).toBe('cmd');
    expect(browserOpenCommand('u', { wsl: false, platform: 'darwin' }).command).toBe('open');
    expect(browserOpenCommand('u', { wsl: false, platform: 'linux' }).command).toBe('xdg-open');
  });
});

describe('doctor checkWsl', () => {
  it('skip when not WSL', () => {
    expect(checkWsl({ wsl: false, systemd: false, hasWslview: false, automountC: false }).status).toBe('skip');
  });

  it('warn when systemd off or /mnt/c mounted', () => {
    const noSystemd = checkWsl({ wsl: true, systemd: false, hasWslview: true, automountC: false });
    expect(noSystemd.status).toBe('warn');
    expect(noSystemd.detail).toContain('systemd');
    const automount = checkWsl({ wsl: true, systemd: true, hasWslview: true, automountC: true });
    expect(automount.status).toBe('warn');
    expect(automount.detail).toContain('/mnt/c');
  });

  it('ok on a fully provisioned WSL distro', () => {
    expect(checkWsl({ wsl: true, systemd: true, hasWslview: true, automountC: false }).status).toBe('ok');
  });
});
