# Hermes Agent Research — Part B: Models & User Interaction

## 1. Model Types & Configuration

### 1.1 Model Categories

Hermes Agent requires five distinct categories of models:

**Chat/Completion LLMs (primary)** — The core inference type. Every agent turn routes through one of four wire protocols called `api_mode`:
- `chat_completions` — OpenAI-compatible `/v1/chat/completions` endpoint (default for most providers)
- `anthropic_messages` — Anthropic SDK native (`client.messages.stream()`)
- `codex_responses` — OpenAI Responses API (`/backend-api/codex`), used for OpenAI Codex and xAI OAuth
- `bedrock_converse` — AWS Bedrock `converse` / `converse_stream` via boto3

Source: `agent/chat_completion_helpers.py:184-230`, `agent/transports/base.py:1-65`

**Speech-to-Text (Transcription)** — Six built-in STT providers defined in `BUILTIN_STT_PROVIDERS`:
- `local` — faster-whisper running locally (~150 MB download)
- `local_command` — arbitrary STT CLI via `HERMES_LOCAL_STT_COMMAND` env var
- `groq` — Groq Whisper API (model: `whisper-large-v3-turbo`)
- `openai` — OpenAI Whisper API (model: `whisper-1`)
- `mistral` — Mistral Voxtral Transcribe (model: `voxtral-mini-latest`)
- `xai` — xAI Grok STT (diarization, 21 languages)
- `elevenlabs` — ElevenLabs Scribe API (model: `scribe_v2`)

Source: `tools/transcription_tools.py:233-240`, `tools/transcription_tools.py:86-100`

**Text-to-Speech (TTS)** — Ten built-in TTS providers defined in `BUILTIN_TTS_PROVIDERS`:
- `edge` — Microsoft Edge TTS (free, no key)
- `elevenlabs` — ElevenLabs premium voices
- `openai` — OpenAI TTS
- `minimax` — MiniMax TTS with voice cloning
- `mistral` — Mistral Voxtral TTS
- `gemini` — Google Gemini TTS (30 prebuilt voices)
- `xai` — xAI Grok TTS voices
- `neutts` — on-device NeuTTS (free)
- `kittentts` — on-device 25 MB model (free)
- `piper` — OHF-Voice/piper1-gpl neural VITS (44 languages, free)

Source: `tools/tts_tool.py:357-368`, `tools/tts_tool.py:1-20`

**Image Generation** — Plugin-based ABC (`ImageGenProvider`) loaded from `plugins/image_gen/<name>/`. The primary in-tree implementation uses FAL (flux models); the tool is `image_generate`. The `fal_client` is imported lazily on first use.

Source: `agent/image_gen_provider.py:1-27`, `tools/image_generation_tool.py:41-56`

**Video Generation** — Plugin-based ABC (`VideoGenProvider`) loaded from `plugins/video_gen/<name>/`. One unified `video_generate` tool covers text-to-video and image-to-video. Provider-side routing: if `image_url` is present, routes to image-to-video; otherwise text-to-video.

Source: `agent/video_gen_provider.py:1-45`

**Vision (auxiliary)** — Not a separate model type per se; vision capability is a flag on chat LLMs. Non-vision models receive image content via a proxy `vision_analyze` tool call that routs to a dedicated auxiliary model. The main-model vision capability is resolved via `agent/image_routing.py`.

Source: `run_agent.py:3764-3784`, `agent/image_routing.py`

### 1.2 Provider Abstraction Design

The provider system has three layers:

**Layer 1 — `ProviderProfile` (declarative):** `providers/base.py` defines a `@dataclass` that stores identity, auth type, base URL, fallback model list, and hook methods:
- `prepare_messages()` — per-provider message preprocessing
- `build_extra_body()` — provider-specific request fields
- `build_api_kwargs_extras()` — split extras between `extra_body` and top-level kwargs
- `fetch_models()` — live model list from REST endpoint

Source: `providers/base.py:39-198`

**Layer 2 — Plugin discovery:** `providers/__init__.py` discovers profiles from two locations in order:
1. Bundled plugins: `plugins/model-providers/<name>/__init__.py`
2. User plugins: `$HERMES_HOME/plugins/model-providers/<name>/`
Later registrations (user plugins) override bundled ones on name collision.

Source: `providers/__init__.py:140-191`

**Layer 3 — Transport:** `agent/transports/` holds one `ProviderTransport` subclass per `api_mode` (`chat_completions.py`, `anthropic.py`, `codex.py`, `bedrock.py`). Transports own message/tool format conversion and `build_kwargs`; they do NOT own client construction, streaming, or retries.

Source: `agent/transports/base.py:16-65`

### 1.3 Supported Providers

The bundled plugin directory (`plugins/model-providers/`) contains 29 providers. Key ones confirmed in source:

| Provider slug | Plugin file | Auth | Base URL |
|---|---|---|---|
| `nous` | `plugins/model-providers/nous/__init__.py` | OAuth device-code | `https://inference.nousresearch.com/v1` |
| `openrouter` | `plugins/model-providers/openrouter/__init__.py` | API key | `https://openrouter.ai/api/v1` |
| `novita` | `plugins/model-providers/novita/__init__.py` | API key | `https://api.novita.ai/openai/v1` |
| `nvidia` | `plugins/model-providers/nvidia/__init__.py` | API key | `https://integrate.api.nvidia.com/v1` |
| `ollama-cloud` | `plugins/model-providers/ollama-cloud/__init__.py` | API key | `https://ollama.com/v1` |
| `anthropic` | `plugins/model-providers/anthropic/` | API key | Direct SDK |
| `deepseek` | `plugins/model-providers/deepseek/` | API key | Direct |
| `gemini` | `plugins/model-providers/gemini/` | OAuth/API key | Google AI |
| `bedrock` | `plugins/model-providers/bedrock/` | AWS SDK | boto3 |
| `copilot` | `plugins/model-providers/copilot/` | OAuth | `api.githubcopilot.com` |
| `azure-foundry` | `plugins/model-providers/azure-foundry/` | API key/Entra | Azure |

The `cli-config.yaml.example` documents additional provider slugs including `openai-codex`, `zai`, `kimi-coding`, `minimax`, `huggingface`, `xiaomi`, `arcee`, `kilocode`, `lmstudio`, and `custom` (any OpenAI-compat endpoint).

Source: `cli-config.yaml.example:12-39`, `plugins/model-providers/` directory listing

### 1.4 `hermes model` Command & Model Routing

The `hermes model` CLI command (`hermes_cli/main.py:2188`) calls `select_provider_and_model()` which runs an interactive TUI flow: provider picker → credential prompting → model picker → config persistence. The picker queries live model lists from each provider's `fetch_models()` hook, falling back to `fallback_models` tuples defined in the `ProviderProfile`.

Inside the interactive session the `/model` slash command (mapped via `hermes_cli/commands.py:125`) can switch models mid-session. `/model <name> --provider <slug>` switches both simultaneously; `/model --global` persists to `config.yaml`.

Model routing within a session uses the `api_mode` property on `AIAgent`. The mode is detected at startup via `hermes_cli/providers.py:determine_api_mode()` and may change on `/model` switches (e.g. switching to `anthropic-direct` flips to `anthropic_messages`).

The fallback chain (`hermes_cli/fallback_config.py`) configures an ordered list of provider+model pairs. When a provider returns a rate-limit or entitlement error, `_activate_fallback()` on `AIAgent` switches the runtime to the next entry.

Source: `hermes_cli/main.py:2188-2198`, `cli.py:7659-7725`, `hermes_cli/commands.py:125-127`

---

## 2. Model Consumption (runtime)

### 2.1 API Call Path (non-streaming)

The core dispatcher is `agent/chat_completion_helpers.py:interruptible_api_call()`. It runs the actual HTTP request in a background thread and polls with a stale-call detector.

Dispatch logic by `api_mode` (lines 184–230):
```
codex_responses  → agent._run_codex_stream()           (SSE stream, always)
anthropic_messages → agent._anthropic_messages_create()
bedrock_converse → client.converse(**api_kwargs)        (boto3)
chat_completions → request_client.chat.completions.create(**api_kwargs)  ← default path
```

Source: `agent/chat_completion_helpers.py:184-230`

### 2.2 API Request Construction

`build_api_kwargs()` in `agent/chat_completion_helpers.py:527-783` assembles the outbound request dict. Resolution order for the provider-specific quirks:
1. `anthropic_messages` — delegates to Anthropic transport's `build_kwargs`
2. `bedrock_converse` — delegates to Bedrock transport
3. `codex_responses` — delegates to Codex transport
4. `chat_completions` (default):
   - Checks `get_provider_profile(agent.provider)` for a registered profile
   - If profile found → calls `_ct.build_kwargs()` with `provider_profile=_profile`; profile hooks inject `extra_body` additions (e.g. Nous `tags`, OpenRouter `session_id`/`provider` prefs)
   - If no profile → legacy flag path with explicit per-provider boolean flags (`_is_or`, `_is_nvidia`, `_is_kimi`, etc.)

Key kwargs always present in `chat_completions` calls:
- `model`, `messages`, `tools` (tool schemas), `max_tokens`, `timeout`
- `stream` + `stream_options` when streaming
- `extra_body` for provider-specific extensions (reasoning config, session ID, provider prefs)

Source: `agent/chat_completion_helpers.py:527-783`

### 2.3 Streaming

Streaming is implemented in `agent/chat_completion_helpers.py:interruptible_streaming_api_call()` (line 1527). For `chat_completions`:

```python
stream_kwargs = {**api_kwargs, "stream": True, "stream_options": {"include_usage": True}, "timeout": httpx.Timeout(...)}
stream = request_client.chat.completions.create(**stream_kwargs)
for chunk in stream:
    delta = chunk.choices[0].delta
    # accumulate content_parts, tool_calls_acc, reasoning_parts
    # fire agent._fire_stream_delta(text) → stream_delta_callback + TTS callback
```

Token deltas pass through two stateful scrubbers before reaching the UI:
1. `_stream_think_scrubber` — strips `<think>…</think>` reasoning blocks
2. `_stream_context_scrubber` — strips memory-context injection spans

The `stream_delta_callback` on `AIAgent` connects to the TUI's token-rendering pipeline; a separate `_stream_callback` connects to the streaming TTS pipeline (ElevenLabs sentence-by-sentence).

Source: `agent/chat_completion_helpers.py:1527-1800`, `run_agent.py:3552-3610`

### 2.4 Tool-Calling Format

Tool schemas follow OpenAI function-calling format: `{"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}`. Tools are assembled by `model_tools.get_tool_definitions()` and passed as the `tools` kwarg.

When the model returns `tool_calls` in the assistant message, the agent loop dispatches each via `model_tools.handle_function_call(function_name, function_args, ...)` (line 802). This is the central tool dispatcher that routes to the tool registry (`tools/registry.py`).

Provider-specific sanitization before send:
- xAI Responses API — `strip_pattern_and_format()` and `strip_slash_enum()` remove JSON Schema fields that cause 400s (`tools/schema_sanitizer.py`)
- Anthropic — tools are re-serialized to Anthropic's `input_schema` format by `agent/transports/anthropic.py`
- Bedrock — converted by `agent/transports/bedrock.py`

Source: `model_tools.py:802-900`, `agent/chat_completion_helpers.py:583-614`

### 2.5 Reasoning Config

Providers that support chain-of-thought have a `reasoning_config` dict passed through `build_api_kwargs_extras()`. The split:
- Nous Portal → `extra_body["reasoning"] = {"enabled": True, "effort": "medium"}` (omitted when disabled)
- OpenRouter → `extra_body["reasoning"] = reasoning_config` (full dict)
- Kimi (Moonshot) → top-level `api_kwargs["reasoning_effort"]`
- GitHub Models / Copilot → `extra_body["reasoning"]` with model-specific effort levels

Source: `providers/base.py:112-130`, `plugins/model-providers/nous/__init__.py`, `plugins/model-providers/openrouter/__init__.py`

### 2.6 Auxiliary Model Usage

A separate lightweight model services vision analysis, context compression, and tool summaries. It is configured as `default_aux_model` on the `ProviderProfile` (e.g. Novita's profile sets `default_aux_model="deepseek/deepseek-v3-0324"`). The aux client is managed by `agent/auxiliary_client.py`.

Source: `providers/base.py:75-77`, `plugins/model-providers/novita/__init__.py`, `agent/auxiliary_client.py`

---

## 3. User Interaction Mechanisms

### 3.1 TUI (Terminal UI)

The interactive TUI is a `prompt_toolkit` `Application` built inside `HermesCLI.run()` (cli.py). Key components:

**Input area (`TextArea`)** — constructed at `cli.py:13739` with:
- `multiline=True` — Alt+Enter inserts newline, Enter submits
- `completer=SlashCommandCompleter(...)` — tab-completion for slash commands and `@file` paths
- `auto_suggest=SlashCommandAutoSuggest(...)` — ghost-text ahead-of-cursor suggestion
- `history=FileHistory(str(self._history_file))` — persistent command history across sessions
- `complete_while_typing=True` — live completions dropdown

Multiline editing: Shift+Enter and Ctrl+Enter are aliased to Alt+Enter via `hermes_cli/pt_input_extras.py:install_shift_enter_alias()` and `install_ctrl_enter_alias()` (line 82-84). Draft editor (Ctrl+G / Alt+G) opens the buffer in an external `$EDITOR`.

Source: `cli.py:13739-13753`, `cli.py:6084-6089`, `cli.py:77-87`

**Paste handling** — Large pastes are detected by two heuristics (chars-added-at-once or newline-jump-by-4+) and collapsed to a temp-file reference, preventing accidental giant context injections. `cli.py:13797-13830`.

**Busy input modes** — Configurable via `display.busy_input_mode` in config:
- `interrupt` (default) — Enter while agent is running stops the current turn
- `queue` — Enter queues the message for the next turn
- `steer` — Enter injects a mid-run steering message after the next tool call

Source: `cli.py:2971-2980`, `hermes_cli/commands.py:105-106`

**Status bar** — A persistent bottom bar shows context usage (tokens), model name, and provider. Toggle with `/statusbar`.

**Streaming output** — When `display.streaming: true` in config, assistant text is rendered token-by-token via `stream_delta_callback`. The TUI uses a `_stream_buf` and table-aware line renderer to handle markdown tables across chunk boundaries.

Source: `cli.py:3017-3027`, `cli.py:2990`

### 3.2 CLI Entry Points

The main entry point `hermes_cli/main.py` exposes subcommands via argparse:

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
| `hermes status` | Component status |
| `hermes logs` | View logs |
| `hermes acp` | ACP server for editor integration |
| `hermes sessions browse` | Interactive session picker |

`run_agent.py:main()` can also be invoked directly for headless single-query use, accepting `--model`, `--base-url`, `--api-key`, `--max-turns`, `--enabled-toolsets`, etc.

Source: `hermes_cli/main.py:1-44`, `run_agent.py:4600-4636`

### 3.3 Slash Command System

Slash commands are defined in a central registry `COMMAND_REGISTRY: list[CommandDef]` in `hermes_cli/commands.py:64-223`. Each `CommandDef` carries:
- `name` — canonical name (e.g. `"model"`)
- `aliases` — shorthand forms (e.g. `("provider",)`)
- `category` — grouping for `/help` display
- `subcommands` — tab-completable subcommand tokens
- `cli_only` / `gateway_only` — availability flags

**Dispatch** — `HermesCLI._handle_command()` (cli.py:~8390) resolves input via `resolve_command(_base_word)`, canonicalizes the name, then dispatches through an `elif` chain. Full list of handlers includes: `quit/exit`, `help`, `profile`, `tools`, `toolsets`, `config`, `redraw`, `clear`, `history`, `title`, `handoff`, `new`, `resume`, `sessions`, `model`, `codex-runtime`, `gquota`, `personality`, `retry`, `undo`, `branch`, `save`, `cron`, `curator`, `kanban`, `skills`, `platforms`, `status`, `statusbar`, `verbose`, `footer`, `yolo`, `reasoning`, `fast`, `compress`, `usage`, `insights`, `copy`, `debug`, `update`, `paste`, `image`, `reload`, `reload-mcp`, `reload-skills`, `bundles`, `browser`, `plugins`, `rollback`, `snapshot`, `stop`, `agents`, `background`, `queue`, `steer`, `voice`, and more.

Source: `hermes_cli/commands.py:64-223`, `cli.py:8390-8730`

**Autocomplete** — `SlashCommandCompleter` (hermes_cli/commands.py:1185) provides:
- Built-in command completions with trailing-space or no-space for picker commands (`model`, `skin`, `personality`)
- Subcommand tab-completion
- `@file` path completion using OS directory scan with LRU caching
- Skill command completions injected at runtime

`SlashCommandAutoSuggest` (line 1751) shows ghost-text from history or the completer.

Source: `hermes_cli/commands.py:1185-1274`, `hermes_cli/commands.py:1751+`

### 3.4 Personalities

Personalities are named system-prompt overlays configured in `config.yaml` under `agent.personalities`. The default set (hard-coded in cli.py:406-421) includes: `helpful`, `concise`, `technical`, `creative`, `teacher`, `kawaii`, `catgirl`, `pirate`, `shakespeare`, `surfer`, `noir`, `uwu`, `philosopher`, `hype`.

The `/personality <name>` command calls `_handle_personality_command()` (cli.py:7988) which:
1. Resolves the personality value (string or `{system_prompt, tone, style}` dict) via `_resolve_personality_prompt()` (line 7931)
2. Sets `self.system_prompt` and clears `self.agent` to force re-initialization
3. Optionally persists to `config.yaml` via `save_config_value("agent.system_prompt", ...)`

The SOUL.md mechanism (`agent/prompt_builder.py:1355-1380`) provides a deeper identity layer: a Markdown file at `$HERMES_HOME/SOUL.md` is read at prompt-build time and injected as slot #1 in the system prompt, overriding the default `DEFAULT_AGENT_IDENTITY` string. AGENTS.md, CLAUDE.md, and .hermes.md in the working directory are also loaded as project context.

Source: `cli.py:406-421`, `cli.py:7931-7940`, `cli.py:7988-8030`, `agent/prompt_builder.py:120-128`, `agent/prompt_builder.py:1355-1380`

### 3.5 Core Agent Loop (one user turn)

`agent/conversation_loop.py:run_conversation()` (line 351) drives a single user turn:

1. **Sanitize input** — surrogate characters stripped from `user_message`
2. **System prompt** — cached per session in SQLite; restored from DB on gateway (stateless) mode to preserve Anthropic prefix caching
3. **Preflight compression** — if `estimate_request_tokens_rough()` exceeds the threshold, up to 3 passes of context compression run before entering the loop
4. **Plugin hooks** — `pre_llm_call` hook fired; plugins can inject context into the user message
5. **Main loop** — `while api_call_count < agent.max_iterations and budget.remaining > 0` (line 796):
   a. Check `_interrupt_requested` — break if set
   b. Drain pending `/steer` messages into the last tool-result message
   c. Build `api_messages` (prepend system prompt, apply provider-specific transforms)
   d. Build `api_kwargs` via `build_api_kwargs()`
   e. Call `interruptible_streaming_api_call()` or `interruptible_api_call()`
   f. Parse response: extract `tool_calls`, `content`, `reasoning`, `finish_reason`
   g. If `tool_calls` → dispatch each via `handle_function_call()`, append tool results, continue loop
   h. If `finish_reason == "stop"` with no tool calls → break (final response)
   i. Handle continuation (length truncation, empty content retries, etc.)
6. **Post-turn** — emit final response, fire `on_turn_complete` hooks, optionally trigger background memory/skill review

**Interrupt-and-redirect:** `agent._interrupt_requested` is checked at the top of every loop iteration and inside `interruptible_api_call` (polling every 0.3s). When set, the HTTP connection is force-closed via TCP socket shutdown (`_abort_request_openai_client`) on a stranger thread to avoid FD race conditions (issue #29507). The interrupted message, if typed by the user during the run, is routed through `_interrupt_queue` in the TUI and optionally re-queued as the next turn's input.

Source: `agent/conversation_loop.py:351-570`, `agent/conversation_loop.py:796-850`, `agent/chat_completion_helpers.py:125-230`

### 3.6 Voice Interaction

Voice mode is toggled with `/voice on` or the configured push-to-talk key (default `Ctrl+B`). Two modes:
- **Push-to-talk** — `start_recording()` / `stop_and_transcribe()` in `hermes_cli/voice.py`
- **Continuous (VAD)** — `start_continuous()` / `stop_continuous()` with automatic silence detection

When voice mode is active, user speech is transcribed via `tools/transcription_tools.py:transcribe_audio()` and the text is injected with a brevity prefix: `"[Voice input — respond concisely and conversationally, 2-3 sentences max. No code blocks or markdown.]"` (cli.py:11965-11970).

Streaming TTS (ElevenLabs) is set up before `run_conversation()` when `_voice_tts` is enabled: a background thread runs `stream_tts_to_speaker()` consuming text from a `queue.Queue`, playing audio sentence-by-sentence as the agent generates tokens (cli.py:11906-11956).

Source: `hermes_cli/voice.py:1-40`, `cli.py:11902-11970`, `tools/transcription_tools.py:1-28`

### 3.7 Conversation History & Session Resumption

Conversation history is stored in SQLite via a session DB object. `/resume <name>` or `--resume <session-id>` restores prior context. The gateway path creates a fresh `AIAgent` per inbound message and reconstructs state from the session DB (system prompt, message history, nudge counters). `/sessions` provides a browsable list of past sessions.

Source: `cli.py:2950-2952`, `agent/conversation_loop.py:218-318`, `hermes_cli/commands.py:117-120`

---

## Citation Index

| Path | Lines | Subject |
|---|---|---|
| `providers/base.py` | 39-198 | `ProviderProfile` dataclass, hook methods, `fetch_models()` |
| `providers/__init__.py` | 43-191 | Plugin discovery, `register_provider()`, `get_provider_profile()` |
| `plugins/model-providers/nous/__init__.py` | 1-55 | Nous Portal provider profile, OAuth auth, reasoning config |
| `plugins/model-providers/openrouter/__init__.py` | 1-85 | OpenRouter profile, `fetch_models()`, provider prefs, reasoning |
| `plugins/model-providers/novita/__init__.py` | 1-24 | NovitaAI profile |
| `plugins/model-providers/nvidia/__init__.py` | 1-18 | NVIDIA NIM profile |
| `plugins/model-providers/ollama-cloud/__init__.py` | 1-13 | Ollama Cloud profile |
| `agent/transports/base.py` | 16-65 | `ProviderTransport` ABC |
| `agent/image_gen_provider.py` | 1-27 | Image generation ABC |
| `agent/tts_provider.py` | 1-85 | TTS provider ABC, built-in list |
| `agent/transcription_provider.py` | 1-80 | STT provider ABC, built-in list |
| `agent/video_gen_provider.py` | 1-45 | Video generation ABC |
| `agent/chat_completion_helpers.py` | 125-230 | `interruptible_api_call()` dispatch |
| `agent/chat_completion_helpers.py` | 527-783 | `build_api_kwargs()` construction |
| `agent/chat_completion_helpers.py` | 1527-1800 | `interruptible_streaming_api_call()` |
| `agent/chat_completion_helpers.py` | 1706-1730 | `stream=True`, chunk iteration loop |
| `agent/conversation_loop.py` | 351-570 | `run_conversation()` setup |
| `agent/conversation_loop.py` | 796-850 | Main agent loop `while` construct |
| `run_agent.py` | 49-76 | OpenAI lazy proxy, module imports |
| `run_agent.py` | 317-348 | `AIAgent.__init__` signature |
| `run_agent.py` | 3465-3468 | `_interruptible_api_call` forwarder |
| `run_agent.py` | 3552-3610 | `_fire_stream_delta()`, scrubber chain |
| `run_agent.py` | 3764-3784 | `_model_supports_vision()` |
| `run_agent.py` | 4560-4571 | `run_conversation()` forwarder |
| `model_tools.py` | 802-900 | `handle_function_call()` dispatcher |
| `tools/transcription_tools.py` | 1-28 | STT module docstring, provider list |
| `tools/transcription_tools.py` | 86-100 | Default STT models, base URLs |
| `tools/transcription_tools.py` | 233-240 | `BUILTIN_STT_PROVIDERS` frozenset |
| `tools/transcription_tools.py` | 1288-1398 | `client.audio.transcriptions.create()` call sites |
| `tools/tts_tool.py` | 1-20 | TTS module docstring, provider list |
| `tools/tts_tool.py` | 357-368 | `BUILTIN_TTS_PROVIDERS` frozenset |
| `tools/tts_tool.py` | 1018 | `client.audio.speech.create()` call |
| `tools/image_generation_tool.py` | 41-56 | FAL client lazy-import |
| `cli.py` | 57-87 | `prompt_toolkit` imports, Shift/Ctrl+Enter aliases |
| `cli.py` | 400-421 | Default `personalities` dict in config |
| `cli.py` | 2915-2980 | `HermesCLI.__init__` head |
| `cli.py` | 2971-2980 | `busy_input_mode` configuration |
| `cli.py` | 2990` | `streaming_enabled` config read |
| `cli.py` | 6040-6090 | `show_help()`, command categories |
| `cli.py` | 7659-7725 | `/model` command handler |
| `cli.py` | 7931-7940 | `_resolve_personality_prompt()` |
| `cli.py` | 7988-8030 | `_handle_personality_command()` |
| `cli.py` | 8390-8730 | `_handle_command()` dispatch chain |
| `cli.py` | 11755-11780 | `_send_message()` entry, interrupt setup |
| `cli.py` | 11902-11970 | Streaming TTS setup, voice prefix |
| `cli.py` | 13730-13753 | `TextArea` creation, completer, history |
| `cli.py` | 13797-13830 | Paste collapsing heuristics |
| `hermes_cli/commands.py` | 45-57 | `CommandDef` dataclass |
| `hermes_cli/commands.py` | 64-223 | `COMMAND_REGISTRY` full list |
| `hermes_cli/commands.py` | 1185-1274 | `SlashCommandCompleter` |
| `hermes_cli/commands.py` | 1751+ | `SlashCommandAutoSuggest` |
| `hermes_cli/main.py` | 1-44 | `hermes` subcommand listing |
| `hermes_cli/main.py` | 2188-2198 | `cmd_model()` entry point |
| `hermes_cli/voice.py` | 1-40 | Voice mode process-wide API |
| `agent/prompt_builder.py` | 120-128 | `DEFAULT_AGENT_IDENTITY` |
| `agent/prompt_builder.py` | 1355-1380 | `load_soul_md()` |
| `cli-config.yaml.example` | 8-46 | Model config keys, provider slug list |
| `hermes_cli/models.py` | 34-78 | `OPENROUTER_MODELS` fallback catalog |
