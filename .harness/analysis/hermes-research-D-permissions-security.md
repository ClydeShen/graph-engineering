# Hermes Agent Research — Part D: Permissions, Tools & Security

## 1. System Permissions & Terminal Backends

### 1.1 Trust Model and Access Scope

Hermes Agent's security model is documented explicitly in `SECURITY.md`. The agent runs as a single-tenant personal agent; it inherits whatever OS-level access the operator's user account has on the host. This is called the "trust envelope": the agent process can do anything the operator themselves can do.

`SECURITY.md:44-47`:
> **Trust envelope.** The set of resources an operator has implicitly granted Hermes Agent access to by running it — typically, whatever the operator's own user account can reach on the host.

The project is explicit that **no in-process mechanism is a security boundary** — only OS-level isolation (containers, sandboxes) constitutes real containment (`SECURITY.md:59-66`).

### 1.2 Terminal Backend Selection

The backend type is chosen via the `TERMINAL_ENV` environment variable, with `"local"` as the default. The selection logic lives in `tools/terminal_tool.py:1034-1291`. The six backends are:

| Backend | Key (`TERMINAL_ENV`) | Credential env var |
|---|---|---|
| Local | `local` | (none beyond OS user) |
| Docker | `docker` | — |
| SSH | `ssh` | `TERMINAL_SSH_HOST`, `TERMINAL_SSH_USER`, `TERMINAL_SSH_KEY` |
| Singularity | `singularity` | — |
| Modal | `modal` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` |
| Daytona | `daytona` | `DAYTONA_API_KEY` |

Reference: `tools/terminal_tool.py:1038` (`env_type = os.getenv("TERMINAL_ENV", "local")`), `tools/terminal_tool.py:1144-1291` (`_create_environment` dispatch).

#### Local Backend (`local`)

`tools/environments/local.py` — Commands run directly on the host machine as a subprocess. The environment inherits the host process's filesystem, network, and process namespace, subject only to the operator user's OS permissions. Provider secrets (API keys, gateway tokens) are stripped from the subprocess environment via a hardcoded blocklist (`tools/environments/local.py:126-187`, `_HERMES_PROVIDER_ENV_BLOCKLIST`).

#### Docker Backend (`docker`)

`tools/environments/docker.py` — Commands run inside a Docker container. Security flags applied to every container (`tools/environments/docker.py:324-333`, `_BASE_SECURITY_ARGS`):
- `--cap-drop ALL` — drops all Linux capabilities
- `--cap-add DAC_OVERRIDE`, `CHOWN`, `FOWNER` — re-adds only what package managers need
- `--security-opt no-new-privileges` — prevents privilege escalation
- `--pids-limit 256` — limits process fork/spawn rate
- `/tmp` and `/var/tmp` mounted as `nosuid` tmpfs, size-limited to 512M and 256M respectively

`SETUID`/`SETGID` are only added when the container needs to do a privilege drop via an init system like s6-overlay, and they are skipped when `--user` is passed (`tools/environments/docker.py:346-347`, `_PRIVDROP_CAP_ARGS`). The default image is `nikolaik/python-nodejs:python3.11-nodejs20` (`tools/terminal_tool.py:1037`).

Container reuse is enabled by default (`TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES=true`, `tools/terminal_tool.py:1122-1124`). An orphan reaper (`tools/environments/docker.py:138-227`, `reap_orphan_containers`) removes stale hermes-labeled containers from prior crashed processes.

Operators can forward host user UID/GID (`TERMINAL_DOCKER_RUN_AS_HOST_USER`), mount host directories (`TERMINAL_DOCKER_VOLUMES`, `TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE`), and pass environment variables explicitly (`TERMINAL_DOCKER_FORWARD_ENV`).

#### SSH Backend (`ssh`)

`tools/environments/ssh.py` — Commands run on a remote machine. The agent connects using OpenSSH ControlMaster for connection reuse (`tools/environments/ssh.py:83-98`). The SSH connection is established with `StrictHostKeyChecking=accept-new`, `BatchMode=yes`, `ControlPersist=300s`. The agent's access is bounded by the SSH user's permissions on the remote host. Key path is configured via `TERMINAL_SSH_KEY`.

The SSH environment also syncs `~/.hermes` config files to the remote home dir using a `FileSyncManager` (`tools/environments/ssh.py:72-79`). The remote machine's filesystem is the scope of impact — the agent cannot reach the local host filesystem through the SSH backend.

#### Singularity Backend (`singularity`)

`tools/environments/singularity.py` — Uses Apptainer/Singularity to run commands in a container image. Security flags include `--containall` (isolates home, tmp, and other paths) and `--no-home` (as documented in the module docstring: `"Security-hardened with --containall, --no-home, capability dropping."`). Filesystem persistence is via writable overlay directories. The image URI is configured via `TERMINAL_SINGULARITY_IMAGE`.

#### Modal Backend (`modal`)

`tools/environments/modal.py` — Uses the Modal cloud sandbox API (`modal.Sandbox.create()` / `modal.Sandbox.exec()`). The sandbox runs in Modal's cloud infrastructure, completely isolated from the operator's host machine. Resource limits (CPU, memory, disk) are configurable (`tools/terminal_tool.py:1108-1111`). The agent uses Direct Modal credentials (`MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`) or a managed Nous Tool Gateway depending on the `TERMINAL_MODAL_MODE` setting.

A "managed Modal" variant (`tools/environments/managed_modal.py`) routes through the Nous Tool Gateway when direct Modal credentials are unavailable.

#### Daytona Backend (`daytona`)

`tools/environments/daytona.py` — Uses the Daytona Python SDK to create cloud sandboxes. The `DaytonaEnvironment` class wraps blocking SDK calls in a `_ThreadedProcessHandle`. Memory is capped at 10 GB (Daytona platform limit, `tools/environments/daytona.py:79-83`). Persistent sandboxes can be stopped and resumed, preserving filesystem state across sessions.

### 1.3 Dangerous Command Gate and Container Bypass

A key security observation: dangerous command checks (including the hardline unconditional blocklist) are **bypassed entirely** for Docker, Singularity, Modal, and Daytona backends:

`tools/approval.py:940-941`:
```python
if env_type in {"docker", "singularity", "modal", "daytona"}:
    return {"approved": True, "message": None}
```

The rationale is that container backends isolate the host; destructive commands inside the container cannot touch the host filesystem or processes. The Local and SSH backends do NOT get this bypass — all approval checks apply.

### 1.4 Credential Scoping in Subprocesses

Hermes filters what environment variables are passed to shell subprocesses, MCP subprocesses, and the code-execution child. `tools/environments/local.py:205-235` (`_sanitize_subprocess_env`) removes all keys in `_HERMES_PROVIDER_ENV_BLOCKLIST` (roughly 50 named secrets including `OPENAI_API_KEY`, `ANTHROPIC_TOKEN`, `TELEGRAM_HOME_CHANNEL`, `MODAL_TOKEN_SECRET`, `DAYTONA_API_KEY`, `GH_TOKEN`, and all gateway `ALLOWED_USERS` settings) unless the operator explicitly allowlisted them via `env_passthrough.py`.

`SECURITY.md:122-133` notes this explicitly: "This reduces casual exfiltration. It is not containment."

---

## 2. System & Programming Tool Usage

### 2.1 Toolset Architecture

The toolset system lives in `toolsets.py`. It defines:

- `_HERMES_CORE_TOOLS` (`toolsets.py:31-73`): the 40+ tools available on every platform (CLI, Telegram, Discord, Slack, WhatsApp, Signal, etc.). This list is the single source of truth — "Edit this once to update all platforms simultaneously."
- `_HERMES_WEBHOOK_SAFE_TOOLS` (`toolsets.py:78-83`): a restricted 4-tool set (`web_search`, `web_extract`, `vision_analyze`, `clarify`) for untrusted webhook payloads. The comment explains why: "Webhook events may originate from untrusted third-party content (for example, public PR titles/comments). Keep the default webhook toolset intentionally constrained to avoid local file/system execution by prompt injection."
- Per-platform toolsets (`hermes-cli`, `hermes-telegram`, `hermes-discord`, etc.) that all use `_HERMES_CORE_TOOLS` as their basis (`toolsets.py:399-547`).

Tool definitions are assembled by `model_tools.py`'s `get_tool_definitions()` (`model_tools.py:264-334`), which resolves toolsets through `resolve_toolset()` in `toolsets.py` and filters out tools whose `check_fn` returns False at runtime.

Tools self-register via `tools/registry.py` — each tool module calls `registry.register()` at import time. Discovery is triggered via `discover_builtin_tools()` in `model_tools.py:1-36`.

### 2.2 Shell / Bash Execution

The `terminal` tool (`tools/terminal_tool.py`) is the primary shell execution mechanism. It:

1. Validates the command string (type check, `workdir` character allowlist at `tools/terminal_tool.py:271-293`)
2. Runs dangerous command guards (`check_all_command_guards` from `tools/approval.py`)
3. Dispatches to the configured backend environment via `env.execute(command, ...)`
4. For local backend: spawns `bash -c <command>` as a subprocess (`tools/environments/local.py`, `_find_bash()`)

The `terminal` tool supports foreground and background execution, PTY mode for interactive CLIs, watch patterns for background output monitoring, and working directory tracking across calls.

### 2.3 File Read/Write/Search

Four dedicated file tools exist in `tools/file_tools.py`:

- `read_file` — reads files up to `_DEFAULT_MAX_READ_CHARS` (100,000 characters, configurable via `file_read_max_chars` in config, `tools/file_tools.py:35-36`)
- `write_file` — writes files; uses `ShellFileOperations` which routes through the active terminal backend for non-local environments
- `patch` — applies fuzzy-matched patches (via `tools/patch_parser.py`)
- `search_files` — content and file search

The file tools all route through `ShellFileOperations` which delegates to the same backend as `terminal`, meaning that file operations in a Docker/Modal/SSH/Singularity/Daytona backend run inside that backend's environment, not on the host (`SECURITY.md:75-78`: "The file tools (`read_file`, `write_file`, `patch`) also run through this backend, since they are implemented on top of the shell contract — they cannot reach paths the backend doesn't expose.").

File read is blocked for binary file extensions (`tools/binary_extensions.py`) and for files that `agent/file_safety.py` flags.

### 2.4 Code Execution Tool (RPC-callable Python Scripts)

`tools/code_execution_tool.py` — The `execute_code` tool lets the LLM write Python scripts that call Hermes tools programmatically via RPC, reducing inference round-trips. Architecture:

- **Local backend (UDS)**: Parent creates a Unix domain socket, starts an RPC listener thread, and spawns the child process. Tool calls travel back to the parent over UDS and are dispatched there.
- **Remote backends (file-based RPC)**: Parent ships `hermes_tools.py` stubs and the script to the remote environment. Tool calls are written as files, polled by the parent, dispatched, and results written back as response files.

The child process is heavily scrubbed of secrets (`tools/code_execution_tool.py:87-100`):
- All `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `PASSWD`, `AUTH`, `DSN`, `WEBHOOK` substrings are stripped.
- Only whitelisted prefixes (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, etc.) are passed through.
- Only 7 tools are available inside the sandbox: `web_search`, `web_extract`, `read_file`, `write_file`, `search_files`, `patch`, `terminal` (`tools/code_execution_tool.py:61-68`, `SANDBOX_ALLOWED_TOOLS`).

### 2.5 MCP Server Integration

`tools/mcp_tool.py` — Connects to external MCP servers via stdio, HTTP/StreamableHTTP, or SSE transport. Configuration is in `~/.hermes/config.yaml` under `mcp_servers`. The MCP tool:

- Spawns each stdio MCP server as a subprocess with environment variable filtering (provider secrets stripped from subprocess env, `tools/mcp_tool.py` references `_HERMES_PROVIDER_ENV_BLOCKLIST`)
- Maintains a dedicated background event loop (`_mcp_loop`) in a daemon thread for all MCP async operations
- Discovers tools from each server and registers them into the Hermes tool registry, making them callable by the agent like built-in tools
- Supports sampling: MCP servers can initiate LLM requests back through Hermes, gated by per-server config (`sampling.enabled`, `max_rpm`, `allowed_models`)
- MCP stderr output is redirected to `~/.hermes/logs/mcp-stderr.log` (not the terminal) to prevent TUI corruption (`tools/mcp_tool.py:100-168`)

The `mcp_serve.py` module is the inverse direction: it exposes Hermes's own message conversations as an MCP server (10 tools: `conversations_list`, `messages_read`, `messages_send`, `events_poll`, `permissions_respond`, etc.) so that MCP clients like Claude Code can interact with Hermes's gateway (`mcp_serve.py:1-28`).

### 2.6 The `_HERMES_CORE_TOOLS` Tool Set

From `toolsets.py:31-73`, the 40 core tools include:
- Web: `web_search`, `web_extract`
- Terminal + process: `terminal`, `process`
- File: `read_file`, `write_file`, `patch`, `search_files`
- Vision/image: `vision_analyze`, `image_generate`
- Skills management: `skills_list`, `skill_view`, `skill_manage`
- Browser automation (12 tools): `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_press`, `browser_get_images`, `browser_vision`, `browser_console`, `browser_cdp`, `browser_dialog`
- TTS: `text_to_speech`
- Planning/memory: `todo`, `memory`
- Session search: `session_search`
- Clarify: `clarify`
- Code execution + delegation: `execute_code`, `delegate_task`
- Cronjob: `cronjob`
- Messaging (gated): `send_message`
- Home Assistant (gated): `ha_list_entities`, `ha_get_state`, `ha_list_services`, `ha_call_service`
- Kanban (gated): 9 kanban tools
- Computer use (macOS, gated): `computer_use`

The `handle_function_call` dispatch lives in `model_tools.py` and delegates to each tool's registered handler via `registry.dispatch()`.

---

## 3. Security Mechanisms

### 3.1 Dangerous Command Approval Workflow

The approval system (`tools/approval.py`) is the primary in-process guard. It runs every shell command through two layers:

**Layer 1 — Hardline unconditional blocklist** (`tools/approval.py:203-225`, `HARDLINE_PATTERNS`):
Matches before yolo, before mode=off, before any bypass. Covers:
- `rm -rf /` and variants targeting `/home`, `/root`, `/etc`, `/usr`, `/var`, `/bin`, `/sbin`, `/boot`, `/lib`, or `$HOME`
- `mkfs` (filesystem format)
- `dd` to raw block devices (`/dev/sd*`, `/dev/nvme*`, etc.)
- Fork bomb (`: () { : | : & } ; :`)
- `kill -1` (kill all processes)
- `shutdown`, `reboot`, `halt`, `poweroff`, `init 0/6`, `systemctl poweroff/reboot`

These are blocked regardless of `--yolo`, `approvals.mode=off`, or cron approval mode. (`tools/approval.py:287-300`, `_hardline_block_result`).

**Layer 2 — Dangerous pattern detection** (`tools/approval.py:321-427`, `DANGEROUS_PATTERNS`):
47 regex patterns covering recursive delete, dangerous `chmod`/`chown`, SQL DROP/DELETE/TRUNCATE, writes to `/etc/` and macOS `/private/etc/`, system service restarts, force-kill, fork bomb, shell via `-c` flag, pipe-to-shell (`curl | sh`), writes to `.ssh`, shell RC files, credential files, `.env` files, `xargs rm`, `find -delete`, git force push, docker lifecycle commands, self-termination patterns, and sudo privilege-escalation flags.

Unicode normalization (`unicodedata.normalize('NFKC', ...)`) and ANSI strip (`tools/ansi_strip.py`) are applied before matching to defeat obfuscation (`tools/approval.py:464-479`, `_normalize_command_for_detection`).

**Approval scopes** (`tools/approval.py:795-813`): The user can approve a command for:
- `once` — single execution, no state persisted
- `session` — approved for this session only (stored in `_session_approved` dict)
- `always` — permanently added to `command_allowlist` in config.yaml (persisted to disk)

**Smart approval mode** (`tools/approval.py:878-922`, `_smart_approve`): When `approvals.mode=smart`, the auxiliary LLM is asked to assess the command risk before prompting the user. It returns APPROVE, DENY, or ESCALATE (to manual prompt). Inspired by OpenAI Codex's Smart Approvals.

**Gateway/async approval** (`tools/approval.py:1060-1158`, `_await_gateway_decision`): When running via a messaging platform gateway, the agent thread blocks on a `threading.Event` while the approval request is forwarded to the user over the platform (Telegram, Discord, etc.). The user responds with `/approve` or `/deny`. A 5-minute default gateway timeout exists; silence is treated as denial (`tools/approval.py:1338-1361`): "Silence is not consent."

**Sudo stdin guard** (`tools/approval.py:250-271`, `_check_sudo_stdin_guard`): Unconditionally blocks any `sudo -S` invocation when `SUDO_PASSWORD` is not configured, preventing password-guessing via stdin injection. This fires before the yolo bypass.

**YOLO mode** (`tools/approval.py:29`, `_YOLO_MODE_FROZEN`): Frozen at import time to prevent skills from dynamically setting `HERMES_YOLO_MODE` mid-session. YOLO bypasses all dangerous-command prompts (but not the hardline blocklist and sudo stdin guard, which apply before the yolo check).

### 3.2 DM Pairing System

`gateway/pairing.py` — Controls which users on messaging platforms (Telegram, Discord, Slack, etc.) can send commands to the agent. An unknown user receives an 8-character one-time pairing code that the bot owner must approve via the CLI.

Security features (as documented in `gateway/pairing.py:1-17`):
- **8-char codes from a 32-char unambiguous alphabet** (no `0/O/1/I`), cryptographically generated via `secrets.choice()` (`gateway/pairing.py:39-41`, `gateway/pairing.py:236`)
- **Codes are hashed** before storage using SHA-256 with a random 16-byte salt; plaintext codes never touch disk (`gateway/pairing.py:200-202`, `_hash_code`; `gateway/pairing.py:239-240`)
- **1-hour code expiry** (`CODE_TTL_SECONDS = 3600`, `gateway/pairing.py:45`)
- **Max 3 pending codes per platform** (`MAX_PENDING_PER_PLATFORM = 3`, `gateway/pairing.py:50`)
- **Rate limiting: 1 request per user per 10 minutes** (`RATE_LIMIT_SECONDS = 600`, `gateway/pairing.py:46`)
- **Lockout after 5 failed approval attempts for 1 hour** (`MAX_FAILED_ATTEMPTS = 5`, `gateway/pairing.py:51`)
- **File permissions: `0o600` on all data files** (`gateway/pairing.py:70`, `os.chmod(path, 0o600)`)
- Constant-time comparison for code verification (iterating all entries with `hmac.compare_digest` implied by the hash-compare pattern, `gateway/pairing.py:290-310`)
- Atomic file writes via temp-file + rename (`gateway/pairing.py:55-78`, `_secure_write`)

Pairing data is stored in `~/.hermes/pairing/` with per-platform files (`{platform}-pending.json`, `{platform}-approved.json`, `_rate_limits.json`).

### 3.3 Slash Command Access Control

`gateway/slash_access.py` — A second authorization axis layered on top of the pairing allowlist. Even users who are paired can be restricted to specific slash commands:

- `allow_admin_from` — user IDs with access to all slash commands (admin tier)
- `user_allowed_commands` — specific commands non-admin users may run (empty = no commands)
- `_ALWAYS_ALLOWED_FOR_USERS` = `{"help", "whoami"}` — always accessible to all paired users regardless of gating (`gateway/slash_access.py:50-52`)

This is applied at the slash command dispatch site in `gateway/run.py` so it covers both built-in and plugin-registered commands.

### 3.4 Container/Sandbox Isolation

**Docker isolation** (`tools/environments/docker.py`):
- All capabilities dropped except `DAC_OVERRIDE`, `CHOWN`, `FOWNER` (and `SETUID`/`SETGID` for init-based images)
- `no-new-privileges` prevents capability escalation inside the container
- `--pids-limit 256` limits process creation
- Tmpfs mounts for `/tmp` (nosuid, 512MB) and `/var/tmp` (noexec, nosuid, 256MB)
- Containers are tagged with `label=hermes-agent=1` and `label=hermes-profile=<name>` for lifecycle management

**Singularity isolation** (`tools/environments/singularity.py`):
- `--containall` restricts access to home, tmp, and other host paths
- `--no-home` prevents mounting the host home directory
- Capability dropping as noted in the module docstring

**Whole-process isolation** (`SECURITY.md:91-113`): The project documents two supported whole-process isolation postures:
1. Hermes Agent's own Docker image + Compose setup — standard container isolation
2. NVIDIA OpenShell — per-session sandboxes with declarative policy across filesystem, network (L7 egress), process/syscall, and inference-routing layers; network and inference policies are hot-reloadable; credentials injected from a Provider store without touching the sandbox filesystem

**Network egress isolation** (`docs/security/network-egress-isolation.md`): Documents an optional Docker Compose override that segments traffic using two networks: an `internal` bridge (no internet access, for the agent) and an `egress` bridge (internet, for the gateway). Recommends routing all outbound traffic through an HTTP proxy (e.g., Squid) with an explicit allowlist of LLM and messaging platform API endpoints.

### 3.5 Tirith Security Scanner

`tools/tirith_security.py` — An external binary (`tirith`) that performs content-level security scanning of shell commands before execution. It detects:
- Homograph URLs (visually similar domain spoofing)
- Pipe-to-interpreter patterns (`curl | sh`)
- Terminal injection
- Other content-level threats

Exit code is the authoritative verdict (0=allow, 1=block, 2=warn). The binary is auto-downloaded from GitHub releases with SHA-256 checksum verification and optional `cosign` supply-chain provenance verification (`tools/tirith_security.py:17-20`). When tirith findings are present, the `[a]lways` permanent allowlist option is suppressed in the approval prompt (`tools/approval.py:1298`).

### 3.6 Skills Guard

`tools/skills_guard.py` — Scans installable skill content (Python code, SKILL.md frontmatter) for injection patterns before installation. Documented in `SECURITY.md:145-151` as "a review aid; the boundary for third-party skills is operator review before install." The guard scans for common prompt injection and malicious code patterns but is explicitly not treated as a security boundary.

### 3.7 Path Security

`tools/path_security.py` — Shared path traversal prevention used across skill management, cronjob tools, and credential files. Uses `Path.resolve().relative_to()` to detect `..` traversal attempts and ensure paths remain within their allowed root directories.

### 3.8 Credential Files Protection

`tools/credential_files.py` and `tools/approval.py` contain patterns specifically targeting writes to `~/.netrc`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, `~/.hermes/.env`, and `~/.ssh/` via dangerous-command detection (`tools/approval.py:132-159`, sensitive path regex fragments).

### 3.9 SECURITY.md Policy

`SECURITY.md` is a detailed, honest security policy covering:
- **§2.2**: The only real security boundary is OS-level isolation (terminal-backend or whole-process wrapping)
- **§2.3**: Credential scoping (environment scrubbing) is a mitigation, not containment
- **§2.4**: In-process heuristics (approval gate, output redaction, Skills Guard) are not boundaries — explicitly out of scope for vulnerability reports
- **§2.5**: Plugin trust model — plugins run with full agent privileges; review before install is the boundary
- **§2.6**: External surfaces require allowlists; session identifiers are routing handles, not authorization
- **§3.1** (In scope): OS isolation escape, unauthorized external surface access, credential exfiltration, trust-model documentation violations
- **§3.2** (Out of scope): Bypasses of in-process heuristics, prompt injection per se, consequences of the chosen posture, documented break-glass settings, third-party skills/plugins

### 3.10 Tool-call Loop Guardrails

`agent/tool_guardrails.py` — A pure, side-effect-free controller that tracks per-turn tool-call patterns and returns warnings or hard stops. Thresholds include:
- Exact failure warn after 2 identical failed calls (`exact_failure_warn_after: 2`)
- Same-tool failure halt after 8 (`same_tool_failure_halt_after: 8`)
- No-progress block after 5 (`no_progress_block_after: 5`)

Hard stops are opt-in (`hard_stop_enabled: False` by default) to avoid interrupting legitimate long-running work in interactive sessions.

---

## Citation Index

| Citation | File & Lines |
|---|---|
| Trust envelope definition | `SECURITY.md:44-47` |
| OS-level isolation as the only real boundary | `SECURITY.md:59-66` |
| Terminal-backend isolation scope | `SECURITY.md:75-93` |
| Whole-process wrapping postures | `SECURITY.md:91-113` |
| Credential scoping description | `SECURITY.md:122-133` |
| In-process heuristics listed | `SECURITY.md:139-151` |
| Plugin trust model | `SECURITY.md:155-167` |
| External surface rules | `SECURITY.md:176-219` |
| In-scope vulnerability categories | `SECURITY.md:225-244` |
| Out-of-scope categories | `SECURITY.md:246-295` |
| Deployment hardening advice | `SECURITY.md:300-332` |
| TERMINAL_ENV config key | `tools/terminal_tool.py:1038` |
| `_create_environment` backend dispatch | `tools/terminal_tool.py:1144-1291` |
| Docker environment instantiation | `tools/terminal_tool.py:1179-1198` |
| Singularity environment instantiation | `tools/terminal_tool.py:1201-1205` |
| Modal environment instantiation | `tools/terminal_tool.py:1208-1264` |
| Daytona environment instantiation | `tools/terminal_tool.py:1266-1273` |
| SSH environment instantiation | `tools/terminal_tool.py:1275-1285` |
| Terminal tool description (LLM-facing) | `tools/terminal_tool.py:833-853` |
| `_get_env_config` all config keys | `tools/terminal_tool.py:1034-1132` |
| `_BASE_SECURITY_ARGS` Docker security flags | `tools/environments/docker.py:324-333` |
| `_PRIVDROP_CAP_ARGS` Docker privilege drop caps | `tools/environments/docker.py:345-349` |
| `_build_security_args` function | `tools/environments/docker.py:352-364` |
| Docker orphan reaper | `tools/environments/docker.py:138-227` |
| SSH ControlMaster args | `tools/environments/ssh.py:83-98` |
| Singularity `--containall`/`--no-home` docstring | `tools/environments/singularity.py:1-7` |
| Daytona SDK integration | `tools/environments/daytona.py:30-80` |
| Modal Sandbox.create/exec | `tools/environments/modal.py:1-6` |
| `_HERMES_PROVIDER_ENV_BLOCKLIST` build | `tools/environments/local.py:100-187` |
| `_sanitize_subprocess_env` | `tools/environments/local.py:205-235` |
| `_HERMES_CORE_TOOLS` definition | `toolsets.py:31-73` |
| `_HERMES_WEBHOOK_SAFE_TOOLS` and rationale | `toolsets.py:75-83` |
| Platform toolset definitions | `toolsets.py:399-547` |
| `SANDBOX_ALLOWED_TOOLS` (7 tools in execute_code) | `tools/code_execution_tool.py:61-68` |
| execute_code architecture docstring | `tools/code_execution_tool.py:1-29` |
| execute_code env scrubbing rules | `tools/code_execution_tool.py:87-100` |
| MCP tool architecture docstring | `tools/mcp_tool.py:1-78` |
| MCP stderr redirect to log file | `tools/mcp_tool.py:100-168` |
| mcp_serve.py tool surface (10 tools) | `mcp_serve.py:1-28` |
| `get_tool_definitions` assembly | `model_tools.py:264-334` |
| `handle_function_call` via registry | `model_tools.py:1-36` (module docstring) |
| Container backend skips approval checks | `tools/approval.py:940-941` |
| `HARDLINE_PATTERNS` list | `tools/approval.py:203-225` |
| `_hardline_block_result` format | `tools/approval.py:287-300` |
| `DANGEROUS_PATTERNS` list (47 regexes) | `tools/approval.py:321-427` |
| `_normalize_command_for_detection` (NFKC + ANSI strip) | `tools/approval.py:464-479` |
| `_YOLO_MODE_FROZEN` import-time freeze | `tools/approval.py:29` |
| Approval scope persistence (once/session/always) | `tools/approval.py:795-813` |
| `_smart_approve` via aux LLM | `tools/approval.py:878-922` |
| Gateway blocking approval via `_await_gateway_decision` | `tools/approval.py:1060-1158` |
| "Silence is not consent" (gateway) | `tools/approval.py:1338-1361` |
| `_check_sudo_stdin_guard` | `tools/approval.py:255-271` |
| `check_all_command_guards` combined guard | `tools/approval.py:1161-1452` |
| `check_execute_code_guard` | `tools/approval.py:1455-1620` |
| DM pairing system docstring & constants | `gateway/pairing.py:1-51` |
| `_secure_write` atomic + chmod 0600 | `gateway/pairing.py:55-78` |
| `generate_code` cryptographic code generation | `gateway/pairing.py:204-258` |
| `approve_code` constant-time verification + lockout | `gateway/pairing.py:260-310` |
| Slash access control constants | `gateway/slash_access.py:1-52` |
| `SlashAccessPolicy.is_admin` / `can_run` | `gateway/slash_access.py:69-80` |
| Tirith scanner docstring | `tools/tirith_security.py:1-21` |
| Tirith cosign provenance verification | `tools/tirith_security.py:43-44` |
| `validate_within_dir` path traversal guard | `tools/path_security.py:15-34` |
| `has_traversal_component` quick check | `tools/path_security.py:37-44` |
| `env_passthrough.py` purpose | `tools/env_passthrough.py:1-65` |
| GHSA-rhgp-j443-p4rf credential passthrough bug reference | `tools/env_passthrough.py:54-61` |
| Tool-call guardrail thresholds | `agent/tool_guardrails.py:63-80` |
| Docker image SHA-pinned multi-stage Dockerfile | `Dockerfile:1-11` |
| s6-overlay SHA256 supply chain verification | `Dockerfile:51-76` |
| Network egress isolation architecture | `docs/security/network-egress-isolation.md:1-50` |
| Squid allowlist example | `docs/security/network-egress-isolation.md:138-154` |
| `_workdir` safe character allowlist | `tools/terminal_tool.py:271-293` |
| `_rewrite_real_sudo_invocations` sudo -S injection | `tools/terminal_tool.py:501-559` |
