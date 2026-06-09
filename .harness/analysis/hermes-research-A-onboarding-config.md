# Hermes Agent Research — Part A: Onboarding & Installation & Configuration

---

## 1. Onboarding Flow

### 1.1 What Triggers Onboarding

Onboarding is triggered automatically at the end of the install script (unless `--skip-setup` is passed to `install.sh` or `install.ps1`). Specifically, the shell script calls `hermes setup` as the final step. A user can also invoke it manually at any time:

```
hermes setup              # full wizard (auto-detects first-run vs. reconfigure)
hermes setup --portal     # one-shot Nous Portal OAuth login + Tool Gateway
hermes setup model        # only model/provider section
hermes setup terminal     # only terminal backend section
hermes setup gateway      # only messaging platforms section
hermes setup tools        # only tool configuration section
hermes setup agent        # only agent behavior section
hermes setup tts          # only TTS provider section
```

The wizard entry point is `run_setup_wizard()` in `hermes_cli/setup.py:2835`.

### 1.2 Non-Interactive Detection

The very first thing the wizard does is check `is_interactive_stdin()` (`hermes_cli/setup.py:2881`). If no TTY is detected (headless SSH, Docker, CI/CD), it prints a non-interactive guidance message and exits cleanly rather than hanging on `input()` (`hermes_cli/setup.py:2884-2888`). In headless mode, users are directed to use `hermes config set` or environment variables directly.

### 1.3 OpenClaw Migration (First-Time Only)

Before any configuration prompts appear on a first-time install, the wizard calls `_offer_openclaw_migration()` (`hermes_cli/setup.py:3003`). This:

1. Checks for `~/.openclaw/` on disk.
2. Runs a dry-run via the `openclaw-migration` optional skill to preview what would be imported.
3. Shows items categorized as: would-import, would-overwrite, would-skip.
4. Explicitly warns about high-impact items (gateway tokens, config semantic differences, instruction files containing OpenClaw-specific procedures) via `_HIGH_IMPACT_KIND_KEYWORDS` (`hermes_cli/setup.py:2498-2509`).
5. Executes migration only after explicit user confirmation.

What gets imported: SOUL.md, MEMORY.md, USER.md entries, user-created skills (→ `~/.hermes/skills/openclaw-imports/`), command allowlist, messaging settings and tokens, selected API keys, TTS assets. (Documented in `README.md:157-170`.)

### 1.4 First-Time Setup Mode Choice

After the migration check, first-time users see (`hermes_cli/setup.py:3007-3010`):

```
How would you like to set up Hermes?
  1. Quick Setup (Nous Portal) — OAuth login, model & messaging (recommended)
  2. Full setup — configure everything
```

**Quick Setup path** (`_run_first_time_quick_setup()`, `hermes_cli/setup.py:3062`):
1. Nous Portal OAuth device-code login via `_model_flow_nous()`.
2. Terminal backend selection.
3. Applies recommended agent defaults silently.
4. Optionally sets up a messaging gateway.

**Full Setup path**: runs all six sections in sequence (`hermes_cli/setup.py:3031-3059`).

### 1.5 `hermes setup --portal` One-Shot Flow

`_run_portal_one_shot()` (`hermes_cli/setup.py:2723`) is a minimal onboarding path that:
1. Calls `auth_add_command()` with `provider="nous", auth_type="oauth"` for device-code OAuth.
2. Sets `model.provider = "nous"` in `config.yaml`.
3. Calls `prompt_enable_tool_gateway()` to ask if the user wants to route web/image/TTS/browser via their Nous subscription.

This is wired to `hermes setup --portal` (`README.md:96`).

### 1.6 What Each Setup Section Collects and Why

#### Section 1 — Model & Provider (`setup_model_provider()`, `hermes_cli/setup.py:692`)

Delegates to `select_provider_and_model()` which runs the same flow as `hermes model`. Information collected:

| Information | Env Var / Config Key | Why Needed |
|---|---|---|
| Provider choice | `config.yaml: model.provider` | Determines which API endpoint, auth scheme, and wire format to use |
| API key | `~/.hermes/.env: <PROVIDER>_API_KEY` | Authenticates LLM API calls — without it no inference works |
| Base URL | `config.yaml: model.base_url` | Needed for custom/local endpoints; cloud providers use their defaults |
| Model name | `config.yaml: model.default` | The LLM that handles all conversations and agent turns |

Credentials for each provider are saved to `~/.hermes/.env` via `save_env_value()` (`hermes_cli/setup.py:975`, `989`, `1011`, etc.).

#### Section 1b — TTS Provider (`_setup_tts_provider()`, `hermes_cli/setup.py:886`)

| Information | Env Var | Why Needed |
|---|---|---|
| TTS provider choice | `config.yaml: tts.provider` | Controls which voice engine produces audio in CLI and messaging |
| ElevenLabs API key | `ELEVENLABS_API_KEY` | Unlocks premium ElevenLabs voices |
| OpenAI API key (for TTS) | `VOICE_TOOLS_OPENAI_KEY` | Unlocks OpenAI TTS (separate from main inference key) |
| xAI OAuth or API key | `XAI_API_KEY` | Unlocks xAI/Grok TTS voices |
| xAI voice_id | `config.yaml: tts.xai.voice_id` | Sets specific Grok voice for TTS |
| MiniMax API key | `MINIMAX_API_KEY` | Unlocks MiniMax high-quality voices with voice cloning |
| Mistral API key | `MISTRAL_API_KEY` | Unlocks Mistral Voxtral multilingual TTS |
| Gemini API key | `GEMINI_API_KEY` | Unlocks Google Gemini 30-voice TTS |

Edge TTS is the default (free, cloud-based, no API key required). NeuTTS and KittenTTS are local on-device options that require no API key but install Python packages and optional system packages (espeak-ng).

#### Section 2 — Terminal Backend (`setup_terminal_backend()`, `hermes_cli/setup.py:1132`)

Determines where the agent runs shell commands. Options and what they collect:

| Backend | Info Collected | Why |
|---|---|---|
| `local` | Nothing beyond the choice | Commands run on the host; access to local filesystem |
| `docker` | docker_image (defaults to `nikolaik/python-nodejs:python3.11-nodejs20`) | Isolated container for reproducibility and security |
| `modal` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` (`hermes_cli/setup.py:1306-1316`) | Authenticates serverless cloud sandbox execution |
| `daytona` | `DAYTONA_API_KEY` (`hermes_cli/setup.py:1362-1365`) | Authenticates persistent cloud dev environment |
| `ssh` | `TERMINAL_SSH_HOST`, `TERMINAL_SSH_USER`, `TERMINAL_SSH_PORT`, `TERMINAL_SSH_KEY` (`hermes_cli/setup.py:1377-1398`) | SSH credentials to run commands on a remote machine |
| `singularity` | singularity_image | HPC-safe container runtime on Linux only |

Backend choice is also synced to `TERMINAL_ENV` in `.env` (`hermes_cli/setup.py:1422`) so the terminal tool reads it directly.

#### Section 3 — Agent Settings (`setup_agent_settings()`, `hermes_cli/setup.py:1463`)

| Information | Config Key | Why Needed |
|---|---|---|
| Max tool-calling iterations | `agent.max_turns` (default 90) | Caps how many tool calls the agent can make per turn — affects cost and completeness |
| Tool progress display mode | `display.tool_progress` (off/new/all/verbose) | Controls how verbose the UI is during tool use |
| Compression threshold | `compression.threshold` (0.50–0.95) | When (% of context used) to auto-compress old messages |
| Session reset mode | `session_reset.mode` (both/idle/daily/none) | Messaging sessions grow indefinitely without resets, increasing cost |
| Idle timeout | `session_reset.idle_minutes` (default 1440) | Auto-reset after inactivity window |
| Daily reset hour | `session_reset.at_hour` (default 4) | Daily midnight-style reset |

The wizard applies all defaults silently for first installs via `_apply_default_agent_settings()` (`hermes_cli/setup.py:1435-1460`).

#### Section 4 — Messaging Platforms (`setup_gateway()`, `hermes_cli/setup.py:2056`)

A checklist lets users select which platforms to configure. Each platform section collects:

**Telegram** (`_setup_telegram()`, `hermes_cli/setup.py:1640`):

| Information | Env Var | Why |
|---|---|---|
| Bot token | `TELEGRAM_BOT_TOKEN` | Authentication for the Telegram Bot API |
| Allowed user IDs | `TELEGRAM_ALLOWED_USERS` | Security: restrict who can talk to the bot (comma-separated numeric IDs) |
| Home channel ID | `TELEGRAM_HOME_CHANNEL` | Where cron job results and cross-platform notifications are delivered |

**Slack** (`_setup_slack()`, `hermes_cli/setup.py:1711`):

| Information | Env Var | Why |
|---|---|---|
| Bot token | `SLACK_BOT_TOKEN` | Authenticates with Slack's API (xoxb-...) |
| App-level token | `SLACK_APP_TOKEN` | Enables Socket Mode for real-time event reception (xapp-...) |
| Allowed user IDs | `SLACK_ALLOWED_USERS` | Security: restrict by Slack member ID |
| Home channel | `SLACK_HOME_CHANNEL` | Delivery target for cron and notifications (C-prefixed channel ID) |

The setup also writes a Slack app manifest (`slack-manifest.json`) to HERMES_HOME so users can paste it into `api.slack.com/apps` instead of manually clicking through scopes (`hermes_cli/setup.py:1789-1814`).

**Matrix** (`_setup_matrix()`, `hermes_cli/setup.py:1822`):

| Information | Env Var | Why |
|---|---|---|
| Homeserver URL | `MATRIX_HOMESERVER` | The Matrix server endpoint |
| Access token | `MATRIX_ACCESS_TOKEN` | Bot authentication (preferred) |
| User ID + Password | `MATRIX_USER_ID`, `MATRIX_PASSWORD` | Fallback auth if no token |
| E2EE opt-in | `MATRIX_ENCRYPTION` | End-to-end encryption support (requires mautrix[encryption]) |
| Allowed user IDs | `MATRIX_ALLOWED_USERS` | Security allowlist |
| Home room | `MATRIX_HOME_ROOM` | Notification delivery target |

**BlueBubbles** (`_setup_bluebubbles()`, `hermes_cli/setup.py:1938`):

| Information | Env Var | Why |
|---|---|---|
| Server URL | `BLUEBUBBLES_SERVER_URL` | Local Mac server bridging iMessage |
| Server password | `BLUEBUBBLES_PASSWORD` | Auth to the BlueBubbles server |
| Allowed iMessage addresses | `BLUEBUBBLES_ALLOWED_USERS` | Security allowlist |
| Home channel | `BLUEBUBBLES_HOME_CHANNEL` | Notification delivery |

After any messaging platform is configured, the wizard offers to install and start the gateway as a system service (systemd on Linux, launchd on macOS, Scheduled Task on Windows) (`hermes_cli/setup.py:2222-2272`).

#### Section 5 — Tools (`setup_tools()`, `hermes_cli/setup.py:2296`)

Delegates to `tools_command()` in `hermes_cli/tools_config.py`. Collects API keys for optional tool backends: web search (EXA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, SEARXNG_URL, PARALLEL_API_KEY), image generation (FAL_KEY), browser automation (BROWSERBASE_API_KEY, BROWSER_USE_API_KEY, CAMOFOX_URL), and sets TTS provider API keys.

### 1.7 `hermes doctor`

Defined in `hermes_cli/doctor.py`. Checks performed include:

- Python version consistency between `pyproject.toml` and `hermes_cli/__init__.py` (`hermes_cli/doctor.py:207-258`).
- Presence of provider env var credentials — checks for all providers in `_PROVIDER_ENV_HINTS` (`hermes_cli/doctor.py:31-54`).
- API connectivity test for each configured provider.
- Tool availability: loads toolsets and reports which are available vs. unavailable with missing-key hints.
- Systemd linger status for the gateway service (`hermes_cli/doctor.py:309-350`).
- s6-overlay supervision state inside Docker containers (`hermes_cli/doctor.py:261-306`).
- Honcho user modeling plugin state (`hermes_cli/doctor.py:105-113`).

Doctor runs without modifying any config — it is purely diagnostic.

### 1.8 Post-Setup Summary

After full setup, `_print_setup_summary()` (`hermes_cli/setup.py:356-638`) prints:
- Tool availability summary (which of: Vision, Mixture of Agents, Web Search, Browser Automation, Image Generation, TTS, Modal Execution, Smart Home, Spotify, Skills Hub are available).
- File locations: `config.yaml`, `.env`, and subdirectories.
- Quick-reference commands for reconfiguring.

---

## 2. Installation

### 2.1 Linux, macOS, WSL2 (`scripts/install.sh`)

**One-liner:**
```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

The installer (`scripts/install.sh`) performs the following stages in order:

1. **OS detection** (`detect_os()`, `scripts/install.sh:422`): Detects linux/macos/android-termux; rejects CYGWIN/MINGW (redirects to PowerShell installer).

2. **Install layout resolution** (`resolve_install_layout()`, `scripts/install.sh:345`):
   - Non-root users: code at `$HERMES_HOME/hermes-agent` (~/.hermes/hermes-agent), `hermes` symlink in `~/.local/bin`.
   - Root on Linux: FHS layout — code at `/usr/local/lib/hermes-agent`, command at `/usr/local/bin/hermes`. Python managed by uv under `/usr/local/share/uv/python` (world-readable for non-root subprocesses, `scripts/install.sh:374`).
   - Termux: code at `$HERMES_HOME/hermes-agent`, command in `$PREFIX/bin`.

3. **uv installation** (`install_uv()`, `scripts/install.sh:463`): Downloads and runs `https://astral.sh/uv/install.sh`. Falls back to `~/.local/bin/uv` or `~/.cargo/bin/uv` if already present. Not used on Termux.

4. **Python 3.11 provisioning** (`check_python()`, `scripts/install.sh:547`): Uses `uv python install 3.11`. On Termux uses `pkg install python`. Includes FTS5 probing (`ensure_fts5()`, `scripts/install.sh:644`) — if the resolved Python's SQLite lacks FTS5, it escalates through: reinstall with current uv → `uv self update` then reinstall → install fresh standalone uv from `astral.sh`. FTS5 is required for full-text session search.

5. **Git provisioning** (`check_git()`, `scripts/install.sh:757`): Checks for git; if missing, auto-installs via Homebrew/xcode-select (macOS), apt/dnf/pacman (Linux), or `pkg install git` (Termux).

6. **Repository clone**: `git clone $REPO_URL_HTTPS $INSTALL_DIR` on main branch (or `--branch` argument).

7. **Virtual environment creation**: `uv venv .venv --python 3.11` inside the install directory. Termux uses `python -m venv .venv`.

8. **Python dependencies**: `uv pip install -e ".[all]"` (all optional extras). On Termux: `pip install -e ".[termux]" -c constraints-termux.txt`.

9. **Node.js**: The script installs Node.js (version 22) for the browser tool (agent-browser npm package).

10. **Playwright browser**: Installs Chromium via `npx playwright install chromium` unless `--skip-browser` is passed.

11. **System tools**: Installs `ripgrep` (for file search tool) and `ffmpeg` (for voice/audio processing).

12. **PATH setup**: Creates `hermes` symlink in the command-link directory. Adds that directory to `~/.bashrc` / `~/.zshrc` / `~/.bash_profile`.

13. **Hermes home init**: Creates `~/.hermes/` with subdirectories (`cron/`, `sessions/`, `logs/`, `memories/`, `skills/`, etc.) via `ensure_hermes_home()` (`hermes_cli/config.py:685`). Seeds `SOUL.md` with the default persona.

14. **Install method stamp**: Writes `git` to `~/.hermes/.install_method` (`hermes_cli/config.py:323`).

15. **Setup wizard**: Runs `hermes setup` unless `--skip-setup` is passed.

### 2.2 Windows Native (`scripts/install.ps1`)

**One-liner (PowerShell):**
```powershell
iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)
```

Key differences from the shell installer:

- **Install location**: `%LOCALAPPDATA%\hermes\hermes-agent` (`scripts/install.ps1:27`). `HERMES_HOME` defaults to `%LOCALAPPDATA%\hermes`.
- **Git**: Detects existing Git; if absent, downloads MinGit (~45MB portable Git to `%LOCALAPPDATA%\hermes\git`) without requiring admin rights (`README.md:49`).
- **Architecture detection**: Uses `Get-WindowsArch()` (`scripts/install.ps1:125`) via `Win32_Processor.Architecture` CIM rather than `PROCESSOR_ARCHITECTURE` env var, to correctly detect ARM64 through Prism x64 emulation on Snapdragon hardware.
- **Node.js 22**: Downloaded as a standalone zip to `%LOCALAPPDATA%\hermes\nodejs`.
- **ripgrep / ffmpeg**: Downloaded as standalone Windows binaries.
- **Python deps**: `uv pip install -e ".[all]"` (same extras as Linux).
- **PATH**: Adds `%LOCALAPPDATA%\hermes\bin` to user-level PATH via `[Environment]::SetEnvironmentVariable`.
- **Stage protocol**: The installer supports a `-Manifest` / `-Stage` / `-Json` protocol for driving installation from a GUI wizard (the signed Hermes-Setup.exe Tauri bootstrap installer).

### 2.3 Termux (Android)

Termux uses the same `scripts/install.sh` (curl one-liner), which detects Termux via `TERMUX_VERSION` env var or `com.termux/files/usr` in `PREFIX` (`hermes_constants.py:324-331`).

Key differences:
- `uv` is not used; Termux uses Python's stdlib `venv` + `pip`.
- Python is installed via `pkg install python` if missing.
- Git is installed via `pkg install git`.
- Install extra is `.[termux]` not `.[all]` — excludes voice dependencies incompatible with Android (faster-whisper, Matrix E2EE).
- Pinned by `constraints-termux.txt`: `ipython<10`, `jedi>=0.18.1,<0.20`, `pexpect>4.3,<5`, etc.
- Command is symlinked to `$PREFIX/bin/hermes` (already on PATH in Termux).

### 2.4 Docker

**Official image**: `nousresearch/hermes-agent` (pull: `docker pull nousresearch/hermes-agent:latest`)

**Dockerfile** (`Dockerfile:1-10`):
- Base image: `debian:13.4`.
- System packages: `ca-certificates curl ripgrep ffmpeg gcc python3 python-is-python3 python3-dev libffi-dev procps git openssh-client docker-cli xz-utils` (`Dockerfile:26-29`).
- Process supervisor: s6-overlay v3.2.3.0 (multi-arch: amd64/arm64), SHA256-verified (`Dockerfile:51-80`). s6-overlay's `/init` is PID 1, supervising `main-hermes`, `dashboard`, and per-profile gateways.
- Node.js 22 copied from `node:22-bookworm-slim`.
- uv copied from `ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie`.
- `HERMES_HOME` defaults to `/opt/data` (bind-mounted volume for persistence).
- `PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright` — outside the volume so browsers survive overlay at runtime (`Dockerfile:17`).
- `docker-compose.yml` and `docker-compose.windows.yml` available in the repo for orchestrated deployments.

### 2.5 Nix / NixOS

**flake.nix** (`flake.nix:1-45`):
- Inputs: nixpkgs (unstable), flake-parts, pyproject-nix, uv2nix, pyproject-build-systems, npm-lockfile-fix.
- Supported systems: x86_64-linux, aarch64-linux, aarch64-darwin.
- Modules imported: `nix/packages.nix`, `nix/overlays.nix`, `nix/nixosModules.nix`, `nix/checks.nix`, `nix/devShell.nix`.

A NixOS module (`services.hermes-agent`) is provided for declarative system configuration. Managed installs are detected via `HERMES_MANAGED=nix` or the presence of `~/.hermes/.managed` (`hermes_cli/config.py:254`). In managed mode, `hermes setup` and `hermes update` are blocked with instructions to use `nixos-rebuild switch` instead (`hermes_cli/config.py:440-466`). Config is set via `services.hermes-agent.settings` in `configuration.nix`.

### 2.6 Dev / Contributor Setup

```bash
git clone https://github.com/NousResearch/hermes-agent.git
cd hermes-agent
./setup-hermes.sh     # installs uv, creates .venv, installs .[all], symlinks ~/.local/bin/hermes
```

Equivalent manual path (`README.md:192-197`):
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install -e ".[all,dev]"
scripts/run_tests.sh
```

### 2.7 Homebrew

Homebrew installation is supported (`brew upgrade hermes-agent`). Managed mode is detected via `HERMES_MANAGED=homebrew` or `HERMES_MANAGED=brew` (`hermes_cli/config.py:237-242`). Config modifications via the wizard are blocked; the user is directed to use `brew upgrade hermes-agent`.

---

## 3. Configuration

### 3.1 Config File Locations

| File | Path | Purpose |
|---|---|---|
| Main config | `~/.hermes/config.yaml` | All non-secret settings |
| Secrets | `~/.hermes/.env` | API keys, bot tokens, passwords |
| Persona | `~/.hermes/SOUL.md` | Agent identity and system prompt extensions |
| Active profile | `~/.hermes/active_profile` | Name of current active profile |
| Install method stamp | `~/.hermes/.install_method` | "git", "docker", "pip", "nixos", "homebrew" |
| Managed marker | `~/.hermes/.managed` | Presence = NixOS/Homebrew managed install |
| Slack manifest | `~/.hermes/slack-manifest.json` | Generated Slack app manifest |
| Auth store | `~/.hermes/auth.json` | OAuth tokens, provider credentials |

All paths derive from `get_hermes_home()` (`hermes_constants.py:43`) which resolves `HERMES_HOME` env var → `~/.hermes`. Windows native uses `%LOCALAPPDATA%\hermes`.

### 3.2 HERMES_HOME Resolution

Defined in `hermes_constants.py:43-101`:

1. Context-local override (`_HERMES_HOME_OVERRIDE` ContextVar) — for in-process per-task scoping.
2. `HERMES_HOME` environment variable.
3. `~/.hermes` default.

A one-shot warning is emitted to stderr if `HERMES_HOME` is unset but `active_profile` indicates a non-default profile is active (`hermes_constants.py:79-99`).

### 3.3 Config Loading

`load_config()` in `hermes_cli/config.py`:
- Reads `~/.hermes/config.yaml` via `yaml.safe_load`.
- Deep-merges with `DEFAULT_CONFIG` (`hermes_cli/config.py:738`).
- Expands env vars referenced in values.
- Normalizes certain fields (model string → dict, etc.).
- Caches result per `(path, mtime_ns, size)` tuple (`hermes_cli/config.py:161`).
- Thread-safe via `_CONFIG_LOCK` RLock (`hermes_cli/config.py:173`).
- On YAML parse error, falls back to `DEFAULT_CONFIG` and emits a warning once per `(path, mtime_ns, size)` to stderr and `errors.log` (`hermes_cli/config.py:39-73`).

### 3.4 Config File Structure (`cli-config.yaml.example`)

The full example config is in `cli-config.yaml.example`. Below is a complete domain-by-domain breakdown.

#### `model:` — Inference Provider

```yaml
model:
  default: "anthropic/claude-opus-4.6"   # Default model name
  provider: "auto"                         # Provider selection (see list below)
  api_key: ""                              # Optional inline key
  base_url: "https://openrouter.ai/api/v1" # API endpoint
  context_length: 131072                   # Manual context window override
  max_tokens: 8192                         # Max output tokens per response
  auth_mode: "entra_id"                    # Azure keyless auth mode
```

Provider values (`cli-config.yaml.example:15-40`): `"auto"`, `"openrouter"`, `"nous"`, `"nous-api"`, `"anthropic"`, `"openai-codex"`, `"copilot"`, `"gemini"`, `"zai"`, `"kimi-coding"`, `"kimi-coding-cn"`, `"minimax"`, `"minimax-cn"`, `"huggingface"`, `"nvidia"`, `"xiaomi"`, `"arcee"`, `"ollama-cloud"`, `"kilocode"`, `"azure-foundry"`, `"lmstudio"`, `"custom"` (aliases: `"ollama"`, `"vllm"`, `"llamacpp"`).

#### `providers:` — Named Provider Overrides

```yaml
providers:
  ollama-local:
    request_timeout_seconds: 300
    stale_timeout_seconds: 900
  anthropic:
    request_timeout_seconds: 30
    models:
      claude-opus-4.6:
        timeout_seconds: 600
```

Controls per-provider and per-model timeouts (`cli-config.yaml.example:93-104`).

#### `terminal:` — Execution Backend

Key fields (from `DEFAULT_CONFIG` at `hermes_cli/config.py:847-926`):

| Key | Default | Purpose |
|---|---|---|
| `backend` | `"local"` | Execution environment: local, ssh, docker, singularity, modal, daytona |
| `cwd` | `"."` | Working directory (host path for local/ssh; container path for docker/modal) |
| `timeout` | `180` | Command timeout in seconds |
| `docker_image` | `"nikolaik/python-nodejs:python3.11-nodejs20"` | Docker image for container backend |
| `modal_image` | `"nikolaik/python-nodejs:python3.11-nodejs20"` | Modal sandbox image |
| `singularity_image` | `"docker://nikolaik/..."` | Singularity/Apptainer image |
| `daytona_image` | `"nikolaik/..."` | Daytona sandbox image |
| `container_cpu` | `1` | CPU cores for container backends |
| `container_memory` | `5120` | Memory in MB |
| `container_disk` | `51200` | Disk in MB |
| `container_persistent` | `true` | Persist filesystem across sessions |
| `docker_volumes` | `[]` | Host:container volume mounts |
| `docker_forward_env` | `[]` | Env vars to forward from host into container |
| `docker_env` | `{}` | Explicit key-value env vars to set inside container |
| `docker_extra_args` | `[]` | Extra `docker run` flags |
| `docker_mount_cwd_to_workspace` | `false` | Mount launch cwd to /workspace (security opt-in) |
| `docker_run_as_host_user` | `false` | Run container as host uid:gid |
| `ssh_host/user/port/key` | | SSH connection params |
| `modal_mode` | `"auto"` | "auto", "managed" (Nous sub), "direct" (own account) |
| `shell_init_files` | `[]` | Extra shell files to source for environment snapshot |
| `auto_source_bashrc` | `true` | Auto-source ~/.bashrc / ~/.profile for tool env |
| `persistent_shell` | `true` | Keep long-lived bash across execute() calls (non-local) |
| `sudo_password` | — | Pipe password via `sudo -S` (plaintext warning applies) |
| `lifetime_seconds` | `300` | Session lifetime |
| `env_passthrough` | `[]` | Additional env vars to pass to sandboxed execution |

#### `agent:` — Agent Behavior

| Key | Default | Purpose |
|---|---|---|
| `max_turns` | `90` | Max tool-calling iterations per conversation |
| `gateway_timeout` | `1800` | Inactivity timeout for gateway runs (seconds) |
| `gateway_timeout_warning` | `900` | Warning threshold before full timeout |
| `restart_drain_timeout` | `180` | Graceful drain on gateway stop/restart |
| `api_max_retries` | `3` | App-level API retry attempts |
| `clarify_timeout` | `600` | Max wait for user clarification response |
| `gateway_notify_interval` | `180` | "Still working" notification interval (seconds) |
| `verbose` | `false` | Verbose logging |
| `reasoning_effort` | `"medium"` | Thinking depth: "xhigh", "high", "medium", "low", "minimal", "none" |
| `personalities` | (preset dict) | Named personality presets for /personality command |
| `tool_use_enforcement` | `"auto"` | Force model to call tools: "auto", true, false, or model-name list |
| `task_completion_guidance` | `true` | Inject "finish the job" prompt guidance |
| `environment_probe` | `true` | Probe local Python/pip/uv state for system prompt |
| `environment_hint` | `""` | Embedder-supplied environment description |
| `image_input_mode` | `"auto"` | How user images reach the model: "auto", "native", "text" |
| `disabled_toolsets` | `[]` | Toolsets to exclude from all platforms |
| `service_tier` | `""` | OpenAI service tier |
| `gateway_auto_continue_freshness` | `3600` | Max age of interrupted-turn marker before ignoring |

#### `compression:` — Context Compression

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Auto-compress when context fills |
| `threshold` | `0.50` | Compress when prompt_tokens ≥ X% of context_length |
| `target_ratio` | `0.20` | Fraction of threshold to preserve as recent tail |
| `protect_last_n` | `20` | Recent messages to always keep verbatim |
| `protect_first_n` | `3` | Head (non-system) messages to always keep |
| `abort_on_summary_failure` | `false` | Abort compression vs. insert placeholder on aux LLM failure |
| `hygiene_hard_message_limit` | `400` | Force-compress gateway sessions at this message count |

#### `memory:` — Persistent Memory

| Key | Default | Purpose |
|---|---|---|
| `memory_enabled` | `true` | Inject MEMORY.md into system prompt |
| `user_profile_enabled` | `true` | Inject USER.md user profile |
| `memory_char_limit` | `2200` | Max characters for agent memory (~800 tokens) |
| `user_char_limit` | `1375` | Max characters for user profile (~500 tokens) |
| `nudge_interval` | `10` | Remind agent to save memories every N user turns |
| `flush_min_turns` | `6` | Min turns to trigger memory flush on exit/reset |

#### `session_reset:` — Auto-Reset Policy

| Key | Default | Purpose |
|---|---|---|
| `mode` | `"both"` | "both" (idle+daily), "idle", "daily", "none" |
| `idle_minutes` | `1440` | Inactivity timeout in minutes (24h) |
| `at_hour` | `4` | Daily reset hour 0–23 local time |

`group_sessions_per_user: true` — messaging group chats get per-user session isolation (`cli-config.yaml.example:521`).

#### `skills:` — Skills System

| Key | Default | Purpose |
|---|---|---|
| `creation_nudge_interval` | `15` | Remind agent to save skills every N tool iterations |
| `external_dirs` | `[]` | Read-only external skill directories shared across tools |

#### `platform_toolsets:` — Per-Platform Tools

Assigns toolset presets or custom lists per platform (`cli-config.yaml.example:664-675`):
```yaml
platform_toolsets:
  cli: [hermes-cli]
  telegram: [hermes-telegram]
  discord: [hermes-discord]
  # etc.
```

Individual toolsets: `web`, `search`, `terminal`, `file`, `browser`, `vision`, `image_gen`, `skills`, `skills_hub`, `moa`, `todo`, `tts`, `cronjob`, `memory`, `session_search`. Presets: `hermes-cli`, `hermes-telegram`, `hermes-discord`, `hermes-whatsapp`, `hermes-slack`, `hermes-signal`, `hermes-homeassistant`, `hermes-qqbot`.

#### `display:` — UI Settings

| Key | Default | Purpose |
|---|---|---|
| `compact` | `false` | Compact single-line banner vs. full ASCII art |
| `tool_progress` | `"all"` | Tool activity verbosity: "off", "new", "all", "verbose" |
| `skin` | `"default"` | UI theme (built-ins: default, ares, mono, slate, daylight, warm-lightmode, poseidon, sisyphus, charizard; or custom YAML in `~/.hermes/skins/`) |
| `streaming` | `true` | Stream tokens as they arrive |
| `show_reasoning` | `false` | Show model reasoning/thinking box |
| `busy_input_mode` | `"interrupt"` | What Enter does when agent is busy: "interrupt", "queue", "steer" |
| `bell_on_complete` | `false` | Terminal bell when agent finishes |
| `cleanup_progress` | `false` | Delete progress bubbles after successful turn (Telegram) |
| `interim_assistant_messages` | `true` | Send mid-turn assistant updates as separate messages |
| `long_running_notifications` | `true` | Periodic "still working" heartbeats |
| `busy_ack_detail` | `true` | Show iteration/tool detail in busy acks |
| `background_process_notifications` | `"all"` | Verbosity for background process completion |

#### `tts:` — Text-to-Speech

```yaml
tts:
  provider: "edge"    # "edge", "elevenlabs", "openai", "xai", "minimax", "mistral", "gemini", "neutts", "kittentts"
```

Provider-specific sub-keys (e.g., `tts.xai.voice_id`) set during `hermes setup tts`.

#### `stt:` — Speech-to-Text

```yaml
stt:
  enabled: true
  local:
    model: "base"        # tiny | base | small | medium | large-v3 | turbo
  openai:
    model: "whisper-1"   # whisper-1 | gpt-4o-mini-transcribe | gpt-4o-transcribe
```

(`cli-config.yaml.example:821-831`)

#### `browser:` — Browser Tool

| Key | Default | Purpose |
|---|---|---|
| `inactivity_timeout` | `120` | Seconds before auto-closing idle browser session |
| `command_timeout` | `30` | Per-command timeout (screenshot, navigate, etc.) |
| `record_sessions` | `false` | Auto-record sessions as WebM |
| `allow_private_urls` | `false` | Allow navigation to private IPs |
| `engine` | `"auto"` | "auto", "lightpanda" (fast, no screenshots), "chrome" |
| `auto_local_for_private_urls` | `true` | Auto-spawn local Chromium for LAN URLs when cloud provider is set |
| `cdp_url` | `""` | Persistent CDP endpoint to attach to existing Chrome |
| `dialog_policy` | `"must_respond"` | How to handle JS dialogs: "must_respond", "auto_dismiss", "auto_accept" |
| `camofox.*` | | Camofox Firefox bridge settings |

#### `mcp_servers:` — MCP Server Definitions

```yaml
mcp_servers:
  time:
    command: uvx
    args: ["mcp-server-time"]
  notion:
    url: https://mcp.notion.com/mcp
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_..."
    timeout: 120          # tool call timeout (default: 120)
    connect_timeout: 60   # initial connection timeout (default: 60)
    sampling:
      enabled: true
      model: "gemini-3-flash"
      max_tokens_cap: 4096
```

(`cli-config.yaml.example:785-813`)

#### `delegation:` — Subagent Config

| Key | Default | Purpose |
|---|---|---|
| `max_iterations` | `50` | Max tool turns per child agent |
| `max_concurrent_children` | `3` | Max parallel child agents |
| `max_spawn_depth` | `1` | Delegation tree depth cap (1–3) |
| `orchestrator_enabled` | `true` | Enable role="orchestrator" children |
| `subagent_auto_approve` | `false` | Auto-approve dangerous commands in subagents |
| `model` | `""` | Override model for subagents (empty = inherit) |
| `provider` | `""` | Override provider for subagents |

#### `code_execution:` — Python Sandbox

```yaml
code_execution:
  timeout: 300        # max seconds per script
  max_tool_calls: 50  # max RPC tool calls per execution
```

#### `streaming:` — Gateway Streaming

```yaml
streaming:
  enabled: false
  transport: edit
  edit_interval: 0.3
  buffer_threshold: 40
  cursor: " ▉"
```

#### `checkpoints:` — Filesystem Snapshots

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Auto-snapshot before destructive file ops |
| `max_snapshots` | `20` | Max checkpoints per working directory |
| `max_total_size_mb` | `500` | Hard ceiling on `~/.hermes/checkpoints/` size |
| `max_file_size_mb` | `10` | Skip files larger than this when staging |
| `auto_prune` | `true` | Auto-sweep orphans and stale checkpoints |
| `retention_days` | `7` | Max age of retained checkpoints |
| `delete_orphans` | `true` | Remove entries for deleted working dirs |
| `min_interval_hours` | `24` | Minimum sweep interval |

#### `hooks:` — Shell-Script Hooks

```yaml
hooks:
  pre_tool_call:
    - matcher: "terminal"
      command: "~/.hermes/agent-hooks/block-rm-rf.sh"
      timeout: 10
  post_tool_call:
    - matcher: "write_file|patch"
      command: "~/.hermes/agent-hooks/auto-format.sh"
hooks_auto_accept: false
```

Valid events: `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `pre_api_request`, `post_api_request`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`, `subagent_stop` (`cli-config.yaml.example:1098-1101`).

#### Other Top-Level Keys

| Key | Purpose |
|---|---|
| `worktree: true/false` | Always create git worktree for isolated concurrent agent sessions |
| `web.backend/search_backend/extract_backend` | Web tool backend selection |
| `tool_output.max_bytes/max_lines/max_line_length` | Tool output truncation thresholds |
| `tool_loop_guardrails.*` | Soft warning / hard-stop thresholds for repeated tool failures |
| `prompt_caching.cache_ttl` | Anthropic prompt cache TTL: "5m" or "1h" |
| `openrouter.response_cache/response_cache_ttl` | OpenRouter edge response caching |
| `provider_routing.*` | OpenRouter routing strategy (sort, only, ignore, order, data_collection) |
| `model_aliases.*` | Short aliases for /model command |
| `privacy.redact_pii` | Strip phone numbers and hash IDs before sending to model |
| `security.tirith_enabled/path/timeout/fail_open` | Pre-exec command security scanning |
| `dashboard.oauth.client_id/portal_url/public_url` | Web dashboard OAuth gate |
| `group_sessions_per_user: true` | Per-user session isolation in group chats |
| `honcho: {}` | Honcho user modeling overrides |
| `file_read_max_chars: 100_000` | Max chars per read_file call |

### 3.5 Environment Variables

#### Runtime/Process (not stored in `.env`)

| Env Var | Purpose |
|---|---|
| `HERMES_HOME` | Override Hermes home directory — single most important runtime var |
| `HERMES_MANAGED` | Declare managed install: "nix", "nixos", "brew", "homebrew", "true" |
| `HERMES_OPTIONAL_SKILLS` | Override optional-skills directory path (`hermes_constants.py:166`) |
| `HERMES_OPTIONAL_MCPS` | Override optional-mcps directory path (`hermes_constants.py:185`) |
| `HERMES_BUNDLED_SKILLS` | Override bundled skills directory path (`hermes_constants.py:205`) |
| `HERMES_QUIET` | Suppress startup messages — set to "1" by `cli.py:50` |
| `HERMES_UID` / `HERMES_GID` | Docker UID/GID for ownership of created directories (`hermes_cli/config.py:542`) |
| `HERMES_HOME_MODE` | chmod mode for HERMES_HOME (default: 0700, e.g., "0701" for nginx traversal) |
| `HERMES_CONTAINER` / `HERMES_SKIP_CHMOD` | Skip chown/chmod in container deployments |
| `HERMES_DEV` | Development mode flag (disables container-mode exec) |
| `HERMES_ACCEPT_HOOKS` | Auto-accept shell-script hooks in non-interactive runs |
| `TERMINAL_ENV` | Terminal backend (synced from config.yaml by setup) |
| `TERMINAL_MODAL_MODE` | Modal execution mode |
| `UV_NO_CONFIG` | Set to 1 by installer to prevent uv from reading wrong configs |
| `TERMUX_VERSION` | Detected by `is_termux()` — set by Termux automatically |

#### API Keys (stored in `~/.hermes/.env`)

**Inference providers:**
`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_TOKEN`, `NOUS_API_KEY`, `GLM_API_KEY` / `ZAI_API_KEY` / `Z_AI_API_KEY`, `KIMI_API_KEY`, `KIMI_CN_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`, `KILOCODE_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `HF_TOKEN`, `NVIDIA_API_KEY`, `XIAOMI_API_KEY`, `ARCEEAI_API_KEY`, `OPENCODE_ZEN_API_KEY`, `OPENCODE_GO_API_KEY`, `GMI_API_KEY`, `STEPFUN_API_KEY`, `TOKENHUB_API_KEY`

**Tools:**
`EXA_API_KEY`, `PARALLEL_API_KEY`, `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL`, `TAVILY_API_KEY`, `SEARXNG_URL`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `VOICE_TOOLS_OPENAI_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `GROQ_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `DAYTONA_API_KEY`, `TERMINAL_SSH_HOST`, `TERMINAL_SSH_USER`, `TERMINAL_SSH_PORT`, `TERMINAL_SSH_KEY`, `CAMOFOX_URL`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `BROWSER_USE_API_KEY`, `GITHUB_TOKEN`, `HASS_TOKEN`

**Messaging platforms:**
All defined in `_EXTRA_ENV_KEYS` frozenset (`hermes_cli/config.py:176-225`): `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SIGNAL_ACCOUNT`, `SIGNAL_HTTP_URL`, `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`, `MATRIX_PASSWORD`, `BLUEBUBBLES_SERVER_URL`, `BLUEBUBBLES_PASSWORD`, `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `WECOM_BOT_ID`, `WECOM_SECRET`, `WEIXIN_ACCOUNT_ID`, `WEIXIN_TOKEN`, `QQ_APP_ID`, `QQ_CLIENT_SECRET`, `IRC_SERVER`, `IRC_PORT`, etc.

**Security denylist** — these env vars can never be written to `.env` via the wizard or dashboard (`hermes_cli/config.py:116-133`): `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PYTHONPATH`, `PYTHONHOME`, `NODE_OPTIONS`, `PATH`, `SHELL`, `BROWSER`, `EDITOR`, `VISUAL`, `PAGER`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `HERMES_HOME`, `HERMES_PROFILE`, `HERMES_CONFIG`, `HERMES_ENV`.

### 3.6 Profiles

Profiles provide complete isolation between multiple Hermes instances. Each profile is a separate `HERMES_HOME`:

```
~/.hermes/profiles/coder/          # HERMES_HOME for "coder" profile
~/.hermes/profiles/assistant/      # HERMES_HOME for "assistant" profile
~/.hermes/active_profile           # contains active profile name
```

Profile detection logic in `get_default_hermes_root()` (`hermes_constants.py:104-140`): if `HERMES_HOME` is a path whose parent is named `profiles/`, the grandparent is the root (for profile listing). Docker profiles: `/opt/data/profiles/<name>`.

Subprocess spawners must propagate `HERMES_HOME` explicitly to avoid writing to the wrong profile — documented as issue #18594 and warned about in `get_hermes_home()` (`hermes_constants.py:55-56`). A per-profile `home/` subdirectory (`hermes_constants.py:296`) can isolate subprocess configs (git identity, SSH keys, `gh` tokens) inside the data volume.

### 3.7 Hermes Home Directory Structure

Created by `ensure_hermes_home()` (`hermes_cli/config.py:685-709`):

```
~/.hermes/
├── config.yaml          # main settings
├── .env                 # API keys and secrets
├── SOUL.md              # agent persona
├── active_profile       # current profile name
├── .install_method      # "git", "docker", "pip", "nixos", "homebrew"
├── .managed             # marker for NixOS/Homebrew managed install
├── auth.json            # OAuth tokens
├── MEMORY.md            # agent's persistent memory
├── USER.md              # user profile
├── cron/                # scheduled task definitions
├── sessions/            # conversation session store (SQLite FTS5)
├── logs/                # agent.log, errors.log, session trajectories
│   └── curator/         # memory curator logs
├── memories/            # additional memory files
├── pairing/             # messaging platform pairing tokens
├── hooks/               # shell-script hook allowlists
├── image_cache/         # cached vision images
├── audio_cache/         # cached TTS audio
├── skills/              # user-created and imported skills
├── skins/               # custom UI themes
├── checkpoints/         # filesystem snapshot git repos
├── slack-manifest.json  # generated Slack app manifest
└── profiles/            # named profile subdirectories (optional)
    └── <name>/
        └── (same structure as root)
```

---

## Citation Index

| Reference | File and Line(s) |
|---|---|
| Quick Install one-liner (Linux) | `README.md:36` |
| Quick Install one-liner (Windows) | `README.md:46` |
| MinGit Windows detail | `README.md:49` |
| `hermes setup --portal` | `README.md:96` |
| OpenClaw migration what gets imported | `README.md:162-170` |
| `hermes_constants.py:get_hermes_home()` | `hermes_constants.py:43-101` |
| HERMES_HOME env var resolution | `hermes_constants.py:63-65` |
| active_profile fallback warning | `hermes_constants.py:75-99` |
| `get_default_hermes_root()` profile detection | `hermes_constants.py:104-140` |
| `get_config_path()` | `hermes_constants.py:390-395` |
| `get_env_path()` | `hermes_constants.py:404-407` |
| `get_optional_skills_dir()` / env vars | `hermes_constants.py:160-175` |
| `get_optional_mcps_dir()` | `hermes_constants.py:177-193` |
| `get_bundled_skills_dir()` | `hermes_constants.py:196-213` |
| `is_termux()` detection | `hermes_constants.py:324-331` |
| `is_wsl()` detection | `hermes_constants.py:337-352` |
| `is_container()` detection | `hermes_constants.py:357-383` |
| `get_subprocess_home()` profile isolation | `hermes_constants.py:277-301` |
| `apply_ipv4_preference()` / network.force_ipv4 | `hermes_constants.py:412-451` |
| `DEFAULT_CONFIG` start | `hermes_cli/config.py:738` |
| `DEFAULT_CONFIG agent` section | `hermes_cli/config.py:744-845` |
| `DEFAULT_CONFIG terminal` section | `hermes_cli/config.py:847-926` |
| `DEFAULT_CONFIG compression` | `hermes_cli/config.py:1055-1078` |
| `DEFAULT_CONFIG checkpoints` | `hermes_cli/config.py:983-1010` |
| `DEFAULT_CONFIG tool_output` | `hermes_cli/config.py:1031-1035` |
| `DEFAULT_CONFIG tool_loop_guardrails` | `hermes_cli/config.py:1040-1053` |
| Env var denylist (`_ENV_VAR_NAME_DENYLIST`) | `hermes_cli/config.py:116-133` |
| `_EXTRA_ENV_KEYS` frozenset (messaging env vars) | `hermes_cli/config.py:176-225` |
| Config parse warning logic | `hermes_cli/config.py:39-73` |
| Config cache (mtime/size) | `hermes_cli/config.py:161` |
| `_CONFIG_LOCK` thread safety | `hermes_cli/config.py:173` |
| `ensure_hermes_home()` dir structure | `hermes_cli/config.py:685-709` |
| `_ensure_default_soul_md()` | `hermes_cli/config.py:676-682` |
| `detect_install_method()` / stamp | `hermes_cli/config.py:283-320` |
| `stamp_install_method()` | `hermes_cli/config.py:323-329` |
| Managed install detection | `hermes_cli/config.py:244-257` |
| `_HERMES_UID` / `_HERMES_GID` Docker | `hermes_cli/config.py:542-568` |
| `HERMES_HOME_MODE` override | `hermes_cli/config.py:608-629` |
| NixOS / Homebrew managed errors | `hermes_cli/config.py:440-470` |
| `run_setup_wizard()` entry point | `hermes_cli/setup.py:2835` |
| Non-interactive detection | `hermes_cli/setup.py:2881` |
| Non-interactive guidance | `hermes_cli/setup.py:2884-2888` |
| Portal one-shot path check | `hermes_cli/setup.py:2891-2893` |
| `_run_portal_one_shot()` | `hermes_cli/setup.py:2723` |
| OpenClaw migration offer | `hermes_cli/setup.py:3003` |
| First-time setup mode choice | `hermes_cli/setup.py:3007-3010` |
| Quick Setup path | `hermes_cli/setup.py:3062` |
| Full setup section sequence | `hermes_cli/setup.py:3031-3059` |
| `SETUP_SECTIONS` definition | `hermes_cli/setup.py:2713-2720` |
| Config backup before setup | `hermes_cli/setup.py:2864-2877` |
| `setup_model_provider()` | `hermes_cli/setup.py:692` |
| `_setup_tts_provider()` | `hermes_cli/setup.py:886` |
| TTS provider options list | `hermes_cli/setup.py:910-928` |
| NeuTTS install flow | `hermes_cli/setup.py:946-967` |
| ElevenLabs key prompt | `hermes_cli/setup.py:969-979` |
| xAI TTS auth choices | `hermes_cli/setup.py:998-1044` |
| `setup_terminal_backend()` | `hermes_cli/setup.py:1132` |
| Terminal backend options | `hermes_cli/setup.py:1145-1166` |
| Modal token prompts | `hermes_cli/setup.py:1306-1316` |
| Daytona API key prompt | `hermes_cli/setup.py:1362-1365` |
| SSH fields prompts | `hermes_cli/setup.py:1377-1398` |
| TERMINAL_ENV sync to .env | `hermes_cli/setup.py:1422` |
| `_apply_default_agent_settings()` | `hermes_cli/setup.py:1435-1460` |
| `setup_agent_settings()` | `hermes_cli/setup.py:1463` |
| Max iterations prompt | `hermes_cli/setup.py:1480-1494` |
| Tool progress prompt | `hermes_cli/setup.py:1505-1514` |
| Compression threshold prompt | `hermes_cli/setup.py:1525-1532` |
| Session reset prompt | `hermes_cli/setup.py:1560-1631` |
| `_setup_telegram()` | `hermes_cli/setup.py:1640` |
| Telegram token validation | `hermes_cli/setup.py:1665-1672` |
| Telegram allowlist | `hermes_cli/setup.py:1681-1688` |
| Telegram home channel | `hermes_cli/setup.py:1695-1708` |
| `_setup_slack()` | `hermes_cli/setup.py:1711` |
| Slack manifest write | `hermes_cli/setup.py:1789-1814` |
| `_setup_matrix()` | `hermes_cli/setup.py:1822` |
| `_setup_bluebubbles()` | `hermes_cli/setup.py:1938` |
| `setup_gateway()` main | `hermes_cli/setup.py:2056` |
| Gateway service install offer | `hermes_cli/setup.py:2222-2272` |
| `setup_tools()` delegation | `hermes_cli/setup.py:2296-2308` |
| `_print_setup_summary()` | `hermes_cli/setup.py:356` |
| Tool availability summary categories | `hermes_cli/setup.py:379-575` |
| File locations in summary | `hermes_cli/setup.py:598-609` |
| `_HIGH_IMPACT_KIND_KEYWORDS` migration | `hermes_cli/setup.py:2498-2509` |
| `_offer_openclaw_migration()` | `hermes_cli/setup.py:2576` |
| `hermes doctor` doctor.py | `hermes_cli/doctor.py:1` |
| `_PROVIDER_ENV_HINTS` list | `hermes_cli/doctor.py:31-54` |
| Doctor version consistency check | `hermes_cli/doctor.py:207-258` |
| Doctor s6 supervision check | `hermes_cli/doctor.py:261-306` |
| Doctor gateway linger check | `hermes_cli/doctor.py:309-350` |
| Doctor API provider list | `hermes_cli/doctor.py:363-397` |
| install.sh OS detection | `scripts/install.sh:422` |
| install.sh layout resolution | `scripts/install.sh:345-386` |
| install.sh FHS root layout | `scripts/install.sh:367-379` |
| install.sh Termux detection | `scripts/install.sh:327-329` |
| install.sh uv install | `scripts/install.sh:463-545` |
| install.sh Python check + FTS5 | `scripts/install.sh:547-590` |
| install.sh ensure_fts5() | `scripts/install.sh:644-688` |
| install.sh git install | `scripts/install.sh:757-784` |
| install.sh stage manifest | `scripts/install.sh:253-264` |
| install.ps1 HermesHome default | `scripts/install.ps1:27` |
| install.ps1 arch detection | `scripts/install.ps1:125` |
| install.ps1 MinGit download | (install.ps1 — Windows only) |
| constraints-termux.txt | `constraints-termux.txt:1-16` |
| Dockerfile base image | `Dockerfile:10` |
| Dockerfile s6-overlay | `Dockerfile:51-80` |
| Dockerfile HERMES_HOME note | `Dockerfile:14-17` |
| Dockerfile system packages | `Dockerfile:26-29` |
| flake.nix inputs | `flake.nix:4-25` |
| flake.nix supported systems | `flake.nix:31-36` |
| pyproject.toml core dependencies | `pyproject.toml:13-71` |
| pyproject.toml optional extras | `pyproject.toml:73-100` |
| `cli-config.yaml.example` model section | `cli-config.yaml.example:8-73` |
| `cli-config.yaml.example` provider_routing | `cli-config.yaml.example:109-130` |
| `cli-config.yaml.example` terminal section | `cli-config.yaml.example:167-295` |
| `cli-config.yaml.example` compression | `cli-config.yaml.example:355-386` |
| `cli-config.yaml.example` memory | `cli-config.yaml.example:470-488` |
| `cli-config.yaml.example` session_reset | `cli-config.yaml.example:512-515` |
| `cli-config.yaml.example` skills | `cli-config.yaml.example:543-555` |
| `cli-config.yaml.example` agent | `cli-config.yaml.example:561-613` |
| `cli-config.yaml.example` platform_toolsets | `cli-config.yaml.example:664-675` |
| `cli-config.yaml.example` toolset descriptions | `cli-config.yaml.example:706-757` |
| `cli-config.yaml.example` mcp_servers | `cli-config.yaml.example:785-813` |
| `cli-config.yaml.example` stt | `cli-config.yaml.example:821-831` |
| `cli-config.yaml.example` display | `cli-config.yaml.example:905-1056` |
| `cli-config.yaml.example` hooks | `cli-config.yaml.example:1110-1124` |
| `cli-config.yaml.example` dashboard | `cli-config.yaml.example:1128-1168` |
