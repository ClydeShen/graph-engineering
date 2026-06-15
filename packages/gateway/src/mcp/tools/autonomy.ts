/**
 * Phase 20 (ADR-53) autonomous-assistant tool family: ask_user, ask_user_status,
 * capability_search, capability_install, browser.
 *
 * Trust gating happens at the HTTP MCP route (isToolAllowed interception);
 * capability_install and browser are PAIRED_DENIED — trusted principals only.
 * An agent cannot grant itself authority (ADR-53): capability_install is two-phase
 * (file approval, then execute on human consent).
 */
import { z } from 'zod';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { occWrite } from '@graph/shared';
import {
  formatGuardReport,
  injectSecrets,
  installSkill,
  profileDir,
  REGISTRIES,
  resolveBindings,
  saveArtifact,
  scanSkillContent,
  searchSkills,
} from '@graph/shared';
import { ApprovalService } from '../../security/approval.js';
import { AskUserService } from '../../security/ask-user.js';
import { requestInstall, executeInstall, searchCapabilities } from '../../security/acquisition.js';
import { buildBrowserRunArgs } from '../../security/browser-capability.js';
import { UUID_V4, HASH_HEX64, type McpToolDef, type McpToolFactory } from './types.js';

// ── ask_user ──────────────────────────────────────────────────────────────────
// Approvals generalized to free-form Q&A. Q&A pairs are trail data: "always asks
// at this step" is a Trail Discovery signal.
const AskUserSchema = z.object({
  question: z.string().min(1).max(2000),
  scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
  predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
  principal: z.string().max(128).default('mcp-agent'),
});

async function handleAskUser(
  pool: Pool,
  askUser: AskUserService,
  args: z.infer<typeof AskUserSchema>,
): Promise<CallToolResult> {
  const { question, scope_id, predecessor_hash, principal } = args;
  const questionId = await askUser.ask(scope_id, principal, question);
  try {
    await occWrite(pool, {
      scopeId: scope_id,
      entityId: randomUUID(),
      predecessorHash: predecessor_hash,
      eventType: 'memory_updated',
      payload: { kind: 'memex::ask_user::asked', question_id: questionId, question },
    });
  } catch {
    /* trail mark is best-effort; the question row is authoritative */
  }
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ question_id: questionId, status: 'pending' }) },
    ],
  };
}

export const askUserTool: McpToolFactory = (pool): McpToolDef => {
  const askUser = new AskUserService(pool);
  return {
    name: 'ask_user',
    description:
      'Ask the human a free-form question. Returns a question_id immediately; ' +
      'poll ask_user_status for the answer. Silence (10 min) = timed_out.',
    inputSchema: AskUserSchema,
    handler: (args) => handleAskUser(pool, askUser, args as z.infer<typeof AskUserSchema>),
  };
};

// ── ask_user_status ─────────────────────────────────────────────────────────
const AskUserStatusSchema = z.object({ question_id: z.string().regex(UUID_V4) });

async function handleAskUserStatus(
  askUser: AskUserService,
  args: z.infer<typeof AskUserStatusSchema>,
): Promise<CallToolResult> {
  const result = await askUser.status(args.question_id);
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(result ?? { status: 'unknown_question' }) },
    ],
  };
}

export const askUserStatusTool: McpToolFactory = (pool): McpToolDef => {
  const askUser = new AskUserService(pool);
  return {
    name: 'ask_user_status',
    description: 'Check an ask_user question: pending | answered (+answer) | timed_out.',
    inputSchema: AskUserStatusSchema,
    handler: (args) => handleAskUserStatus(askUser, args as z.infer<typeof AskUserStatusSchema>),
  };
};

// ── capability_search ─────────────────────────────────────────────────────────
// Unified search over presets + skill registries (ADR-51 verb family:
// search_catalog; no `select` — the agent chooses).
const CapabilitySearchSchema = z.object({ query: z.string().min(1).max(200) });

async function handleCapabilitySearch(args: z.infer<typeof CapabilitySearchSchema>): Promise<CallToolResult> {
  const candidates = await searchCapabilities(args.query, {
    searchRegistries: (q) => searchSkills(fetch, q),
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(candidates) }] };
}

export const capabilitySearchTool: McpToolFactory = (): McpToolDef => ({
  name: 'capability_search',
  description:
    'Search installable capabilities (presets + skill registries) when the current ' +
    'task needs an ability you do not have. Install via capability_install (human approval required).',
  inputSchema: CapabilitySearchSchema,
  handler: (args) => handleCapabilitySearch(args as z.infer<typeof CapabilitySearchSchema>),
});

// ── capability_install ─────────────────────────────────────────────────────────
// Two-phase: file approval (guard report in the body), then execute once the
// human approves. An agent cannot grant itself authority (ADR-53).
const CapabilityInstallSchema = z.object({
  install_ref: z.string().min(1).max(300),
  approval_id: z.string().regex(UUID_V4).optional(),
  scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
  principal: z.string().max(128).default('mcp-agent'),
});

async function handleCapabilityInstall(
  pool: Pool,
  approvals: ApprovalService,
  args: z.infer<typeof CapabilityInstallSchema>,
): Promise<CallToolResult> {
  const { install_ref, approval_id, scope_id, principal } = args;
  const deps = makeAcquisitionDeps();
  if (approval_id === undefined) {
    const filed = await requestInstall(approvals, deps, scope_id, principal, install_ref);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...filed,
            status: 'pending',
            next: 'await human approval, then re-call with approval_id',
          }),
        },
      ],
    };
  }
  const result = await executeInstall(pool, approvals, deps, approval_id, install_ref, principal);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

export const capabilityInstallTool: McpToolFactory = (pool): McpToolDef => {
  const approvals = new ApprovalService(pool);
  return {
    name: 'capability_install',
    description:
      'Install a capability. First call with install_ref files a human approval ' +
      '(guard scan included) and returns approval_id. After the human approves, ' +
      'call again with BOTH install_ref and approval_id to execute.',
    inputSchema: CapabilityInstallSchema,
    handler: (args) => handleCapabilityInstall(pool, approvals, args as z.infer<typeof CapabilityInstallSchema>),
  };
};

// ── browser (conditional, like execute_bash) ─────────────────────────────────
// Category-resolved implementation inside the docker backend; host browsers are
// never driven.
const BrowserSchema = z.object({
  op: z.enum(['navigate', 'read', 'fill', 'click', 'screenshot']),
  url: z.string().max(2000).optional(),
  selector: z.string().max(500).optional(),
  text: z.string().max(4000).optional(),
  scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
  predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
});

async function handleBrowser(pool: Pool, args: z.infer<typeof BrowserSchema>): Promise<CallToolResult> {
  const { op, url, selector, text, scope_id, predecessor_hash } = args;
  const bindings = await resolveBindings(pool).catch(() => ({}) as Record<string, string>);
  const impl = bindings['browser'];
  if (impl === undefined) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: 'no browser implementation bound — memex capability bind browser <impl>',
        },
      ],
    };
  }
  let runArgs: string[];
  try {
    runArgs = buildBrowserRunArgs(impl, {
      op,
      ...(url !== undefined ? { url } : {}),
      ...(selector !== undefined ? { selector } : {}),
      ...(text !== undefined ? { text } : {}),
    });
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    };
  }

  // Vault injection happens at THIS boundary only (ADR-53): placeholders in the
  // container command resolve to plaintext here, never earlier.
  const last = runArgs[runArgs.length - 1]!;
  if (last.includes('{{vault:')) {
    const injected = await injectSecrets(pool, last);
    if (injected.missing.length > 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `vault secrets missing/shredded: ${injected.missing.join(', ')}`,
          },
        ],
      };
    }
    runArgs[runArgs.length - 1] = injected.resolved;
  }

  try {
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('docker', runArgs, {
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });

    // Screenshots are artifacts (ADR-52 first mandatory producer).
    let artifactHash: string | undefined;
    if (op === 'screenshot') {
      const image = Buffer.from(stdout.trim(), 'base64');
      const saved = await saveArtifact(pool, {
        scopeId: scope_id,
        content: image,
        kind: 'image',
        mediaType: 'image/png',
        label: `browser screenshot ${new Date().toISOString()}`,
      });
      artifactHash = saved.contentHash;
    }

    await occWrite(pool, {
      scopeId: scope_id,
      entityId: randomUUID(),
      predecessorHash: predecessor_hash,
      eventType: 'memory_updated',
      // redaction direction: the ledger gets the op, never fill VALUES
      payload: {
        kind: 'memex::browser::op',
        op,
        implementation: impl,
        ...(artifactHash !== undefined ? { artifact_hash: artifactHash } : {}),
      },
    }).catch(() => {
      /* trail mark best-effort */
    });

    const resultText =
      op === 'screenshot' ? JSON.stringify({ artifact_hash: artifactHash }) : stdout.slice(0, 16384);
    return { content: [{ type: 'text' as const, text: resultText }] };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `browser backend failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

/** Returns null unless MEMEX_BROWSER_ENABLED=true (preserving registry order). */
export const browserTool: McpToolFactory = (pool): McpToolDef | null => {
  if (process.env['MEMEX_BROWSER_ENABLED'] !== 'true') return null;
  return {
    name: 'browser',
    description:
      'Controlled browser action inside an isolated container: navigate | read | ' +
      'fill | click | screenshot. The implementation is the bound `browser` capability.',
    inputSchema: BrowserSchema,
    handler: (args) => handleBrowser(pool, args as z.infer<typeof BrowserSchema>),
  };
};

/**
 * Acquisition deps over the shared skills client. v1 executes `skill:` refs
 * end-to-end; `preset:` refs return operator guidance (presets may need env
 * prompts / OAuth that only the interactive CLI can drive).
 */
function makeAcquisitionDeps(): {
  scanCandidate(ref: string): Promise<{ findings: number; report: string }>;
  performInstall(ref: string): Promise<{ location: string }>;
} {
  const parseSkillRef = (ref: string): { registry: (typeof REGISTRIES)[number]; id: string } => {
    const m = /^skill:([^:]+):(.+)$/.exec(ref);
    const registry = m ? REGISTRIES.find((r) => r.name === m[1]) : undefined;
    if (!m || !registry) {
      throw new Error(`unsupported install_ref '${ref}' — expected skill:<registry>:<id> or preset:<name>`);
    }
    return { registry, id: m[2]! };
  };
  return {
    async scanCandidate(ref) {
      if (ref.startsWith('preset:')) {
        return {
          findings: 0,
          report: 'preset install — runs via operator CLI (memex capability install), no remote content to scan',
        };
      }
      const { registry, id } = parseSkillRef(ref);
      const res = await fetch(registry.downloadUrl(id), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`download failed: ${res.status} from ${registry.name}`);
      const findings = scanSkillContent(await res.text());
      return { findings: findings.length, report: formatGuardReport(findings) };
    },
    async performInstall(ref) {
      if (ref.startsWith('preset:')) {
        return { location: `operator action required: memex capability install ${ref.slice('preset:'.length)}` };
      }
      const { registry, id } = parseSkillRef(ref);
      // installSkill re-downloads + re-scans (TOCTOU guard); confirmed=true is
      // legitimate here because the human approved WITH the scan report in hand.
      const outcome = await installSkill(fetch, registry, id, id, join(profileDir(), 'skills'), true);
      return { location: outcome.dir };
    },
  };
}
