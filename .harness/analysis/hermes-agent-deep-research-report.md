# Hermes Agent — Deep Research Report

**Date:** 2026-06-07  
**Codebase:** `D:\Repo\specimens\hermes-agent` (NousResearch/hermes-agent)  
**Research method:** Multi-agent codebase analysis (4 parallel specialists) + external cross-validation  
**Status:** Cross-validation section pending (agent running) — core report complete

---

> **How to read this document.** Every factual claim is backed by a codebase citation in `path/to/file.py:LINE` format or an external research reference. Section 10 contains the cross-validation results once available. Nothing in sections 1–9 is stated without observed evidence from the source code.

---

## Table of Contents

1. [Onboarding — What the System Collects and Why](#1-onboarding)
2. [Installation — All Platforms](#2-installation)
3. [Configuration — Structure and All Domains](#3-configuration)
4. [Model Types — Chat, STT, TTS, Image, Video](#4-model-types)
5. [Model Configuration and Consumption (Runtime)](#5-model-configuration-and-runtime-consumption)
6. [User Interaction — TUI, CLI, Slash Commands, Voice](#6-user-interaction)
7. [Multi-terminal Interaction System (Gateway)](#7-multi-terminal-interaction-system)
8. [Cross-platform Notifications and Cron Delivery](#8-cross-platform-notification-delivery)
9. [System Permissions, Tools, and Security](#9-system-permissions-tools-and-security)
10. [Cross-validation (External Research)](#10-cross-validation)

---

## 1. Onboarding

### 1.1 Entry Point

Onboarding begins automatically at the end of the install script (unless `--skip-setup` is passed to `install.sh` or `install.ps1`). The wizard can also be invoked manually at any time:

```bash
hermes setup            # auto-detects first-run vs. reconfigure
hermes setup --portal   # one-shot Nous Portal OAuth (recommended fast path)
hermes setup model      # only model/provider section
hermes setup gateway    # only messaging platform section
```

The wizard entry point is `run_setup_wizard()` at `hermes_cli/setup.py:2835`.

The first thing it does is check for a TTY via `is_interactive_stdin()` (`hermes_cli/setup.py:2881`). In headless/CI environments it exits cleanly rather than hanging on `input()`, printing guidance to use `hermes config set` or env vars directly (`hermes_cli/setup.py:2884–2888`).

### 1.2 OpenClaw Migration (First-Run Only)

Before any prompts appear, the wizard calls `_offer_openclaw_migration()` (`hermes_cli/setup.py:3003`), which checks for `~/.openclaw/` on disk, does a dry-run preview, warns about high-impact items (gateway tokens, semantic differences) via `_HIGH_IMPACT_KIND_KEYWORDS` (`hermes_cli/setup.py:2498–2509`), and only executes migration on explicit confirmation. Items migrated: SOUL.md, MEMORY.md, USER.md entries, user-created skills, command allowlist, messaging tokens, selected API keys, TTS assets (`README.md:157–170`).

### 1.3 First-Time Mode Choice

First-time users see two paths (`hermes_cli/setup.py:3007–3010`):

| Path | What it does |
|---|---|
| **Quick Setup** (`_run_first_time_quick_setup()`) | Nous Portal OAuth → terminal backend → optional gateway (`hermes_cli/setup.py:3062`) |
| **Full Setup** | All 5 sections in sequence (`hermes_cli/setup.py:3031–3059`) |

The `hermes setup --portal` one-shot path (`_run_portal_one_shot()`, `hermes_cli/setup.py:2723`) does device-code OAuth, sets `model.provider = "nous"`, and optionally enables the Tool Gateway.

### 1.4 What Each Section Collects and Why

#### Section 1 — Model & Provider (`hermes_cli/setup.py:692`)

| Information | Storage | Why needed |
|---|---|---|
| Provider choice | `config.yaml: model.provider` | Determines API endpoint, auth scheme, wire format |
| API key | `~/.hermes/.env: <PROVIDER>_API_KEY` | Authenticates LLM API calls — without it no inference works |
| Base URL | `config.yaml: model.base_url` | Required for local/custom endpoints |
| Model name | `config.yaml: model.default` | The LLM that handles all conversations and agent turns |

#### Section 1b — TTS Provider (`hermes_cli/setup.py:886`)

| Information | Env Var | Why needed |
|---|---|---|
| TTS provider choice | `config.yaml: tts.provider` | Controls which voice engine produces audio in CLI and messaging |
| ElevenLabs API key | `ELEVENLABS_API_KEY` | Premium voices |
| OpenAI TTS key | `VOICE_TOOLS_OPENAI_KEY` | Separate from main inference key |
| xAI / MiniMax / Mistral / Gemini keys | Various | Unlocks respective voice engines |

Edge TTS (Microsoft) is the default — free, no API key required.

#### Section 2 — Terminal Backend (`hermes_cli/setup.py:1132`)

| Backend | Credentials collected | Why |
|---|---|---|
| `local` | None beyond OS user | Commands run on host filesystem |
| `docker` | docker_image | Isolated container |
| `modal` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | Serverless cloud sandbox auth (`hermes_cli/setup.py:1306–1316`) |
| `daytona` | `DAYTONA_API_KEY` | Cloud dev environment auth (`hermes_cli/setup.py:1362–1365`) |
| `ssh` | `TERMINAL_SSH_HOST/USER/PORT/KEY` | Remote machine credentials (`hermes_cli/setup.py:1377–1398`) |
| `singularity` | singularity_image | HPC container runtime |

#### Section 3 — Agent Settings (`hermes_cli/setup.py:1463`)

| Setting | Config key | Purpose |
|---|---|---|
| Max iterations | `agent.max_turns` (default 90) | Caps tool-calling per turn — affects cost and completeness |
| Compression threshold | `compression.threshold` | When (% of context used) to auto-compress old messages |
| Session reset mode | `session_reset.mode` | Messaging sessions grow indefinitely without resets |
| Idle timeout | `session_reset.idle_minutes` (default 1440) | Auto-reset after 24h inactivity |

#### Section 4 — Messaging Platforms (`hermes_cli/setup.py:2056`)

For **Telegram** (`hermes_cli/setup.py:1640`):

| Information | Env Var | Why |
|---|---|---|
| Bot token | `TELEGRAM_BOT_TOKEN` | Authenticates the Telegram Bot API |
| Allowed user IDs | `TELEGRAM_ALLOWED_USERS` | Security: restrict who can talk to the bot |
| Home channel ID | `TELEGRAM_HOME_CHANNEL` | Where cron results and notifications are delivered |

For **Slack** (`hermes_cli/setup.py:1711`): `SLACK_BOT_TOKEN` (xoxb-...) + `SLACK_APP_TOKEN` (xapp-...) for Socket Mode + allowed users + home channel. The setup also generates a Slack app manifest (`slack-manifest.json`) for pasting into `api.slack.com/apps` (`hermes_cli/setup.py:1789–1814`).

For **Matrix** (`hermes_cli/setup.py:1822`): homeserver URL, access token (preferred) or user/password fallback, E2EE opt-in, allowed users, home room.

For **BlueBubbles** (iMessage bridge, `hermes_cli/setup.py:1938`): local Mac server URL and password, allowed iMessage addresses, home channel.

After any platform is configured, the wizard offers to install the gateway as a system service (systemd on Linux, launchd on macOS, Scheduled Task on Windows) (`hermes_cli/setup.py:2222–2272`).

#### Section 5 — Tools (`hermes_cli/setup.py:2296`)

Collects API keys for optional tool backends: web search (`EXA_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, `SEARXNG_URL`, `PARALLEL_API_KEY`), image generation (`FAL_KEY`), browser automation (`BROWSERBASE_API_KEY`, `BROWSER_USE_API_KEY`), cloud terminal (`MODAL_TOKEN_ID/SECRET`, `DAYTONA_API_KEY`), and TTS providers.

### 1.5 `hermes doctor`

Defined in `hermes_cli/doctor.py`. Checks: Python version consistency (`hermes_cli/doctor.py:207–258`), provider env var credentials (`hermes_cli/doctor.py:31–54`), API connectivity per provider, tool availability, systemd linger status (`hermes_cli/doctor.py:309–350`), s6-overlay supervision inside Docker (`hermes_cli/doctor.py:261–306`), and Honcho user modeling plugin state (`hermes_cli/doctor.py:105–113`). Doctor is purely diagnostic — no config is modified.

### 1.6 Post-Setup Summary

`_print_setup_summary()` (`hermes_cli/setup.py:356–638`) prints: availability of Vision, Web Search, Browser Automation, Image Generation, TTS, Modal Execution, Skills Hub; config file locations; quick-reference reconfiguration commands.

---

## 2. Installation

### 2.1 Linux / macOS / WSL2 (`scripts/install.sh`)

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

Steps in order:
1. **OS detection** (`scripts/install.sh:422`): Detects linux/macos/android-termux; rejects CYGWIN/MINGW.
2. **Layout resolution** (`scripts/install.sh:345`): Non-root → `~/.hermes/hermes-agent`; root on Linux → FHS layout (`/usr/local/lib/hermes-agent`, command at `/usr/local/bin/hermes`).
3. **uv installation** (`scripts/install.sh:463`): Downloads from `https://astral.sh/uv/install.sh`.
4. **Python 3.11** (`scripts/install.sh:547`): `uv python install 3.11`. Probes SQLite FTS5 (`scripts/install.sh:644`) — FTS5 is required for full-text session search.
5. **Git provisioning** (`scripts/install.sh:757`): Auto-installs via Homebrew/apt/dnf/pacman if absent.
6. **Repo clone**: `git clone` on main branch.
7. **Virtual environment**: `uv venv .venv --python 3.11`.
8. **Python dependencies**: `uv pip install -e ".[all]"` (all extras).
9. **Node.js 22**: For the browser automation tool (agent-browser npm package).
10. **Playwright**: `npx playwright install chromium`.
11. **System tools**: `ripgrep` (file search) and `ffmpeg` (voice/audio processing).
12. **Hermes home init**: Creates `~/.hermes/` directory tree via `ensure_hermes_home()` (`hermes_cli/config.py:685`). Seeds `SOUL.md`.
13. **Setup wizard**: Runs `hermes setup` unless `--skip-setup`.

### 2.2 Windows Native (`scripts/install.ps1`)

```powershell
iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)
```

Key differences:
- Install location: `%LOCALAPPDATA%\hermes\hermes-agent` (`scripts/install.ps1:27`).
- **MinGit**: If no Git is detected, downloads ~45MB portable MinGit to `%LOCALAPPDATA%\hermes\git` — no admin required (`README.md:49`).
- ARM64 detection via `Get-WindowsArch()` from CIM rather than `PROCESSOR_ARCHITECTURE` env var (`scripts/install.ps1:125`).
- Node.js 22 downloaded as standalone zip to `%LOCALAPPDATA%\hermes\nodejs`.
- Supports a `-Manifest`/`-Stage`/`-Json` protocol for driving installation from a Tauri GUI bootstrap installer.

### 2.3 Termux (Android)

Same `scripts/install.sh` one-liner; Termux detected via `TERMUX_VERSION` env var or `com.termux/files/usr` in `PREFIX` (`hermes_constants.py:324–331`).

Key differences:
- Uses stdlib `venv` + `pip` (not uv).
- Install extra is `.[termux]` (excludes faster-whisper, Matrix E2EE — Android-incompatible).
- Pinned by `constraints-termux.txt`: `ipython<10`, `jedi>=0.18.1,<0.20`, `pexpect>4.3,<5`.

### 2.4 Docker

**Official image**: `nousresearch/hermes-agent:latest`

Dockerfile highlights:
- Base: `debian:13.4` (`Dockerfile:10`).
- Process supervisor: s6-overlay v3.2.3.0, SHA256-verified, multi-arch (`Dockerfile:51–80`). s6-overlay's `/init` is PID 1, supervising `main-hermes`, `dashboard`, and per-profile gateways.
- Node.js 22 and uv copied from upstream slim images.
- `HERMES_HOME=/opt/data` (bind-mounted volume for persistence; `Dockerfile:14`).
- `docker-compose.yml` and `docker-compose.windows.yml` available for orchestrated deployments.

### 2.5 Nix / NixOS (`flake.nix`)

- Inputs: nixpkgs-unstable, flake-parts, pyproject-nix, uv2nix (`flake.nix:4–25`).
- Supported: x86_64-linux, aarch64-linux, aarch64-darwin (`flake.nix:31–36`).
- A `services.hermes-agent` NixOS module allows declarative configuration. In managed mode, `hermes setup` is blocked — user must use `nixos-rebuild switch` (`hermes_cli/config.py:440–466`).

### 2.6 Dev / Contributor

```bash
git clone https://github.com/NousResearch/hermes-agent.git && cd hermes-agent
./setup-hermes.sh   # uv + .venv + .[all] + symlink
```

### 2.7 Homebrew

`brew upgrade hermes-agent`. Managed mode (`HERMES_MANAGED=homebrew`) blocks wizard config modifications (`hermes_cli/config.py:237–242`).

---

## 3. Configuration

### 3.1 File Locations

| File | Path | Purpose |
|---|---|---|
| Main config | `~/.hermes/config.yaml` | All non-secret settings |
| Secrets | `~/.hermes/.env` | API keys, bot tokens, passwords |
| Persona | `~/.hermes/SOUL.md` | Agent identity — injected as slot #1 in system prompt |
| Active profile | `~/.hermes/active_profile` | Current profile name |
| Auth store | `~/.hermes/auth.json` | OAuth tokens, provider credentials |
| Install stamp | `~/.hermes/.install_method` | "git", "docker", "pip", "nixos", "homebrew" |

All paths derive from `get_hermes_home()` (`hermes_constants.py:43`) which resolves `HERMES_HOME` env var → `~/.hermes`. Windows native uses `%LOCALAPPDATA%\hermes`.

### 3.2 Profiles

Complete `HERMES_HOME` isolation per named profile:
```
~/.hermes/profiles/coder/       # HERMES_HOME for "coder" profile
~/.hermes/profiles/assistant/   # HERMES_HOME for "assistant" profile
```
Profile detection logic in `get_default_hermes_root()` (`hermes_constants.py:104–140`). Subprocess spawners must propagate `HERMES_HOME` explicitly to avoid writing to the wrong profile (`hermes_constants.py:55–56`).

### 3.3 Config Loading

`load_config()` in `hermes_cli/config.py`:
- Reads `config.yaml` via `yaml.safe_load`, deep-merges with `DEFAULT_CONFIG` (`hermes_cli/config.py:738`).
- Caches per `(path, mtime_ns, size)` tuple (`hermes_cli/config.py:161`); thread-safe via `_CONFIG_LOCK` RLock (`hermes_cli/config.py:173`).
- Falls back to `DEFAULT_CONFIG` on YAML parse error (`hermes_cli/config.py:39–73`).

### 3.4 Config Domains (complete)

| Domain | Key example | Purpose |
|---|---|---|
| `model.*` | `model.provider`, `model.default` | Inference provider selection and model name |
| `providers.*` | Per-provider timeout overrides | `providers.anthropic.request_timeout_seconds` |
| `terminal.*` | `terminal.backend`, `terminal.timeout` | Execution backend and runtime limits |
| `agent.*` | `agent.max_turns` (90), `agent.reasoning_effort` | Agent loop behavior, tool enforcement |
| `compression.*` | `compression.threshold` (0.50) | Auto-compression triggers and targets |
| `memory.*` | `memory.nudge_interval` (10) | MEMORY.md/USER.md injection and flush policy |
| `session_reset.*` | `session_reset.mode` ("both") | Auto-reset on idle or daily schedule |
| `skills.*` | `skills.creation_nudge_interval` (15) | Skill creation prompts |
| `platform_toolsets.*` | `platform_toolsets.telegram: [hermes-telegram]` | Per-platform tool availability |
| `display.*` | `display.streaming`, `display.skin` | UI appearance and streaming behavior |
| `tts.*` / `stt.*` | `tts.provider`, `stt.local.model` | Voice input/output providers |
| `browser.*` | `browser.engine`, `browser.inactivity_timeout` | Browser automation settings |
| `mcp_servers.*` | Named MCP server definitions | External tool server connections |
| `delegation.*` | `delegation.max_concurrent_children` (3) | Subagent spawn limits and model overrides |
| `code_execution.*` | `code_execution.timeout` (300) | Python sandbox time and tool-call limits |
| `streaming.*` | `streaming.edit_interval` (0.3s) | Gateway streaming delivery config |
| `checkpoints.*` | `checkpoints.enabled`, `checkpoints.max_snapshots` | Filesystem snapshot policy |
| `hooks.*` | `hooks.pre_tool_call`, `hooks.post_llm_call` | Shell-script hooks on events |
| `security.*` | `security.tirith_enabled` | External command security scanner |
| `privacy.*` | `privacy.redact_pii` | PII redaction before LLM send |
| `dashboard.*` | OAuth gate for web dashboard | Web UI access control |
| `worktree` | `true/false` | Always create git worktree for concurrent agent sessions |

### 3.5 Security Denylist for `.env`

These env vars can never be written to `.env` by the wizard or dashboard (`hermes_cli/config.py:116–133`): `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PYTHONPATH`, `PYTHONHOME`, `NODE_OPTIONS`, `PATH`, `SHELL`, `BROWSER`, `EDITOR`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `HERMES_HOME`, `HERMES_PROFILE`, `HERMES_CONFIG`, `HERMES_ENV`.

---

## 4. Model Types

Hermes Agent uses five distinct categories of models:

### 4.1 Chat/Completion LLMs (Primary)

Every agent turn routes through one of four wire protocols (`api_mode`):
- **`chat_completions`** — OpenAI-compatible `/v1/chat/completions` (default for most providers)
- **`anthropic_messages`** — Anthropic SDK native (`client.messages.stream()`)
- **`codex_responses`** — OpenAI Responses API (Codex, xAI OAuth)
- **`bedrock_converse`** — AWS Bedrock `converse` / `converse_stream` via boto3

Source: `agent/chat_completion_helpers.py:184–230`, `agent/transports/base.py:1–65`

### 4.2 Speech-to-Text / Transcription

Six built-in STT providers in `BUILTIN_STT_PROVIDERS` (`tools/transcription_tools.py:233–240`):

| Provider | Key | Model |
|---|---|---|
| `local` | None | faster-whisper (tiny/base/small/medium/large-v3/turbo) |
| `local_command` | `HERMES_LOCAL_STT_COMMAND` | Arbitrary STT CLI |
| `groq` | `GROQ_API_KEY` | whisper-large-v3-turbo |
| `openai` | `OPENAI_API_KEY` | whisper-1 / gpt-4o-transcribe |
| `mistral` | `MISTRAL_API_KEY` | voxtral-mini-latest |
| `xai` | `XAI_API_KEY` | Grok STT (21 languages, diarization) |
| `elevenlabs` | `ELEVENLABS_API_KEY` | scribe_v2 |

### 4.3 Text-to-Speech

Ten built-in TTS providers in `BUILTIN_TTS_PROVIDERS` (`tools/tts_tool.py:357–368`):

| Provider | Key | Notes |
|---|---|---|
| `edge` | None | Microsoft Edge TTS — free default |
| `elevenlabs` | `ELEVENLABS_API_KEY` | Premium voices |
| `openai` | `VOICE_TOOLS_OPENAI_KEY` | OpenAI TTS |
| `minimax` | `MINIMAX_API_KEY` | Voice cloning |
| `mistral` | `MISTRAL_API_KEY` | Voxtral multilingual |
| `gemini` | `GEMINI_API_KEY` | 30 prebuilt voices |
| `xai` | `XAI_API_KEY` | Grok voice |
| `neutts` | None | On-device, free |
| `kittentts` | None | On-device, 25 MB model, free |
| `piper` | None | 44 languages, free, VITS |

### 4.4 Image Generation

Plugin-based ABC (`ImageGenProvider`) loaded from `plugins/image_gen/<name>/` (`agent/image_gen_provider.py:1–27`). Primary in-tree implementation uses FAL/Flux; exposed as the `image_generate` tool.

### 4.5 Video Generation

Plugin-based ABC (`VideoGenProvider`) at `plugins/video_gen/<name>/` (`agent/video_gen_provider.py:1–45`). One `video_generate` tool covers text-to-video and image-to-video.

### 4.6 Vision (Auxiliary)

Vision is a capability flag on chat LLMs. Non-vision models receive image content via a proxy `vision_analyze` tool call that routes to a dedicated auxiliary model (`run_agent.py:3764–3784`, `agent/image_routing.py`).

---

## 5. Model Configuration and Runtime Consumption

### 5.1 Provider Abstraction Design (Three Layers)

**Layer 1 — `ProviderProfile` (declarative dataclass)** (`providers/base.py:39–198`):
- `prepare_messages()` — per-provider message preprocessing
- `build_extra_body()` — provider-specific request fields
- `build_api_kwargs_extras()` — split extras between `extra_body` and top-level kwargs
- `fetch_models()` — live model list from REST endpoint
- `default_aux_model` — lightweight model for compression/vision tasks

**Layer 2 — Plugin discovery** (`providers/__init__.py:140–191`):
1. Bundled plugins: `plugins/model-providers/<name>/__init__.py`
2. User plugins: `$HERMES_HOME/plugins/model-providers/<name>/`
User plugins override bundled ones on name collision.

**Layer 3 — Transport** (`agent/transports/`):
One `ProviderTransport` subclass per `api_mode` (`chat_completions.py`, `anthropic.py`, `codex.py`, `bedrock.py`). Transports own message/tool format conversion; they do NOT own client construction or retries.

### 5.2 Supported Providers (29+ bundled)

| Slug | Auth | Notes |
|---|---|---|
| `nous` | OAuth device-code | `https://inference.nousresearch.com/v1` |
| `openrouter` | API key | 200+ models, session routing |
| `anthropic` | API key | Native SDK |
| `openai-codex` | OAuth/key | Responses API |
| `gemini` | OAuth/API key | Google AI |
| `bedrock` | AWS SDK | boto3 |
| `copilot` | OAuth | GitHub Copilot |
| `azure-foundry` | API key/Entra | Azure |
| `novita` | API key | default aux: deepseek-v3-0324 |
| `nvidia` | API key | NIM |
| `ollama-cloud` | API key | Ollama.com |
| `custom` | Any | Any OpenAI-compat endpoint |
| ... | ... | + minimax, kimi, huggingface, xiaomi, arcee, lmstudio, deepseek, etc. |

Source: `cli-config.yaml.example:12–39`, `plugins/model-providers/` directory

### 5.3 `hermes model` and In-Session Model Switching

`hermes model` CLI (`hermes_cli/main.py:2188`) runs an interactive TUI picker: provider → credentials → model → config persistence. Live model lists come from each provider's `fetch_models()` hook, falling back to `fallback_models` tuples.

The `/model` slash command (`hermes_cli/commands.py:125`) can switch models mid-session. `/model <name> --provider <slug>` switches both simultaneously; `/model --global` persists to `config.yaml`.

A fallback chain (`hermes_cli/fallback_config.py`) defines ordered provider+model pairs; on rate-limit or entitlement error, `_activate_fallback()` switches to the next entry.

### 5.4 API Call Path

The core dispatcher is `interruptible_api_call()` (`agent/chat_completion_helpers.py:125`), which runs the HTTP request in a background thread and polls with a stale-call detector.

Dispatch by `api_mode` (`agent/chat_completion_helpers.py:184–230`):
```
codex_responses    → agent._run_codex_stream()
anthropic_messages → agent._anthropic_messages_create()
bedrock_converse   → client.converse(**api_kwargs)
chat_completions   → request_client.chat.completions.create(**api_kwargs)
```

### 5.5 Streaming

`interruptible_streaming_api_call()` (`agent/chat_completion_helpers.py:1527`):
- `stream=True`, `stream_options={"include_usage": True}`
- Token deltas pass through `_stream_think_scrubber` (strips `<think>…</think>`) and `_stream_context_scrubber` (strips memory injection spans)
- `stream_delta_callback` connects to the TUI token renderer; `_stream_callback` connects to the streaming TTS pipeline

### 5.6 Tool-Calling Format

Tool schemas follow OpenAI function-calling format: `{"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}`. When the model returns `tool_calls`, the agent dispatches each via `model_tools.handle_function_call()` (`model_tools.py:802`).

Provider-specific sanitization before send:
- xAI: `strip_pattern_and_format()` removes JSON Schema fields causing 400s (`tools/schema_sanitizer.py`)
- Anthropic: re-serialized to `input_schema` format by `agent/transports/anthropic.py`
- Bedrock: converted by `agent/transports/bedrock.py`

### 5.7 Reasoning Config

- Nous Portal: `extra_body["reasoning"] = {"enabled": True, "effort": "medium"}`
- OpenRouter: `extra_body["reasoning"] = reasoning_config`
- Kimi: top-level `api_kwargs["reasoning_effort"]`

Source: `providers/base.py:112–130`, provider plugin files

---

## 6. User Interaction

### 6.1 Terminal UI (TUI)

The interactive TUI is a `prompt_toolkit` `Application` built inside `HermesCLI.run()` (`cli.py`).

**Input area** (constructed at `cli.py:13739`):
- `multiline=True` — Alt+Enter inserts newline; Enter submits
- `completer=SlashCommandCompleter(...)` — tab-completion for slash commands and `@file` paths
- `auto_suggest=SlashCommandAutoSuggest(...)` — ghost-text suggestion
- `history=FileHistory(...)` — persistent cross-session history
- `complete_while_typing=True` — live completions dropdown

**Shift/Ctrl+Enter** are aliased to Alt+Enter via `hermes_cli/pt_input_extras.py:82–84`. **Ctrl+G / Alt+G** opens the buffer in an external `$EDITOR`.

**Paste handling**: Large pastes are collapsed to a temp-file reference by two heuristics (`cli.py:13797–13830`).

**Busy input modes** (`display.busy_input_mode`):
- `interrupt` (default) — Enter while agent is running stops the current turn
- `queue` — Enter queues the message for the next turn  
- `steer` — Enter injects a mid-run steering message after the next tool call

Source: `cli.py:13739–13753`, `cli.py:2971–2980`

### 6.2 CLI Entry Points

| Subcommand | Purpose |
|---|---|
| `hermes` / `hermes chat` | Interactive TUI (default) |
| `hermes model` | Provider + model picker TUI |
| `hermes setup` | Interactive setup wizard |
| `hermes gateway [start|stop|status|install]` | Run/manage gateway service |
| `hermes cron [list|add|run|...]` | Manage scheduled tasks |
| `hermes auth [add|...]` | Credential management |
| `hermes skills [search|install|inspect|...]` | Skill management |
| `hermes doctor` | Configuration health check |
| `hermes sessions browse` | Interactive session picker |
| `hermes acp` | ACP server for editor integration |

`run_agent.py:main()` supports headless single-query use with `--model`, `--base-url`, `--api-key`, `--max-turns` flags (`run_agent.py:4600–4636`).

### 6.3 Slash Command System

`COMMAND_REGISTRY: list[CommandDef]` in `hermes_cli/commands.py:64–223` is the central registry. Each `CommandDef` carries name, aliases, category, subcommands, and `cli_only`/`gateway_only` availability flags.

The full registry includes 60+ commands: `quit/exit`, `help`, `profile`, `tools`, `toolsets`, `config`, `model`, `personality`, `retry`, `undo`, `branch`, `save`, `cron`, `skills`, `platforms`, `status`, `yolo`, `reasoning`, `compress`, `usage`, `insights`, `copy`, `image`, `browser`, `plugins`, `rollback`, `snapshot`, `stop`, `agents`, `background`, `queue`, `steer`, `voice`, and more.

**Autocomplete** (`SlashCommandCompleter`, `hermes_cli/commands.py:1185`): slash commands with trailing-space or no-space for picker commands, subcommand tab-completion, `@file` path completion with LRU caching.

### 6.4 Personalities

Named system-prompt overlays in `config.yaml` under `agent.personalities`. Default set (`cli.py:406–421`): `helpful`, `concise`, `technical`, `creative`, `teacher`, `kawaii`, `catgirl`, `pirate`, `shakespeare`, `surfer`, `noir`, `uwu`, `philosopher`, `hype`.

The `/personality <name>` command (`cli.py:7988`) resolves the value (string or `{system_prompt, tone, style}` dict), sets the system prompt, and reinitializes the agent.

**SOUL.md** (`agent/prompt_builder.py:1355–1380`): A Markdown file at `$HERMES_HOME/SOUL.md` is injected as slot #1 in the system prompt, overriding the default `DEFAULT_AGENT_IDENTITY`. AGENTS.md, CLAUDE.md, and `.hermes.md` in the working directory are also loaded as project context.

### 6.5 Core Agent Loop

`agent/conversation_loop.py:run_conversation()` (`line 351`) drives a single user turn:

1. Sanitize input (surrogate characters stripped)
2. System prompt cached in SQLite; restored on gateway (stateless) mode for Anthropic prefix caching
3. Preflight compression: if token estimate exceeds threshold, up to 3 compression passes run before the loop
4. Plugin hooks: `pre_llm_call` fired; plugins can inject context
5. **Main loop** `while api_call_count < max_iterations and budget.remaining > 0` (`line 796`):
   - Check `_interrupt_requested` — break if set
   - Drain pending `/steer` messages
   - Build `api_messages` and `api_kwargs`
   - Call `interruptible_streaming_api_call()` or `interruptible_api_call()`
   - Parse response: extract `tool_calls`, `content`, `reasoning`, `finish_reason`
   - If `tool_calls` → dispatch via `handle_function_call()`, append results, continue
   - If `finish_reason == "stop"` with no tool calls → break
6. Post-turn: emit response, fire `on_turn_complete` hooks, background memory/skill review

**Interrupt-and-redirect**: `_interrupt_requested` is checked every iteration and polled every 0.3s inside the HTTP call. When set, the HTTP connection is force-closed via TCP socket shutdown to avoid FD race conditions.

### 6.6 Voice Interaction

Voice mode toggled with `/voice on` or the configured push-to-talk key (default `Ctrl+B`):
- **Push-to-talk**: `start_recording()` / `stop_and_transcribe()` in `hermes_cli/voice.py`
- **Continuous VAD**: automatic silence detection via `start_continuous()` / `stop_continuous()`

User speech is transcribed and injected with a brevity prefix: `"[Voice input — respond concisely and conversationally, 2-3 sentences max. No code blocks or markdown.]"` (`cli.py:11965–11970`).

Streaming TTS (ElevenLabs) plays audio sentence-by-sentence as the agent generates tokens (`cli.py:11906–11956`).

---

## 7. Multi-terminal Interaction System

### 7.1 Gateway Architecture

The gateway is a single long-running Python asyncio process managed by `GatewayRunner` (`gateway/run.py:1676`). On startup, `start_gateway()` (`gateway/run.py:19043`) instantiates `GatewayRunner`, which iterates over every enabled platform in `GatewayConfig.platforms` and calls `_create_adapter()` (`gateway/run.py:6527`) for each. All live adapters are stored in `self.adapters: Dict[Platform, BasePlatformAdapter]` (`gateway/run.py:1704`). A single asyncio event loop services all platforms simultaneously.

### 7.2 Platform Registry

All platforms are identified by the `Platform` enum (`gateway/config.py:100–193`). Built-in members include `TELEGRAM`, `DISCORD`, `WHATSAPP`, `SLACK`, `SIGNAL`, `MATRIX`, `HOMEASSISTANT`, `EMAIL`, `SMS`, `DINGTALK`, `FEISHU`, `WECOM`, `BLUEBUBBLES`, `QQBOT`, and others. Plugin platforms are dynamically added via `Platform._missing_()` (`gateway/config.py:131–173`), which scans `plugins/platforms/` and the `PlatformRegistry`.

The `PlatformRegistry` (`gateway/platform_registry.py:162`) is a module-level singleton (`gateway/platform_registry.py:260`). Plugin adapters self-register by calling `ctx.register_platform()` in their `register(ctx)` entry point.

### 7.3 Platform Coverage

| Platform | Adapter | Transport |
|---|---|---|
| Telegram | `gateway/platforms/telegram.py` | Long polling (default) or webhook |
| Discord | `plugins/platforms/discord/adapter.py` | discord.py WebSocket |
| Slack | `gateway/platforms/slack.py` | Socket Mode (slack-bolt) |
| WhatsApp | `gateway/platforms/whatsapp.py` | Node.js bridge subprocess |
| Signal | `gateway/platforms/signal.py` | SSE from signal-cli HTTP daemon |
| Matrix | `gateway/platforms/matrix.py` | mautrix WebSocket |
| Home Assistant | `gateway/platforms/homeassistant.py` | HA WebSocket API |
| Email | `gateway/platforms/email.py` | IMAP polling + SMTP |
| SMS | `gateway/platforms/sms.py` | Twilio API |
| DingTalk / Feishu / WeCom | Respective adapter files | Platform SDKs |
| BlueBubbles (iMessage) | `gateway/platforms/bluebubbles.py` | REST/WebSocket bridge |
| Teams / IRC / Mattermost / Ntfy / SimplexChat / Google Chat / LINE | `plugins/platforms/*/` | Plugin adapters |

All inbound messages are normalized into a `MessageEvent` dataclass (`gateway/platforms/base.py:1289`) and routed to `GatewayRunner._handle_message()` (`gateway/run.py:4365`).

### 7.4 Setting Up a New Platform (Telegram Example)

1. **`hermes gateway setup`** (`hermes_cli/gateway.py:5434`): displays platform menu, calls `_configure_platform()` for each selection.

2. **Telegram setup** (`hermes_cli/gateway.py:3615–3648`): prompts to create bot via `@BotFather`, collect `TELEGRAM_BOT_TOKEN`, set `TELEGRAM_ALLOWED_USERS` (comma-separated numeric IDs), optionally set `TELEGRAM_HOME_CHANNEL`.

3. **Env vars stored** in `~/.hermes/.env`. On gateway start, `load_gateway_config()` (`gateway/config.py:695`) reads config.yaml then applies env overrides via `_apply_env_overrides()` (`gateway/config.py:1248`) — `telegram_config.token = telegram_token` (`gateway/config.py:1263–1266`).

**Polling vs. Webhook** (`gateway/platforms/telegram.py:1489`):
- **Long polling** (default): `start_polling()` — PTB opens outbound HTTPS to `api.telegram.org`
- **Webhook** (set `TELEGRAM_WEBHOOK_URL`): `start_webhook(port=..., url_path=..., webhook_url=..., secret_token=...)` (`gateway/platforms/telegram.py:1679–1688`)

Additional webhook env vars: `TELEGRAM_WEBHOOK_PORT` (default 8443), `TELEGRAM_WEBHOOK_SECRET` (HMAC verification, required).

**Slack**: Socket Mode with `SLACK_BOT_TOKEN` (`xoxb-...`) + `SLACK_APP_TOKEN` (`xapp-...`) — no inbound port needed.

**Signal**: Requires local `signal-cli daemon --http 127.0.0.1:8080`. Set `SIGNAL_HTTP_URL` and `SIGNAL_ACCOUNT` env vars. Adapter subscribes via SSE; sends via JSON-RPC 2.0 (`gateway/platforms/signal.py:1`).

**WhatsApp**: Node.js bridge subprocess (whatsapp-web.js or Baileys). QR-code scan for personal accounts.

**Home Assistant**: `HASS_TOKEN` (Long-Lived Access Token) + `HASS_URL` (default `http://homeassistant.local:8123`). Connects via HA WebSocket API, subscribes to `state_changed` events (`gateway/platforms/homeassistant.py:51`).

### 7.5 Conversation Continuity Across Platforms

Sessions are **platform-scoped** — a Telegram DM and a Slack DM from the same user are completely separate sessions; no cross-platform session merging exists.

Session key produced by `build_session_key()` (`gateway/session.py:600`):
- **DM**: `agent:main:{platform}:dm:{chat_id}`
- **Group**: `agent:main:{platform}:{chat_type}:{chat_id}[:{thread_id}][:{user_id}]` (depends on `group_sessions_per_user` and `thread_sessions_per_user` config flags)

`SessionStore` (`gateway/session.py:668`) maintains an in-memory `Dict[str, SessionEntry]` persisted to SQLite.

`build_session_context_prompt()` (`gateway/session.py:231`) assembles a system prompt section telling the agent: the source platform, all connected platforms with status, all configured home channels, and available `deliver=` options — giving the agent full awareness of the multi-platform topology.

**`/sethome`**: `_handle_set_home_command()` (`gateway/run.py:11563`) reads `source.platform` + `source.chat_id`, resolves the platform's home env var, calls `save_env_value(env_key, str(chat_id))`, and updates the live config in-memory without restart.

---

## 8. Cross-platform Notification Delivery

### 8.1 Cron Scheduler

The cron scheduler lives in `cron/scheduler.py`. The gateway calls `tick()` every 60 seconds from a background thread. `tick()` acquires a file-based lock at `~/.hermes/cron/.tick.lock` to prevent concurrent runs, then loads `~/.hermes/cron/jobs.json` and finds jobs whose `next_run` has passed.

Each job (`cron/jobs.py:39`):
- `id`, `name`, `prompt` (task description for the agent)
- `schedule` (cron expression, parsed by `croniter`)
- `deliver` — delivery target string (see below)
- `origin` — where the job was created (`{platform, chat_id, thread_id}`)

### 8.2 Delivery Target Resolution

The `deliver` field supports (`cron/scheduler.py:124–140`, `cron/scheduler.py:386–517`):
- `"local"` — save to `~/.hermes/cron/output/` only
- `"origin"` — send to the chat where the job was created
- `"telegram"` — send to `TELEGRAM_HOME_CHANNEL`
- `"telegram:123456789"` — explicit chat ID
- `"telegram:-100123:17"` — explicit chat + thread ID
- `"all"` — all platforms with a configured home channel
- Comma-separated combinations: `"origin,telegram"`

`_HOME_TARGET_ENV_VARS` (`cron/scheduler.py:124–140`) maps platform names to env var names:
```
"telegram"  → TELEGRAM_HOME_CHANNEL
"discord"   → DISCORD_HOME_CHANNEL
"slack"     → SLACK_HOME_CHANNEL
"signal"    → SIGNAL_HOME_CHANNEL
"matrix"    → MATRIX_HOME_ROOM
"email"     → EMAIL_HOME_ADDRESS
...
```

### 8.3 Actual Delivery (`_deliver_result()`, `cron/scheduler.py:618`)

1. **Live adapter path** (preferred): If the gateway is running in the same process, calls `runtime_adapter.send(chat_id, text, metadata)` via `safe_schedule_threadsafe()` (`cron/scheduler.py:726–773`). Required for E2EE platforms (Matrix).

2. **Standalone path** (fallback): Calls `_send_to_platform()` from `tools/send_message_tool.py` via `asyncio.run()` (`cron/scheduler.py:782–793`). Plugin platforms can register a `standalone_sender_fn` (`gateway/platform_registry.py:157–159`).

### 8.4 Media Delivery

Cron output `MEDIA:<path>` tags are extracted by `BasePlatformAdapter.extract_media()` and routed by `_send_media_via_adapter()` (`cron/scheduler.py:562`):
- Audio → `adapter.send_voice()` or `adapter.send_audio()`
- Video → `adapter.send_video()`
- Image → `adapter.send_image_file()`
- Other → `adapter.send_document()`

### 8.5 General Notification Abstraction

`DeliveryRouter` (`gateway/delivery.py:175`) is instantiated in `GatewayRunner.__init__()` (`gateway/run.py:1727`). Its `deliver()` coroutine (`gateway/delivery.py:195`) accepts `DeliveryTarget` objects and dispatches:
- `Platform.LOCAL` → writes markdown file to `~/.hermes/cron/output/`
- Any other platform → resolves the adapter and calls `send()`

**Silent output suppression**: Messages that are only a silence marker (`*(silent)*`, `🔇`, a bare `.`) are dropped pre-send (`gateway/delivery.py:30–50`).

**Cron wrapping** (`cron/scheduler.py:650–661`): Results are optionally wrapped with a `Cronjob Response: {task_name}` header including the job ID and a management tip. Set `cron.wrap_response: false` to disable.

---

## 9. System Permissions, Tools, and Security

### 9.1 Trust Model

Hermes Agent runs as a single-tenant personal agent inheriting whatever OS-level access the operator's user account has. This is the "trust envelope": the agent process can do anything the operator themselves can do (`SECURITY.md:44–47`).

**Key principle** (`SECURITY.md:59–66`): No in-process mechanism is a security boundary — only OS-level isolation (containers, sandboxes) constitutes real containment.

### 9.2 Terminal Backends — Access Scoping

Six backends selected via `TERMINAL_ENV` (`tools/terminal_tool.py:1038`):

#### Local
Commands run directly on the host as the OS user. The agent's access is the operator's full account access. Provider secrets are stripped from subprocess environments via a ~50-entry blocklist (`tools/environments/local.py:126–187`, `_HERMES_PROVIDER_ENV_BLOCKLIST`).

#### Docker
`--cap-drop ALL`, `--cap-add DAC_OVERRIDE,CHOWN,FOWNER`, `--security-opt no-new-privileges`, `--pids-limit 256`, tmpfs for `/tmp` (nosuid, 512MB) and `/var/tmp` (noexec, nosuid, 256MB) (`tools/environments/docker.py:324–333`, `_BASE_SECURITY_ARGS`). Containers are labeled `hermes-agent=1` for lifecycle management. An orphan reaper (`tools/environments/docker.py:138–227`) removes stale containers from prior crashed processes.

**Crucially**: all dangerous-command approval checks (including the hardline blocklist) are bypassed for Docker, Singularity, Modal, and Daytona backends (`tools/approval.py:940–941`). The rationale: destructive commands inside the container cannot touch the host filesystem.

#### SSH
OpenSSH ControlMaster for connection reuse (`tools/environments/ssh.py:83–98`), `StrictHostKeyChecking=accept-new`, `BatchMode=yes`, `ControlPersist=300s`. Access bounded by the SSH user's permissions on the remote host. A `FileSyncManager` syncs `~/.hermes` config files to the remote (`tools/environments/ssh.py:72–79`).

#### Singularity
`--containall` (isolates home, tmp, other paths) and `--no-home` (prevents mounting host home dir) (`tools/environments/singularity.py:1–7`). Designed for HPC environments.

#### Modal
`modal.Sandbox.create()` / `modal.Sandbox.exec()` in Modal's cloud infrastructure — completely isolated from the operator's host. Resource limits (CPU, memory, disk) configurable (`tools/terminal_tool.py:1108–1111`). A "managed Modal" variant routes through the Nous Tool Gateway when direct credentials are unavailable.

#### Daytona
Daytona Python SDK wraps blocking SDK calls in a `_ThreadedProcessHandle`. Memory capped at 10 GB (`tools/environments/daytona.py:79–83`). Persistent sandboxes preserve filesystem state across sessions.

### 9.3 Toolset Architecture

**`_HERMES_CORE_TOOLS`** (`toolsets.py:31–73`): the 40+ tools available on every platform — the single source of truth. Updating this list updates all platforms simultaneously.

**`_HERMES_WEBHOOK_SAFE_TOOLS`** (`toolsets.py:75–83`): a restricted 4-tool set (`web_search`, `web_extract`, `vision_analyze`, `clarify`) for untrusted webhook payloads. The comment explains: "Webhook events may originate from untrusted third-party content (e.g., public PR titles/comments). Keep constrained to avoid local file/system execution by prompt injection."

Tools self-register via `tools/registry.py` at import time; `discover_builtin_tools()` in `model_tools.py:1–36` triggers discovery. Runtime definition assembly: `model_tools.get_tool_definitions()` (`model_tools.py:264–334`) resolves toolsets through `resolve_toolset()` and filters by `check_fn`.

### 9.4 System and Programming Tools

**Shell execution** (`tools/terminal_tool.py`):
1. Validates command and `workdir` character allowlist (`tools/terminal_tool.py:271–293`)
2. Runs dangerous command guards (`check_all_command_guards` from `tools/approval.py`)
3. Dispatches to the backend via `env.execute(command, ...)`
4. Local backend: spawns `bash -c <command>` as subprocess

**File tools** (`tools/file_tools.py`): `read_file` (max 100K chars), `write_file`, `patch` (fuzzy-matched), `search_files`. All route through `ShellFileOperations` which delegates to the same backend as `terminal` — file operations in Docker/Modal/SSH/Singularity run inside that backend's environment.

**Code execution** (`tools/code_execution_tool.py`): The `execute_code` tool lets the LLM write Python scripts that call Hermes tools programmatically via RPC:
- **Local (UDS)**: Unix domain socket; parent creates RPC listener, child tool calls travel back over UDS.
- **Remote (file-based RPC)**: Parent ships `hermes_tools.py` stubs to the remote; tool calls written as files, polled by parent, results written back as response files.
- **Env scrubbing**: All `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `PASSWD`, `AUTH`, `DSN`, `WEBHOOK` substrings stripped from child env (`tools/code_execution_tool.py:87–100`).
- **Tool sandboxing**: Only 7 tools available inside execute_code: `web_search`, `web_extract`, `read_file`, `write_file`, `search_files`, `patch`, `terminal` (`tools/code_execution_tool.py:61–68`, `SANDBOX_ALLOWED_TOOLS`).

**MCP Integration** (`tools/mcp_tool.py`): Connects to external MCP servers via stdio, HTTP/StreamableHTTP, or SSE. MCP servers are spawned as subprocesses with provider secrets stripped from their env; all async operations run on a dedicated `_mcp_loop` background thread. MCP tools are registered into the Hermes tool registry as first-class tools. MCP servers can initiate LLM requests back through Hermes (sampling), gated by per-server config. MCP stderr redirected to `~/.hermes/logs/mcp-stderr.log` to prevent TUI corruption.

`mcp_serve.py`: The inverse direction — exposes Hermes's own message conversations as an MCP server (10 tools: `conversations_list`, `messages_read`, `messages_send`, `events_poll`, `permissions_respond`, etc.) for MCP clients like Claude Code (`mcp_serve.py:1–28`).

### 9.5 Security Mechanisms

#### Command Approval (3 Layers)

**Layer 1 — Hardline unconditional blocklist** (`tools/approval.py:203–225`, `HARDLINE_PATTERNS`):
Fires before YOLO, before `mode=off`, before any bypass:
- `rm -rf /` and variants targeting `/home`, `/root`, `/etc`, `/usr`, `/var`, `/bin`, `/sbin`, `/boot`
- `mkfs` (filesystem format), `dd` to raw block devices
- Fork bomb (`: () { : | : & } ; :`)
- `kill -1` (kill all processes)
- `shutdown`, `reboot`, `halt`, `poweroff`, `init 0/6`, `systemctl poweroff/reboot`

**Layer 2 — 47 dangerous-command regexes** (`tools/approval.py:321–427`, `DANGEROUS_PATTERNS`):
Covers: recursive delete, dangerous `chmod`/`chown`, SQL DROP/DELETE/TRUNCATE, writes to `/etc/`, system service restarts, force-kill, pipe-to-shell (`curl | sh`), writes to `.ssh`/shell RC files/credential files/`.env`, `xargs rm`, `find -delete`, git force push, docker lifecycle commands, sudo privilege-escalation flags.

Unicode normalization (NFKC) and ANSI strip applied before matching to defeat obfuscation (`tools/approval.py:464–479`).

**Layer 3 — Smart approval via aux LLM** (`tools/approval.py:878–922`, `_smart_approve`): When `approvals.mode=smart`, the aux LLM assesses command risk before prompting the user: APPROVE / DENY / ESCALATE.

**Approval scopes** (`tools/approval.py:795–813`): `once`, `session` (stored in `_session_approved`), or `always` (permanently added to `command_allowlist` in config.yaml).

**YOLO mode**: Frozen at import time to prevent skills from setting `HERMES_YOLO_MODE` mid-session (`tools/approval.py:29`). YOLO bypasses Layer 2 but NOT the hardline blocklist (Layer 1) or sudo stdin guard.

**Gateway approval**: Agent thread blocks on a `threading.Event` while approval request is forwarded to the user over the platform. User responds `/approve` or `/deny`. Silence is treated as denial (`tools/approval.py:1338–1361`: "Silence is not consent").

#### DM Pairing System (`gateway/pairing.py`)

Controls which users on messaging platforms can send commands to the agent. An unknown user receives an 8-character one-time pairing code that the bot owner must approve via the CLI.

Security features:
- **8-char codes from a 32-char unambiguous alphabet** (no `0/O/1/I`), cryptographically generated via `secrets.choice()` (`gateway/pairing.py:39–41, 236`)
- **SHA-256 with random 16-byte salt** before storage; plaintext codes never touch disk (`gateway/pairing.py:200–202`)
- **1-hour code expiry** (`CODE_TTL_SECONDS = 3600`, `gateway/pairing.py:45`)
- **Max 3 pending codes per platform** (`MAX_PENDING_PER_PLATFORM = 3`, `gateway/pairing.py:50`)
- **Rate limiting: 1 request per user per 10 minutes** (`RATE_LIMIT_SECONDS = 600`, `gateway/pairing.py:46`)
- **Lockout after 5 failed attempts for 1 hour** (`MAX_FAILED_ATTEMPTS = 5`, `gateway/pairing.py:51`)
- **File permissions: `0o600`** on all data files (`gateway/pairing.py:70`)
- **Atomic file writes** via temp-file + rename (`gateway/pairing.py:55–78`, `_secure_write`)

#### Slash Command Access Control (`gateway/slash_access.py`)

Two-tier authorization layered on top of pairing:
- `allow_admin_from` — user IDs with access to all slash commands
- `user_allowed_commands` — specific commands non-admin users may run
- `_ALWAYS_ALLOWED_FOR_USERS = {"help", "whoami"}` — always accessible regardless of gating (`gateway/slash_access.py:50–52`)

#### Container Isolation

**Docker** (`tools/environments/docker.py`):
- All capabilities dropped except `DAC_OVERRIDE`, `CHOWN`, `FOWNER`
- `no-new-privileges` prevents capability escalation
- `--pids-limit 256`, nosuid/noexec tmpfs mounts
- Labels for lifecycle management

**Singularity**: `--containall`, `--no-home` (`tools/environments/singularity.py:1–7`)

**Whole-process wrapping** (`SECURITY.md:91–113`): Two documented hardening postures:
1. Hermes Docker image + Compose setup
2. NVIDIA OpenShell — per-session sandboxes with declarative policy for filesystem, network (L7 egress), process/syscall, and inference-routing

**Network egress isolation** (`docs/security/network-egress-isolation.md`): Optional Docker Compose override with two networks: `internal` (no internet, agent) and `egress` (internet, gateway). Recommends an HTTP proxy (e.g., Squid) with an allowlist of LLM and messaging API endpoints.

#### Tirith Security Scanner (`tools/tirith_security.py`)

External binary performing content-level scanning for: homograph URLs, pipe-to-interpreter patterns, terminal injection, and other content-level threats. Exit code 0=allow, 1=block, 2=warn. Auto-downloaded from GitHub releases with SHA-256 checksum verification and optional `cosign` supply-chain provenance verification (`tools/tirith_security.py:17–20`). When tirith findings exist, the `[a]lways` permanent allowlist option is suppressed.

#### Path Security, Skills Guard, Credential File Protection

- **Path traversal** (`tools/path_security.py`): `Path.resolve().relative_to()` used across skill management, cronjob tools, credential files.
- **Skills guard** (`tools/skills_guard.py`): Scans installable skill content for injection patterns before installation. Explicitly not a security boundary — "a review aid."
- **Credential files protection**: Dangerous-command detection targets writes to `~/.netrc`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, `~/.hermes/.env`, `~/.ssh/` (`tools/approval.py:132–159`).

#### Tool-call Loop Guardrails (`agent/tool_guardrails.py`)

Pure controller tracking per-turn tool-call patterns: exact failure warn after 2 identical failed calls, same-tool failure halt after 8, no-progress block after 5. Hard stops opt-in (`hard_stop_enabled: False` by default) to avoid interrupting legitimate long-running work.

#### SECURITY.md Policy Summary

| Scope | What it says |
|---|---|
| **In scope** | OS isolation escape, unauthorized external surface access, credential exfiltration, trust-model documentation violations |
| **Out of scope** | Bypasses of in-process heuristics, prompt injection per se, consequences of chosen posture, documented break-glass settings, third-party skills/plugins |

---

## 10. Cross-validation

*External research performed via tavily-search on 2026-06-07. All 9 claims CONFIRMED — no contradictions found.*

| Claim | Verdict | Key external evidence |
|---|---|---|
| MCP — background event loop integration | **CONFIRMED** | Linux Foundation-hosted open protocol; async-native SDK makes background event loop the standard pattern. [modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification) |
| agentskills.io — real open standard, SKILL.md format | **CONFIRMED** | Originally Anthropic-authored (late 2025); adopted by OpenAI Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, and 20+ others. Spec at agentskills.io. |
| Telegram polling/webhook — `getUpdates` vs `setWebhook` | **CONFIRMED** | Official Telegram Bot API FAQ: "it's not possible to get updates via long polling while an outgoing Webhook is set." The two modes are mutually exclusive by API design. |
| Honcho — "dialectic user modeling" (Plastic Labs) | **CONFIRMED** | Real product; "dialectic" is Plastic Labs' own terminology (archived blog post explains it). honcho.dev explicitly lists Hermes as an integration target with `hermes honcho setup`. |
| Modal — serverless, scale-to-zero | **CONFIRMED** | Python-native serverless; dedicated "Sandboxes" product for agent code execution; functions scale to zero when idle. |
| Daytona — cloud sandbox, hibernates when idle | **CONFIRMED** (with nuance) | Originally "Development Environment Manager" (2024); now markets as AI agent sandbox infrastructure (Daytona's current GitHub description). Configurable auto-stop behavior confirmed. |
| Singularity `--containall --no-home` — HPC isolation | **CONFIRMED** | Official Apptainer docs: `--no-home` prevents host $HOME mount; `--containall` additionally creates in-memory /tmp and /var/tmp. Together they constitute the described HPC-style isolation. |
| faster-whisper — CTranslate2 reimplementation of Whisper | **CONFIRMED** | SYSTRAN/faster-whisper GitHub README states this verbatim; up to 4x faster, lower memory. Cited by Modal, WhisperX as canonical efficient Whisper backend. |
| prompt_toolkit — multiline editing, autocomplete, key bindings | **CONFIRMED** | Standard Python TUI library; official readthedocs lists exactly: multi-line input, completion (`complete_while_typing`), custom KeyBindings. Used by IPython, pgcli, mycli. |
| s6-overlay in Docker — multi-process supervision | **CONFIRMED** | just-containers/s6-overlay GitHub; runs as PID 1, proper signal forwarding, zombie reaping. Production adoption: Home Assistant's entire Docker ecosystem. |

**Source references:** modelcontextprotocol.io, agentskills.io, core.telegram.org, honcho.dev, modal.com, github.com/daytonaio/daytona, apptainer.org, github.com/SYSTRAN/faster-whisper, python-prompt-toolkit.readthedocs.io, github.com/just-containers/s6-overlay

---

## Citation Summary

This report draws exclusively from the following primary sources:

**Codebase files** (key references):
- `README.md` — overview, install one-liners, feature matrix
- `SECURITY.md` — security policy, trust model, scope
- `hermes_constants.py` — path resolution, profile detection
- `hermes_cli/setup.py` — wizard implementation (2835+ lines)
- `hermes_cli/config.py` — config loading, DEFAULT_CONFIG, managed-install detection
- `hermes_cli/doctor.py` — diagnostic checks
- `hermes_cli/gateway.py` — gateway CLI, platform setup flows
- `hermes_cli/commands.py` — COMMAND_REGISTRY, SlashCommandCompleter
- `hermes_cli/voice.py` — voice mode API
- `cli.py` — HermesCLI TUI (~11k LOC)
- `run_agent.py` — AIAgent class (~12k LOC)
- `cli-config.yaml.example` — complete config reference
- `scripts/install.sh`, `scripts/install.ps1` — installers
- `Dockerfile`, `flake.nix`, `pyproject.toml` — build/packaging
- `agent/conversation_loop.py` — agent loop
- `agent/chat_completion_helpers.py` — API dispatch, streaming
- `agent/transports/*.py` — per-api_mode transport adapters
- `providers/base.py`, `providers/__init__.py`, `plugins/model-providers/*/` — provider abstraction
- `tools/terminal_tool.py`, `tools/environments/*.py` — terminal backends
- `tools/approval.py` — command approval system (3 layers)
- `tools/code_execution_tool.py` — RPC Python sandbox
- `tools/mcp_tool.py`, `mcp_serve.py` — MCP integration
- `toolsets.py`, `model_tools.py`, `tools/registry.py` — toolset system
- `gateway/run.py` — GatewayRunner
- `gateway/config.py` — Platform enum, GatewayConfig
- `gateway/platform_registry.py` — PlatformRegistry
- `gateway/platforms/*.py` — per-platform adapters
- `gateway/pairing.py` — DM pairing security
- `gateway/slash_access.py` — command access control
- `gateway/delivery.py` — DeliveryRouter
- `gateway/session.py` — session key, session store
- `cron/scheduler.py`, `cron/jobs.py` — scheduler and delivery
- `docs/security/network-egress-isolation.md` — egress isolation architecture
- `plugins/platforms/*/` — plugin platform adapters
