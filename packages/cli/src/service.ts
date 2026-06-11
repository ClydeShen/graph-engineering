/**
 * memex service — system service file generators (Phase 15 G6).
 *
 * Generators only: the CLI writes the file and prints the registration
 * command for the user to run with their own privileges. memex never
 * escalates (no silent sudo / admin elevation).
 */

export interface ServiceOpts {
  /** Absolute path to the node binary. */
  nodeBin: string;
  /** Absolute path to the repo root (working directory). */
  repoDir: string;
  /** DATABASE_URL for the service environment. */
  databaseUrl: string;
  /** Optional MEMEX_PROFILE for the service environment. */
  profile?: string;
}

const GATEWAY_ARGS = '--import tsx/esm packages/gateway/src/index.ts';
const WORKERS_ARGS = '--import tsx/esm packages/workers/src/index.ts';

export function systemdUnit(opts: ServiceOpts, component: 'gateway' | 'workers'): string {
  const args = component === 'gateway' ? GATEWAY_ARGS : WORKERS_ARGS;
  const profileLine = opts.profile ? `Environment=MEMEX_PROFILE=${opts.profile}\n` : '';
  return `[Unit]
Description=MemexOS ${component}
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=${opts.repoDir}
ExecStart=${opts.nodeBin} ${args}
Environment=DATABASE_URL=${opts.databaseUrl}
${profileLine}Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(opts: ServiceOpts, component: 'gateway' | 'workers'): string {
  const args = (component === 'gateway' ? GATEWAY_ARGS : WORKERS_ARGS).split(' ');
  const argEntries = [opts.nodeBin, ...args].map((a) => `      <string>${a}</string>`).join('\n');
  const profileEntry = opts.profile
    ? `      <key>MEMEX_PROFILE</key>\n      <string>${opts.profile}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>io.memex.${component}</string>
    <key>ProgramArguments</key>
    <array>
${argEntries}
    </array>
    <key>WorkingDirectory</key>
    <string>${opts.repoDir}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>DATABASE_URL</key>
      <string>${opts.databaseUrl}</string>
${profileEntry}    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

/** Windows: a `schtasks /create` command line (ONSTART trigger). */
export function scheduledTaskCommand(opts: ServiceOpts, component: 'gateway' | 'workers'): string {
  const args = component === 'gateway' ? GATEWAY_ARGS : WORKERS_ARGS;
  const envPrefix = opts.profile
    ? `set MEMEX_PROFILE=${opts.profile}&& set DATABASE_URL=${opts.databaseUrl}&& `
    : `set DATABASE_URL=${opts.databaseUrl}&& `;
  const inner = `cd /d ${opts.repoDir} && ${envPrefix}\\"${opts.nodeBin}\\" ${args}`;
  return `schtasks /create /tn "MemexOS ${component}" /sc onstart /tr "cmd /c \\"${inner}\\"" /rl limited /f`;
}

export interface GeneratedService {
  filename: string;
  content: string;
  /** What the user must run to register it — memex never self-elevates. */
  instructions: string;
}

export function generateServiceFiles(
  platform: NodeJS.Platform,
  opts: ServiceOpts,
): GeneratedService[] {
  const components: Array<'gateway' | 'workers'> = ['gateway', 'workers'];
  if (platform === 'linux') {
    return components.map((c) => ({
      filename: `memex-${c}.service`,
      content: systemdUnit(opts, c),
      instructions: `cp memex-${c}.service ~/.config/systemd/user/ && systemctl --user enable --now memex-${c}`,
    }));
  }
  if (platform === 'darwin') {
    return components.map((c) => ({
      filename: `io.memex.${c}.plist`,
      content: launchdPlist(opts, c),
      instructions: `cp io.memex.${c}.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/io.memex.${c}.plist`,
    }));
  }
  // win32 and anything else: emit the schtasks command as a .cmd the user reviews and runs.
  return components.map((c) => ({
    filename: `register-memex-${c}.cmd`,
    content: scheduledTaskCommand(opts, c) + '\r\n',
    instructions: `review then run register-memex-${c}.cmd from an elevated prompt if system-wide, or a normal prompt for per-user`,
  }));
}
