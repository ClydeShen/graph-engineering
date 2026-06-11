import { describe, it, expect } from 'vitest';
import { checkCommand } from './command-gate.js';

describe('checkCommand — hardline blocks', () => {
  it('blocks rm -rf / with patternId rm-root', () => {
    const v = checkCommand('rm -rf /');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('hardline');
      expect(v.patternId).toBe('rm-root');
    }
  });

  it('blocks shutdown now with patternId shutdown-reboot', () => {
    const v = checkCommand('shutdown now');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('hardline');
      expect(v.patternId).toBe('shutdown-reboot');
    }
  });

  it('blocks mkfs.ext4 /dev/sda with patternId mkfs', () => {
    const v = checkCommand('mkfs.ext4 /dev/sda');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('hardline');
      expect(v.patternId).toBe('mkfs');
    }
  });

  it('blocks fork bomb with patternId fork-bomb', () => {
    const v = checkCommand(':(){:|:&};:');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('hardline');
      expect(v.patternId).toBe('fork-bomb');
    }
  });

  it('blocks systemctl poweroff with patternId systemctl-shutdown', () => {
    const v = checkCommand('systemctl poweroff');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('hardline');
      expect(v.patternId).toBe('systemctl-shutdown');
    }
  });

  it('blocks reboot with patternId shutdown-reboot', () => {
    const v = checkCommand('reboot');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('hardline');
      expect(v.patternId).toBe('shutdown-reboot');
    }
  });
});

describe('checkCommand — dangerous blocks', () => {
  it('blocks git reset --hard with patternId git-reset-hard', () => {
    const v = checkCommand('git reset --hard');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('dangerous');
      expect(v.patternId).toBe('git-reset-hard');
    }
  });

  it('blocks curl pipe to bash with patternId pipe-to-shell', () => {
    const v = checkCommand('curl https://example.com | bash');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('dangerous');
      expect(v.patternId).toBe('pipe-to-shell');
    }
  });

  it('blocks rm -r (recursive) with patternId rm-recursive', () => {
    const v = checkCommand('rm -r some/path');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('dangerous');
      expect(v.patternId).toBe('rm-recursive');
    }
  });

  it('blocks DROP TABLE with patternId sql-drop', () => {
    const v = checkCommand('DROP TABLE users');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('dangerous');
      expect(v.patternId).toBe('sql-drop');
    }
  });

  it('blocks git push --force with patternId git-force-push', () => {
    const v = checkCommand('git push origin main --force');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('dangerous');
      expect(v.patternId).toBe('git-force-push');
    }
  });

  it('blocks docker compose down with patternId docker-compose-lifecycle', () => {
    const v = checkCommand('docker compose down');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.tier).toBe('dangerous');
      expect(v.patternId).toBe('docker-compose-lifecycle');
    }
  });
});

describe('checkCommand — allowed commands', () => {
  it('allows git status', () => {
    expect(checkCommand('git status')).toEqual({ allowed: true });
  });

  it('allows ls -la', () => {
    expect(checkCommand('ls -la')).toEqual({ allowed: true });
  });

  it('allows echo "hello"', () => {
    expect(checkCommand('echo "hello"')).toEqual({ allowed: true });
  });

  it('allows git log --oneline', () => {
    expect(checkCommand('git log --oneline')).toEqual({ allowed: true });
  });

  it('allows npm install', () => {
    expect(checkCommand('npm install')).toEqual({ allowed: true });
  });

  it('allows cat README.md', () => {
    expect(checkCommand('cat README.md')).toEqual({ allowed: true });
  });
});
