# MemexOS Security & Trust Model

## The one sentence that governs everything

**No in-process mechanism is a security boundary.** CommandGate, env filtering,
PII redaction, the trust→toolset mapping, and skills-guard are defense-in-depth
layers. The only true containment boundary is OS-level isolation — the Docker
execution backend (ADR-47). Running with the `local` backend is a development
mode that trusts the host environment.

## What we defend against (in scope)

| Threat | Defense |
|---|---|
| Untrusted third-party content (inbound webhooks) steering the agent into file/command tools | `untrusted` principals are confined to the webhook-safe toolset (red-line tested); webhook HMAC is mandatory — unsigned requests get 401 and write nothing to the graph |
| Agent privilege escalation into destructive commands | CommandGate hardline blocklist (no mode can bypass it) → pattern-based approval (cross-channel, **silence is deny** — 5-minute timeout rejects) → optional aux-LLM judgment that can only *tighten*, never approve |
| Secrets leaking through subprocess environments | Two-stage env filter (secret-substring blocklist, then safe-prefix allowlist), shared by all execution backends |
| Loader hijack (`LD_PRELOAD`, `PYTHONPATH`, `PATH` injection) | Env-write denylist — these variables can never be set by agent action |
| Right-to-erasure for written content | `erase(scope)`: ledger payload blanking + `erased_at`, derived-data cascade (memory rows + embeddings), content-free audit events; chain verification stays intact (ADR-43/47) |
| Forged agent identities | Pairing: salted-hash codes, unambiguous alphabet, rate limit, failure lockout, constant-time comparison, DB persistence with cross-replica read-through |
| Realtime endpoint abuse | Token auth (timingSafeEqual), connection + message rate limits, localhost bind by default — exposing the gateway is an explicit operator choice |
| An LLM tricked into approving a dangerous command | Tier-3 asymmetric design: LLM judgment can escalate approval requirements but a "safe" verdict never overrides a pattern block (red-line tested) |
| Malicious skill content at install time | skills-guard scan (prompt-override, concealment, credential-harvest, exfiltration, encoded payloads, destructive commands, loader hijack) — **a review aid, not a boundary**; findings withhold installation until explicitly confirmed |

## What we do NOT defend against (out of scope — known boundaries)

- **A compromised host.** With the `local` backend the agent shares the host's
  privileges. The container backend is the prerequisite for any open deployment.
- **Erased content in old backups.** Live-DB erasure cannot reach backups
  already on disk. Documented semantics: **backup retention period = erase
  effectiveness delay** (`memex backup` prints this on every run). Coupling
  backup encryption to the key registry was deliberately deferred (ADR-48 D-4).
- **The multi-source Lesson redistill window.** Between an erase and the next
  reinforcement cycle, a fingerprint Lesson may retain an abstract insight
  distilled from the erased scope (never verbatim content).
- **DoS / resource exhaustion.** Single-tenant self-hosted software; rate
  limits exist for fairness, not as DoS protection.
- **Comprehensive side-channel resistance.** Pairing and token comparisons are
  constant-time, but no broader side-channel guarantees are made.
- **Multi-tenant isolation.** MemexOS 1.0 is single-tenant self-hosted; there
  is no tenant boundary because there are no tenants.

## Security event observability

All security-relevant actions are graph events (`memex::security::*`, ADR-47
D-8): the full approval lifecycle, blocklist hits, trust downgrades, and erase
operations. "This agent keeps probing beyond its privileges" is an emergent
signal that Trail Discovery can surface from the ledger.

## Autonomous-assistant boundaries (Phase 20, ADR-53)

**Agents cannot grant themselves authority.** Agent-initiated capability
installs (`capability_install`) always pass through the human approval state
machine; the skills-guard scan report is embedded in the approval body so the
human decides with the findings in front of them. Content is re-downloaded and
re-scanned at execution time (TOCTOU guard). Silence is not consent — pending
approvals time out to denial.

**Credential vault.** Secrets are envelope-encrypted per service (AES-256-GCM
DEK, wrapped by the operator KEK from `MEMEX_VAULT_KEK`); destroying the
wrapped DEK crypto-shreds the value (ADR-43 mechanism). The invariant: secret
values never enter the ledger or LLM context. Prompts carry
`{{vault:<service>}}` placeholders; plaintext exists only at the tool
execution boundary, immediately before subprocess/transport use. A missing
KEK disables the vault loudly — there is no plaintext fallback.

**Controlled browser.** The `browser` tool drives a containerized browser
(docker execution backend, `--cap-drop ALL`, `no-new-privileges`, read-only
root, bridge network for egress only). It never drives a host browser; login
state lives only in the container. Screenshots enter the system as
hash-addressed artifacts; the ledger records operations and implementation
names, never form-fill values. `capability_install` and `browser` require
the `trusted` level — `paired` principals need an explicit upgrade.

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub Security Advisories** on
this repository (Security tab → Report a vulnerability). Do not open public
issues for security reports.

- Acknowledgement target: within 7 days.
- Assessment and fix-or-mitigation plan: within 30 days for confirmed issues.
- Disclosure: coordinated — we ask that you give us the chance to ship a fix
  before public disclosure, and we will credit reporters who want credit.

## Release integrity

Published artifacts (install scripts, Docker deployment files) ship with
`SHA-256SUMS` (`npx tsx scripts/release-checksums.ts --verify`). Signing is
performed as a manual release step; no signing keys live in this repository.
