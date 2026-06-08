# Phase 04-plugs — Pre-Phase-5 重构与计划修正

**Phase goal：** 在 Phase 5 执行前封堵三个结构性缺口：(1) LLM provider 层需要 SOLID 重构，才能干净地加入 AnthropicProvider；(2) Phase 5 T2 缺少完整 pattern 参考，无法实现；(3) Phase 5 T3 AC 中的阈值穿越检测逻辑错误，必须在实现前修正。

**来源：** 代码阅读（`lesson-save.worker.ts`、`workers/index.ts`、`openai-compatible.provider.ts`、`provider.interface.ts`）+ Pi SDK docs（`/earendil-works/pi` via context7）+ hermes `tools/approval.py`（pattern 原文）。

**Wave 结构：**

| Wave | 任务 | 说明 |
|------|------|------|
| 1 | P1 代码重构 | 必须在任何 Phase 5 代码落地前完成 |
| 2 | P2 计划修正 | 更新 `05-PLAN.md` — T1/T2/T3 三处 |
| 3 | P3 验证 | tsc + vitest，确认零回归 |

---

## Task P1：LLM Provider 抽象层重构

**Type：** refactor
**Effort：** 0.15 context window
**Wave：** 1

### Goal

将 `@graph/shared` 的 LLM provider 层重构为 Open/Closed 结构（新 provider 加新文件，不改 `workers/index.ts`），采用 Pi SDK 的 `api` 命名分类法，将 `ChatMessage` 迁移至独立 types 文件，为 Phase 5 T1（AnthropicProvider）创造干净的扩展点。

### 背景

**当前问题：**
- `workers/index.ts:91-95` 直接 `new OpenAICompatibleProvider(...)` — 每加一个 provider 就要改组合根。违反 SOLID Open/Closed 原则。
- `ChatMessage` 定义在 `provider.interface.ts` — 与接口定义混杂；迁移至 `types.ts` 后，future `@graph/types` DRY 对齐 Pi SDK 才有干净的引用点。
- `ProviderConfig` 是项目自造命名；Pi SDK（`@earendil-works/pi-coding-agent`）用 `api: 'openai-completions' | 'anthropic-messages'` — 采用 Pi SDK 命名，避免 MemexShell 集成时的类型冲突。

**关键澄清（代码读取确认）：**
- 无任何 worker 使用 `EmbeddingProvider` — `SemanticMemoryWorker` 的构造器签名是 `(pool: Pool, llm: LLMProvider)` — 无 embedding 拆分问题。05-PLAN.md 原文中关于 embedding 拆分的 implementation note **错误，P2 中删除**。
- `OpenAICompatibleProvider` 通过 `baseUrl` 已覆盖所有本地 LLM（Ollama/vLLM/LM Studio/DeepSeek）— 无需新建 `OllamaProvider`。

**Pi SDK DRY 边界：**
- `ChatMessage`（LLM wire format，含 system role）≠ Pi SDK `AgentMessage`（会话管理层，无 system role）— 不继承，分开定义，加注释说明边界。
- Pi SDK `ProviderConfig.api` 命名（`'openai-completions'` / `'anthropic-messages'`）**直接采用**为 `LLMApi` 类型的值。
- Pi SDK `ProviderModelConfig.maxTokens` 概念**采用**为 `LLMProviderConfig.maxTokens`。
- Pi SDK `TextContent = { type: 'text'; text: string }` 与 MCP server response shape 重复 — Phase 7+ `@graph/types` 统一时处理，T1 中加注释标记即可。

### Acceptance Criteria

**新文件 `packages/shared/src/llm/types.ts`：**

- [ ] 导出 `type LLMApi = 'openai-completions' | 'anthropic-messages'`
  - `'openai-completions'`：覆盖 OpenAI / Ollama / vLLM / LM Studio / DeepSeek（任何 OpenAI-兼容接口）
  - `'anthropic-messages'`：Anthropic Messages API（Phase 5 T1 添加实现）
  - Phase 7+ 扩展：`| 'google-gemini'` — 加新值，不改 factory（Open/Closed 生效）

- [ ] 导出 `interface LLMProviderConfig`：
  ```typescript
  interface LLMProviderConfig {
    api: LLMApi;         // Pi SDK: ProviderConfig.api 命名对齐
    model: string;       // Pi SDK: ProviderModelConfig.id 命名对齐
    baseUrl?: string;    // openai-completions 必填；anthropic-messages 可选（默认 api.anthropic.com）
    apiKey?: string;     // runtime 解析，never 硬编码字面量
    maxTokens?: number;  // Pi SDK: ProviderModelConfig.maxTokens；默认 4096
  }
  ```

- [ ] 导出 `interface ChatMessage`（从 `provider.interface.ts` 迁移）：
  ```typescript
  /**
   * LLM wire format. NOT Pi SDK AgentMessage.
   * Keeps 'system' role — Pi SDK handles system prompts separately
   * and has no system role in AgentMessage union type.
   * @see Pi SDK AgentMessage for session-management message types.
   */
  interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
  }
  ```

**修改 `packages/shared/src/llm/provider.interface.ts`：**

- [ ] 移除 `ChatMessage` 定义
- [ ] 添加 `import type { ChatMessage } from './types.js'`
- [ ] 添加 `export type { ChatMessage }` — 向后兼容，已有 import 路径不变
- [ ] `LLMProvider`、`EmbeddingProvider`、`EmbedResult` 保持不变

**修改 `packages/shared/src/llm/openai-compatible.provider.ts`：**

- [ ] 移除 `export interface ProviderConfig`（不再对外导出，用 `LLMProviderConfig` 替代）
- [ ] 将构造器参数类型改为 `LLMProviderConfig`（`import type { LLMProviderConfig, ChatMessage } from './types.js'`）
- [ ] 字段映射：`baseUrl`、`model`、`apiKey` 名称不变；`api` 字段接受但不使用（始终是 `openai-completions`）；`maxTokens` 用于请求体
- [ ] `chat()` 请求体：`max_tokens: this.config.maxTokens ?? 4096`（替换原硬编码）
- [ ] `embed()` 无变化

**新文件 `packages/shared/src/llm/factory.ts`：**

- [ ] 导出 `function createLLMProvider(config: LLMProviderConfig): LLMProvider`
- [ ] Switch on `config.api`：
  - `'openai-completions'` → `new OpenAICompatibleProvider(config)`
  - `'anthropic-messages'` → `throw new Error('AnthropicProvider not yet implemented — add in Phase 5 T1')`（Phase 5 T1 替换此 throw）
  - `default` → `throw new Error(\`Unknown LLM API: \${config.api}\`)`
- [ ] Phase 5 T1 唯一需要做的工厂变化：移除 throw，import `AnthropicProvider`，加一行 case — 不改其他任何文件

**新文件 `packages/shared/src/llm/index.ts`（barrel）：**

- [ ] `export * from './types.js'`
- [ ] `export * from './provider.interface.js'`
- [ ] `export * from './openai-compatible.provider.js'`
- [ ] `export * from './factory.js'`

**修改 `packages/shared/src/index.ts`：**

- [ ] 移除：`export * from './llm/provider.interface.js'`
- [ ] 移除：`export * from './llm/openai-compatible.provider.js'`
- [ ] 添加：`export * from './llm/index.js'`（替换上面两行）

**修改 `packages/workers/src/index.ts`：**

- [ ] 第 23 行：移除 `import { OpenAICompatibleProvider } from '@graph/shared'`
- [ ] 添加：`import { createLLMProvider, type LLMApi } from '@graph/shared'`
- [ ] 替换第 91-95 行：
  ```typescript
  const llmProvider = createLLMProvider({
    api: (process.env['LLM_API'] ?? 'openai-completions') as LLMApi,
    model: process.env['LLM_MODEL'] ?? 'llama3',
    baseUrl: process.env['LLM_BASE_URL'],
    apiKey: process.env['LLM_API_KEY'] ?? '',
    maxTokens: process.env['LLM_MAX_TOKENS'] ? Number(process.env['LLM_MAX_TOKENS']) : undefined,
  });
  ```
- [ ] `LLM_API` 替换旧 `LLM_PROVIDER` env var（旧值被忽略，无需迁移 — 仅开发配置）
- [ ] 不引入 `ANTHROPIC_API_KEY` — operator 在部署时设 `LLM_API_KEY=$ANTHROPIC_API_KEY`；worker 层不区分来源

### 本地 LLM 覆盖表（文档化，写入 `.harness/implementation-notes.md`）

| 本地 LLM | `LLM_API` | `LLM_BASE_URL` | `LLM_MODEL` |
|---|---|---|---|
| Ollama | `openai-completions` | `http://localhost:11434` | `llama3` |
| vLLM | `openai-completions` | `http://localhost:8000` | `<model>` |
| LM Studio | `openai-completions` | `http://localhost:1234` | `<model>` |
| DeepSeek | `openai-completions` | `https://api.deepseek.com` | `deepseek-chat` |
| Anthropic | `anthropic-messages` | _(默认)_ | `claude-haiku-4-5-20251001` |

### 文件清单

| 文件 | 操作 |
|---|---|
| `packages/shared/src/llm/types.ts` | 新建 |
| `packages/shared/src/llm/factory.ts` | 新建（anthropic stub — Phase 5 T1 填充） |
| `packages/shared/src/llm/index.ts` | 新建（barrel） |
| `packages/shared/src/llm/provider.interface.ts` | 修改（移除 ChatMessage，re-export from types） |
| `packages/shared/src/llm/openai-compatible.provider.ts` | 修改（ProviderConfig → LLMProviderConfig，maxTokens） |
| `packages/shared/src/index.ts` | 修改（llm barrel） |
| `packages/workers/src/index.ts` | 修改（createLLMProvider + LLM_API） |

### Implementation notes

重构是纯结构变化，运行时行为等价。无新测试文件（回归由 existing tests + tsc 捕获）。

`ProviderConfig` 名称从 `openai-compatible.provider.ts` 的 export surface 消失 — 如果其他包有直接 `import { ProviderConfig }` 的代码，tsc 会报错指出位置。

---

## Task P2：05-PLAN.md 三处修正

**Type：** plan-correction
**Effort：** 0.1 context window
**Wave：** 2

### P2.1 — T1 节：替换为新设计

用 P1 的完整设计替换 05-PLAN.md 中 Task 1 的全部内容：
- 新文件清单（7 个文件）
- `LLMApi` / `LLMProviderConfig`（Pi SDK DRY）
- `createLLMProvider()` factory（SOLID O）
- `LLM_API` env var（替换 `LLM_PROVIDER`）
- **删除**错误的 "embedding split" implementation note
- 添加本地 LLM 覆盖表

### P2.2 — T2 节：补全 pattern 参考

- 将 AC 中 "DANGEROUS_PATTERNS includes at minimum 20 patterns" 改为 **"all 54 patterns from Appendix A of 04-plugs-PLAN.md"**
- 添加："hermes-specific patterns 的 graph-runtime 适配规则见 Appendix A"
- 添加 T2 Implementation notes："regex 常量先定义，pattern 数组用常量拼接"

### P2.3 — T3 节：修正阈值穿越检测 AC

**删除（错误）：**
> "After a 'reinforced' action: query the new confidence from `procedural_memory WHERE fingerprint_id = $1`; if it has crossed the threshold..."

**替换为：**
> "After a 'reinforced' action: previous confidence is available as `rows[0].confidence` from the initial SELECT (line 18 of current implementation). New confidence is computed in TypeScript — no additional DB query needed:
> ```typescript
> const prevConf = rows[0].confidence;
> const newConf = Math.min(1.0, prevConf + 0.1 * (1 - prevConf));
> if (prevConf < threshold && newConf >= threshold) { await exportSkill(...); }
> ```"

**添加（created 路径说明）：**
> "The 'created' INSERT hardcodes `confidence = 0.5` regardless of `payload.confidence`. With default threshold `0.7`, `exportSkill` is never called on 'created'. This is intentional — lessons earn export through Ebbinghaus reinforcement, not on first appearance. The `payload.confidence` field exists for future external injectors, not for bypassing the reinforcement gate."

---

## Task P3：验证 checkpoint

**Type：** checkpoint:human-verify
**Effort：** N/A
**Wave：** 3

```bash
# 1. tsc — shared
cd packages/shared && npx tsc --noEmit
# Expected: exits 0

# 2. tsc — workers
cd packages/workers && npx tsc --noEmit
# Expected: exits 0

# 3. vitest — shared（无回归）
cd packages/shared && npx vitest run
# Expected: all pass

# 4. vitest — workers
cd packages/workers && npx vitest run
# Expected: all pass

# 5. factory smoke test
node -e "
  const { createLLMProvider } = require('./packages/shared/dist/llm/index.js');
  const p = createLLMProvider({ api: 'openai-completions', model: 'llama3', apiKey: '' });
  console.log(p.constructor.name); // OpenAICompatibleProvider
"
# Expected: prints OpenAICompatibleProvider
```

Reply `approved` 后进入 Phase 5 执行。

---

## Appendix A：CommandGate Pattern Reference（Phase 5 T2 实现参考）

> 来源：hermes `tools/approval.py`（approval.py:203–427）。12 HARDLINE + 54 DANGEROUS。
> 实现时：先定义 regex 常量，再拼接 pattern 数组。所有 pattern 均加 `/i` flag（case-insensitive）。DANGEROUS 另加 `/s` flag（dotall，允许 `.` 匹配换行）。

### 步骤一：TypeScript regex 常量

```typescript
// ── Command-position fragment ──────────────────────────────────────────────
// Matches positions where a shell begins parsing a new command.
const CMDPOS =
  String.raw`(?:^|[;&|\n` + '`' + String.raw`]|\$\()` +
  String.raw`\s*(?:sudo\s+(?:-[^\s]+\s+)*)?` +
  String.raw`(?:env\s+(?:\w+=\S*\s+)*)?` +
  String.raw`(?:(?:exec|nohup|setsid|time)\s+)*\s*`;

// ── System / sensitive path constants ─────────────────────────────────────
const SYSTEM_CONFIG_PATH = String.raw`(?:/etc/|/private/(?:etc|var|tmp|home)/)`;

// hermes _HERMES_ENV_PATH → adapted to MemexCore (~/.memex/)
const MEMEX_ENV_PATH =
  String.raw`(?:~\/\.memex/|(?:\$home|\$\{home\})/\.memex/)\.env\b`;

const SSH_SENSITIVE_PATH =
  String.raw`(?:~|\$home|\$\{home\})/\.ssh(?:/|$)`;

const PROJECT_ENV_PATH =
  String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'` + '`' + String.raw`]+/)*\.env(?:\.[^/\s"'` + '`' + String.raw`]+)*)`;

// hermes _PROJECT_CONFIG_PATH → add iii-config.yaml
const PROJECT_CONFIG_PATH =
  String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'` + '`' + String.raw`]+/)*(?:config\.ya?ml|iii-config\.ya?ml))`;

const SHELL_RC_FILES =
  String.raw`(?:~|\$home|\$\{home\})/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b`;

const CREDENTIAL_FILES =
  String.raw`(?:~|\$home|\$\{home\})/\.(?:netrc|pgpass|npmrc|pypirc)\b`;

const SENSITIVE_WRITE_TARGET =
  `(?:${SYSTEM_CONFIG_PATH}|/dev/sd|${SSH_SENSITIVE_PATH}|${MEMEX_ENV_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`;

const PROJECT_SENSITIVE_WRITE_TARGET =
  `(?:${PROJECT_ENV_PATH}|${PROJECT_CONFIG_PATH})`;

const COMMAND_TAIL = String.raw`(?:\s*(?:&&|\|\||;).*)?$`;
```

---

### HARDLINE_PATTERNS（12 条，flag: `/i`）

| # | Pattern | Description |
|---|---|---|
| 1 | `\brm\s+(-[^\s]*\s+)*(/|\\/\*|\/ \*)(\s\|$)` | recursive delete of root filesystem |
| 2 | `\brm\s+(-[^\s]*\s+)*(/home\|/root\|/etc\|/usr\|/var\|/bin\|/sbin\|/boot\|/lib)(/\*)?(\s\|$)` | recursive delete of system directory |
| 3 | `\brm\s+(-[^\s]*\s+)*(~\|\$HOME)(/?|/\*)?(\s\|$)` | recursive delete of home directory |
| 4 | `\bmkfs(\.[a-z0-9]+)?\b` | format filesystem (mkfs) |
| 5 | `\bdd\b[^\n]*\bof=/dev/(sd\|nvme\|hd\|mmcblk\|vd\|xvd)[a-z0-9]*` | dd to raw block device |
| 6 | `>\s*/dev/(sd\|nvme\|hd\|mmcblk\|vd\|xvd)[a-z0-9]*\b` | redirect to raw block device |
| 7 | `:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:` | fork bomb |
| 8 | `\bkill\s+(-[^\s]+\s+)*-1\b` | kill all processes (kill -1) |
| 9 | `${CMDPOS}(shutdown\|reboot\|halt\|poweroff)\b` | system shutdown/reboot |
| 10 | `${CMDPOS}init\s+[06]\b` | init 0/6 (shutdown/reboot) |
| 11 | `${CMDPOS}systemctl\s+(poweroff\|reboot\|halt\|kexec)\b` | systemctl poweroff/reboot |
| 12 | `${CMDPOS}telinit\s+[06]\b` | telinit 0/6 (shutdown/reboot) |

> 实现：`HARDLINE_PATTERNS.forEach` 检测在 DANGEROUS 之前；任一命中即 `{ allowed: false, tier: 'hardline', reason }` 返回，不继续检测。

---

### DANGEROUS_PATTERNS（54 条，flag: `/is`）

**Group 1 — rm/chmod/chown（7）**

| # | Pattern | Description |
|---|---|---|
| 1 | `\brm\s+(-[^\s]*\s+)*/` | delete in root path |
| 2 | `\brm\s+-[^\s]*r` | recursive delete |
| 3 | `\brm\s+--recursive\b` | recursive delete (long flag) |
| 4 | `\bchmod\s+(-[^\s]*\s+)*(777\|666\|o\+[rwx]*w\|a\+[rwx]*w)\b` | world/other-writable permissions |
| 5 | `\bchmod\s+--recursive\b.*(777\|666\|o\+[rwx]*w\|a\+[rwx]*w)` | recursive world-writable (long flag) |
| 6 | `\bchown\s+(-[^\s]*)?R\s+root` | recursive chown to root |
| 7 | `\bchown\s+--recursive\b.*root` | recursive chown to root (long flag) |

**Group 2 — 磁盘操作（3）**

| # | Pattern | Description |
|---|---|---|
| 8 | `\bmkfs\b` | format filesystem |
| 9 | `\bdd\s+.*if=` | disk copy |
| 10 | `>\s*/dev/sd` | write to raw block device |

**Group 3 — SQL 破坏性操作（3）**

| # | Pattern | Description |
|---|---|---|
| 11 | `\bDROP\s+(TABLE\|DATABASE)\b` | SQL DROP |
| 12 | `\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)` | SQL DELETE without WHERE |
| 13 | `\bTRUNCATE\s+(TABLE)?\s*\w` | SQL TRUNCATE |

**Group 4 — 系统配置写入（1）**

| # | Pattern | Description |
|---|---|---|
| 14 | `>\s*${SYSTEM_CONFIG_PATH}` | overwrite system config via redirect |

**Group 5 — systemctl / kill（4）**

| # | Pattern | Description |
|---|---|---|
| 15 | `\bsystemctl\s+(-[^\s]+\s+)*(stop\|restart\|disable\|mask)\b` | stop/restart/disable/mask service |
| 16 | `\bkill\s+-9\s+-1\b` | kill all processes (kill -9 -1) |
| 17 | `\bpkill\s+-9\b` | force-kill processes (pkill -9) |

**Group 6 — killall 变体（3）**

| # | Pattern | Description |
|---|---|---|
| 18 | `\bkillall\s+(-[^\s]*\s+)*-(9\|KILL\|SIGKILL)\b` | killall -KILL / -9 / -SIGKILL |
| 19 | `\bkillall\s+(-[^\s]*\s+)*-s\s+(KILL\|SIGKILL\|9)\b` | killall -s KILL |
| 20 | `\bkillall\s+(-[^\s]*\s+)*-r\b` | killall by regex (-r broad sweep) |

**Group 7 — fork bomb + shell 执行（6）**

| # | Pattern | Description |
|---|---|---|
| 21 | `:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:` | fork bomb |
| 22 | `\b(bash\|sh\|zsh\|ksh)\s+-[^\s]*c(\s+\|$)` | shell command via -c/-lc flag |
| 23 | `\b(python[23]?\|perl\|ruby\|node)\s+-[ec]\s+` | script execution via -e/-c flag |
| 24 | `\b(curl\|wget)\b.*\|\s*(?:[/\w]*/)?(?:ba)?sh(?:\s\|$\|-c)` | pipe remote content to shell |
| 25 | `\b(bash\|sh\|zsh\|ksh)\s+<\s*<?\s*\(\s*(curl\|wget)\b` | remote script via process substitution |
| 26 | `\b(python[23]?\|perl\|ruby\|node)\s+<<` | script execution via heredoc |

**Group 8 — 敏感文件写入（4）**

| # | Pattern | Description |
|---|---|---|
| 27 | `\btee\b.*${SENSITIVE_WRITE_TARGET}` | overwrite system/sensitive file via tee |
| 28 | `>>?\s*${SENSITIVE_WRITE_TARGET}` | overwrite system/sensitive file via redirect |
| 29 | `\btee\b.*${PROJECT_SENSITIVE_WRITE_TARGET}${COMMAND_TAIL}` | overwrite project env/config via tee |
| 30 | `>>?\s*${PROJECT_SENSITIVE_WRITE_TARGET}${COMMAND_TAIL}` | overwrite project env/config via redirect |

**Group 9 — xargs / find（3）**

| # | Pattern | Description |
|---|---|---|
| 31 | `\bxargs\s+.*\brm\b` | xargs with rm |
| 32 | `\bfind\b.*-exec(?:dir)?\s+(/\S*/)?rm\b` | find -exec/-execdir rm |
| 33 | `\bfind\b.*-delete\b` | find -delete |

**Group 10 — graph-runtime 进程保护（6）**
> ⚠️ 下列 6 条已从 hermes 原文适配为 graph-runtime 等价物

| # | 原 hermes pattern | 适配后 pattern | Description | 变更说明 |
|---|---|---|---|---|
| 34 | `\bhermes\s+gateway\s+(stop\|restart)\b` | `\bgraph-runtime\s+(stop\|restart)\b` | stop/restart graph-runtime process | hermes→graph-runtime |
| 35 | `\bhermes\s+update\b` | `\bgraph-runtime\s+update\b` | graph-runtime update (restarts process) | hermes→graph-runtime |
| 36 | `\bdocker\s+compose\s+(restart\|stop\|kill\|down)\b` | _(保持原文)_ | docker compose lifecycle | 无变化 |
| 37 | `\bdocker\s+(restart\|stop\|kill)\b` | _(保持原文)_ | docker container lifecycle | 无变化 |
| 38 | `gateway\s+run\b.*(&\s*$\|&\s*;\|\bdisown\b\|\bsetsid\b)` | _(保持原文)_ | start gateway outside systemd | 无变化 |
| 39 | `\bnohup\b.*gateway\s+run\b` | _(保持原文)_ | nohup gateway run | 无变化 |

**Group 11 — 自我终止保护（4）**
> ⚠️ 第 40 条已适配

| # | 原 hermes pattern | 适配后 pattern | Description |
|---|---|---|---|
| 40 | `\b(pkill\|killall)\b.*\b(hermes\|gateway\|cli\.py)\b` | `\b(pkill\|killall)\b.*\b(graph-workers\|graph-gateway)\b` | kill graph process (self-termination) |
| 41 | `\bkill\b.*\$\(\s*pgrep\b` | _(保持原文)_ | kill via pgrep expansion |
| 42 | `` \bkill\b.*`\s*pgrep\b `` | _(保持原文)_ | kill via backtick pgrep |

**Group 12 — cp/mv/sed 写入系统路径（5）**

| # | Pattern | Description |
|---|---|---|
| 43 | `\b(cp\|mv\|install)\b.*\s${SYSTEM_CONFIG_PATH}` | copy/move file into system config path |
| 44 | `\b(cp\|mv\|install)\b.*\s${PROJECT_SENSITIVE_WRITE_TARGET}${COMMAND_TAIL}` | overwrite project env/config file |
| 45 | `\bsed\s+-[^\s]*i.*\s${SYSTEM_CONFIG_PATH}` | in-place edit of system config |
| 46 | `\bsed\s+--in-place\b.*\s${SYSTEM_CONFIG_PATH}` | in-place edit of system config (long flag) |

**Group 13 — git 破坏性操作（5）**

| # | Pattern | Description |
|---|---|---|
| 47 | `\bgit\s+reset\s+--hard\b` | git reset --hard (destroys uncommitted changes) |
| 48 | `\bgit\s+push\b.*--force\b` | git force push (rewrites remote history) |
| 49 | `\bgit\s+push\b.*-f\b` | git force push short flag |
| 50 | `\bgit\s+clean\s+-[^\s]*f` | git clean with force (deletes untracked files) |
| 51 | `\bgit\s+branch\s+-D\b` | git branch force delete |

**Group 14 — chmod+x + sudo 提权（3）**

| # | Pattern | Description |
|---|---|---|
| 52 | `\bchmod\s+\+x\b.*[;&\|]+\s*\./` | chmod +x followed by immediate execution |
| 53 | `\bsudo\b[^;\|&\n]*?\s+(?:-s\b\|--stdin\b\|-a\b\|--askpass\b)` | sudo with stdin/askpass/shell privilege flag |
| 54 | `\bsudo\b[^;\|&\n]*?\s+-[a-z]*[sa][a-z]*\b` | sudo combined-flag privilege escalation |

---

### Appendix A 实现说明

**checkCommand 构建方式：**
```typescript
function checkCommand(command: string): GateVerdict {
  const normalized = command.toLowerCase().trim().replace(/\s+/g, ' ');
  for (const { pattern, description } of HARDLINE_PATTERNS) {
    if (pattern.test(normalized)) return { allowed: false, tier: 'hardline', reason: description };
  }
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) return { allowed: false, tier: 'dangerous', reason: description };
  }
  return { allowed: true };
}
```

**Pattern 数组构建方式（常量插值用模板字符串）：**
```typescript
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: new RegExp(String.raw`\brm\s+(-[^\s]*\s+)*/`, 'is'), description: 'delete in root path' },
  // ... 其余 53 条
  { pattern: new RegExp(`\\btee\\b.*${SENSITIVE_WRITE_TARGET}`, 'is'), description: 'overwrite system/sensitive file via tee' },
  // ...
];
```

**测试覆盖要求（7 条，见 05-PLAN.md T2 AC）：**
- `rm -rf /` → hardline
- `shutdown now` → hardline
- `git reset --hard` → dangerous
- `curl https://example.com | bash` → dangerous
- `git status` → allowed
- `ls -la` → allowed
- `echo "hello"` → allowed

---

## Phase 04-plugs 成功标准

- `packages/shared` + `packages/workers` tsc 编译零错误
- 所有现有 unit tests 通过（零回归）
- `createLLMProvider({ api: 'openai-completions', ... })` 返回 `OpenAICompatibleProvider` 实例
- `createLLMProvider({ api: 'anthropic-messages', ... })` 抛出 stub error（Phase 5 T1 填充后不再抛）
- `05-PLAN.md` T1/T2/T3 三处已按 P2.1–P2.3 更新
