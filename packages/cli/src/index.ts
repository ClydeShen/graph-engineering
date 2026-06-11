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

Options:
  --help, -h    Show this help message

Agents (connect):
  claude-code   Claude Code (MCP) — patches ~/.claude.json
  pi            Pi Terminal (extension) — installs into ~/.pi/agent/extensions/
`);
  process.exit(0);
}

const subcommand = process.argv[2] === 'onboard' ? 'onboard' : 'connect';

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

const entry = subcommand === 'onboard' ? runOnboard() : main();
entry.catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
