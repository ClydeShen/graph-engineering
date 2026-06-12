/**
 * Agent capability acquisition (ADR-53 / Phase 20 #1).
 *
 * "An agent cannot grant itself authority": agent-initiated installs go
 * through the Phase 14 approval state machine — skills-guard findings are
 * embedded in the approval request body so the human decides with the scan
 * in front of them. Only an `approved` request executes the install.
 *
 * Flow (two tool calls, async approval between them):
 *   capability_install(request)      → guard-scan → approval filed → {approval_id, pending}
 *   capability_install(approval_id)  → status check → re-scan → install → graph events
 *
 * Search unifies the three capability sources behind one verb (ADR-51 D-4:
 * search_catalog / install / inspect — no `select`; runtime choice stays with
 * the agent via cold-start endorsement).
 */

import type { Pool } from 'pg';
import {
  CAPABILITY_PRESETS,
  findCapabilityScope,
  implementationEntityId,
  recordCapabilityEvent,
} from '@graph/shared';
import type { ApprovalService } from './approval.js';

export interface AcquisitionCandidate {
  source: 'preset' | 'skill-registry';
  id: string;
  name: string;
  description: string;
  /** What capability_install needs to install this candidate. */
  install_ref: string;
}

/** Injectable seams: registry search + skill install land in packages/cli — the
 * gateway consumes them through this interface (no gateway→cli package dep). */
export interface AcquisitionDeps {
  searchRegistries(query: string): Promise<Array<{ registry: string; id: string; name: string; description: string }>>;
  /** Download + guard-scan only (nothing written). */
  scanCandidate(installRef: string): Promise<{ findings: number; report: string }>;
  /** Execute the install (re-scans internally; throws on new findings). */
  performInstall(installRef: string): Promise<{ location: string }>;
}

/** Search presets + skill registries (best-effort; a down registry hides nothing else). */
export async function searchCapabilities(
  query: string,
  deps: Pick<AcquisitionDeps, 'searchRegistries'>,
): Promise<AcquisitionCandidate[]> {
  const q = query.toLowerCase();
  const fromPresets: AcquisitionCandidate[] = CAPABILITY_PRESETS.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q),
  ).map((p) => ({
    source: 'preset',
    id: p.name,
    name: p.name,
    description: `[${p.category}/${p.form}] ${p.description}`,
    install_ref: `preset:${p.name}`,
  }));

  let fromRegistries: AcquisitionCandidate[] = [];
  try {
    fromRegistries = (await deps.searchRegistries(query)).map((r) => ({
      source: 'skill-registry',
      id: r.id,
      name: r.name,
      description: r.description,
      install_ref: `skill:${r.registry}:${r.id}`,
    }));
  } catch {
    /* registry unreachable — presets still answer */
  }
  return [...fromPresets, ...fromRegistries];
}

/**
 * Step 1: file the approval with the guard report in the body.
 * The scan happens NOW so the human sees findings before deciding.
 */
export async function requestInstall(
  approvals: ApprovalService,
  deps: Pick<AcquisitionDeps, 'scanCandidate'>,
  scopeId: string,
  principal: string,
  installRef: string,
): Promise<{ approval_id: string; findings: number }> {
  const scan = await deps.scanCandidate(installRef);
  const command =
    `capability_install ${installRef}\n` +
    `guard scan: ${scan.findings} finding(s)\n${scan.report}`;
  const approvalId = await approvals.request(scopeId, principal, command);
  return { approval_id: approvalId, findings: scan.findings };
}

/**
 * Step 2: execute only when approved. Re-scan happens inside performInstall —
 * content may have changed between request and approval (TOCTOU guard).
 */
export async function executeInstall(
  pool: Pool,
  approvals: ApprovalService,
  deps: Pick<AcquisitionDeps, 'performInstall'>,
  approvalId: string,
  installRef: string,
  principal: string,
): Promise<{ status: string; location?: string }> {
  const status = await approvals.status(approvalId);
  if (status === null) return { status: 'unknown_approval' };
  if (status !== 'approved') return { status };

  const { location } = await deps.performInstall(installRef);

  // Capability graph: agent-initiated install is an Association like any other
  // (ADR-51) — plus the initiator principal for audit.
  try {
    const scopeId = await findCapabilityScope(pool);
    if (scopeId) {
      await recordCapabilityEvent(pool, scopeId, 'installed', {
        capability: installRef,
        form: installRef.startsWith('skill:') ? 'skill' : 'preset',
        implementation_entity_id: implementationEntityId(installRef),
        initiated_by: principal,
        approval_id: approvalId,
      });
    }
  } catch {
    /* observation is best-effort */
  }
  return { status: 'installed', location };
}
