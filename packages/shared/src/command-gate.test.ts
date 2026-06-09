import { describe, it, expect } from 'vitest';
import { checkCommand } from './command-gate.js';

describe('checkCommand — hardline blocks', () => {
  it('blocks rm -rf /', () => {
    const v = checkCommand('rm -rf /');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('hardline');
  });

  it('blocks shutdown now', () => {
    const v = checkCommand('shutdown now');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('hardline');
  });

  it('blocks mkfs.ext4 /dev/sda', () => {
    const v = checkCommand('mkfs.ext4 /dev/sda');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('hardline');
  });

  it('blocks fork bomb', () => {
    const v = checkCommand(':(){:|:&};:');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('hardline');
  });

  it('blocks systemctl poweroff', () => {
    const v = checkCommand('systemctl poweroff');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('hardline');
  });

  it('blocks reboot', () => {
    const v = checkCommand('reboot');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('hardline');
  });
});

describe('checkCommand — dangerous blocks', () => {
  it('blocks git reset --hard', () => {
    const v = checkCommand('git reset --hard');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('dangerous');
  });

  it('blocks curl pipe to bash', () => {
    const v = checkCommand('curl https://example.com | bash');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('dangerous');
  });

  it('blocks rm -r (recursive)', () => {
    const v = checkCommand('rm -r some/path');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('dangerous');
  });

  it('blocks DROP TABLE', () => {
    const v = checkCommand('DROP TABLE users');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('dangerous');
  });

  it('blocks git push --force', () => {
    const v = checkCommand('git push origin main --force');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('dangerous');
  });

  it('blocks docker compose down', () => {
    const v = checkCommand('docker compose down');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.tier).toBe('dangerous');
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
