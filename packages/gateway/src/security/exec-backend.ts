/**
 * Execution backend abstraction (ADR-47 D-4).
 *
 * local  — current host execution (CommandGate + env filter, defense-in-depth)
 * docker — OS-level containment: hermes _BASE_SECURITY_ARGS replicated.
 *          In-container commands bypass PATTERN approval (destructive commands
 *          cannot reach the host) — the hardline blocklist still applies.
 *
 * buildDockerRunArgs is a pure function (unit-testable without docker).
 * Containers are labeled for the orphan reaper.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

export const MEMEX_CONTAINER_LABEL = 'memex.execute_bash';

export interface DockerExecOptions {
  image?: string;
  /** Default: no network. Explicit egress is an operator choice. */
  network?: 'none' | 'bridge';
  memoryLimit?: string;
  cpus?: string;
  pidsLimit?: number;
  timeoutSeconds?: number;
}

/** hermes _BASE_SECURITY_ARGS parity (ADR-47 D-4). */
export function buildDockerRunArgs(command: string, opts: DockerExecOptions = {}): string[] {
  return [
    'run', '--rm',
    '--label', MEMEX_CONTAINER_LABEL,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(opts.pidsLimit ?? 256),
    '--memory', opts.memoryLimit ?? '512m',
    '--cpus', opts.cpus ?? '1',
    '--network', opts.network ?? 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m',
    '--workdir', '/tmp',
    opts.image ?? 'alpine:3',
    'sh', '-lc', command,
  ];
}

/** Reaper command: list orphaned memex exec containers (label match). */
export function buildOrphanListArgs(): string[] {
  return ['ps', '-q', '--filter', `label=${MEMEX_CONTAINER_LABEL}`];
}

export type ExecBackendKind = 'local' | 'docker';

/** Cached docker-availability probe (one `docker version` per process). */
let dockerAvailable: boolean | undefined;
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== undefined) return dockerAvailable;
  try {
    await promisify(execFile)('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5000,
    });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/** Test seam: reset the cached probe between cases. */
export function _resetDockerAvailability(): void {
  dockerAvailable = undefined;
}

/**
 * Resolve the execute_bash backend from EXEC_BACKEND (ADR-47 D-4).
 *
 * - unset / not 'docker' → 'local' (host exec, defense-in-depth — unchanged).
 * - 'docker' + docker reachable → 'docker' (OS-level containment).
 * - 'docker' + docker UNreachable → null = FAIL-CLOSED. We must NOT silently
 *   fall back to host exec: the docker backend bypasses dangerous-pattern
 *   approval (commands can't reach the host), so running on the host instead
 *   would execute approval-bypassed commands directly on the host.
 */
export async function resolveExecBackend(): Promise<ExecBackendKind | null> {
  if (process.env['EXEC_BACKEND'] !== 'docker') return 'local';
  return (await isDockerAvailable()) ? 'docker' : null;
}

/**
 * Pattern-approval bypass rule (ADR-47 D-4): containerized commands skip the
 * dangerous-pattern approval tier; the hardline blocklist ALWAYS applies.
 */
export function approvalRequiredForBackend(
  backend: ExecBackendKind,
  verdict: { allowed: boolean; tier?: 'hardline' | 'dangerous' },
): { blocked: boolean; requiresApproval: boolean } {
  if (!verdict.allowed && verdict.tier === 'hardline') {
    return { blocked: true, requiresApproval: false };
  }
  if (!verdict.allowed && verdict.tier === 'dangerous') {
    return backend === 'docker'
      ? { blocked: false, requiresApproval: false } // contained — host unreachable
      : { blocked: false, requiresApproval: true };
  }
  return { blocked: false, requiresApproval: false };
}
