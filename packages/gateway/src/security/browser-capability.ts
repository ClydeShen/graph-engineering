/**
 * Controlled browser capability (ADR-53 / Phase 20 #4).
 *
 * browser is a CATEGORY, not a tool: the worker-facing signature is fixed
 * (navigate / read / fill / click / screenshot); the implementation is
 * whatever the user bound via capability presets (ADR-51 bound_to chain).
 * The invariant is the isolation boundary, not the implementation choice:
 * every implementation runs inside the docker execution backend
 * (_BASE_SECURITY_ARGS parity) — host browsers are NEVER driven (host-level
 * computer use stays post-1.0).
 *
 * This module is the pure command mapper (unit-testable); execution reuses
 * buildDockerRunArgs from exec-backend.ts with network=bridge (a browser
 * without egress is a paperweight) + a browser-capable image.
 */

import { buildDockerRunArgs, type DockerExecOptions } from './exec-backend.js';

export type BrowserOp = 'navigate' | 'read' | 'fill' | 'click' | 'screenshot';

export interface BrowserCall {
  op: BrowserOp;
  url?: string;
  selector?: string;
  text?: string;
}

/** Per-implementation CLI mapping. agent-browser is the preset recommendation. */
const IMPL_COMMANDS: Record<string, (call: BrowserCall) => string | null> = {
  'agent-browser': (call) => {
    switch (call.op) {
      case 'navigate':
        return call.url ? `agent-browser open ${shellQuote(call.url)}` : null;
      case 'read':
        return 'agent-browser snapshot';
      case 'fill':
        return call.selector && call.text !== undefined
          ? `agent-browser fill ${shellQuote(call.selector)} ${shellQuote(call.text)}`
          : null;
      case 'click':
        return call.selector ? `agent-browser click ${shellQuote(call.selector)}` : null;
      case 'screenshot':
        return 'agent-browser screenshot /tmp/shot.png && base64 /tmp/shot.png';
    }
  },
};

/** POSIX single-quote escaping — the command runs via sh -lc in the container. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class UnknownBrowserImplError extends Error {
  constructor(impl: string) {
    super(
      `no command mapping for browser implementation '${impl}' — ` +
        `bind a supported one (memex capability bind browser agent-browser)`,
    );
  }
}

/** Map a worker-facing call to the bound implementation's CLI command. */
export function mapBrowserCall(implementation: string, call: BrowserCall): string {
  const mapper = IMPL_COMMANDS[implementation];
  if (!mapper) throw new UnknownBrowserImplError(implementation);
  const command = mapper(call);
  if (command === null) {
    throw new Error(`browser.${call.op} is missing required arguments`);
  }
  return command;
}

/**
 * Container args for a browser command: docker backend with egress (bridge),
 * writable /tmp for screenshots, browser-capable image. The session state
 * lives in the container volume only (ADR-53: login state never on the host).
 */
export function buildBrowserRunArgs(
  implementation: string,
  call: BrowserCall,
  opts: Pick<DockerExecOptions, 'image' | 'memoryLimit' | 'timeoutSeconds'> = {},
): string[] {
  const command = mapBrowserCall(implementation, call);
  return buildDockerRunArgs(command, {
    image: opts.image ?? process.env['MEMEX_BROWSER_IMAGE'] ?? 'memex-browser:latest',
    network: 'bridge', // browsers need egress; all other security args stay
    memoryLimit: opts.memoryLimit ?? '1g',
    ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
  });
}
