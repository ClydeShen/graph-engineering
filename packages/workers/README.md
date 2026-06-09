<!-- generated-by: gsd-doc-writer -->
# @graph/workers

iii-sdk worker process for the Memex graph runtime. Registers all Trail workers — memory
pipeline (Episodic, Semantic, Procedural, Crystallize, LessonSave, UserProfile), task routing
(FrontierScheduler), conflict resolution, sub-scope result synthesis, MCP integration, and
pattern discovery — as a single boot entry point against an iii server.

Part of the [graph-engineering](../../README.md) monorepo.

## Workers

| Worker class | `function_id` | Trigger type | What it does |
|---|---|---|---|
| `FrontierSchedulerWorker` | `graph::scheduler::frontier` | `durable:subscriber` — topic `graph::frontier::changed` | Token-bucket Top-K priority dispatch; marks frontier nodes `pending_dispatch`; LLM-free (ADR 31) |
| `EpisodicMemoryWorker` | `graph::memory::episodic` | `durable:subscriber` — topic `graph::memory::episodic::ingest` | Appends raw execution trace events to `episodic_memory`; fires `memory_updated` to event log (C1) |
| `SemanticMemoryWorker` | `graph::memory::semantic` | `durable:subscriber` — topic `graph::scope::closed` | LLM distillation of episodic records into `semantic_memory` on scope close |
| `MemorySynthesizerWorker` | `graph::memory::synthesizer` | `cron` — `0 0 2 * * * *` (2 AM daily) | Batch episodic→procedural synthesis; triggers `ProceduralMemoryWorker` per scope |
| _(synthesizer)_ | `graph::memory::decay` | `cron` — `0 0 3 * * * *` (3 AM daily) | Ebbinghaus confidence decay scan across procedural memory |
| _(synthesizer)_ | `graph::memory::ttl` | `cron` — `0 0 4 * * * *` (4 AM daily) | 24-hour TTL purge of working memory entries |
| `ProceduralMemoryWorker` | `graph::memory::procedural` | `durable:subscriber` — topic `graph::memory::synthesizer::output` | WL-embedding of workflow templates into `procedural_memory` |
| `CrystallizeWorker` | `graph::memory::crystallize` | `durable:subscriber` — topic `graph::scope::closed` | Real-time LLM digest of episodic records into a Crystal entity; triggers `lesson-save` |
| `LessonSaveWorker` | `graph::memory::lesson-save` | `durable:subscriber` — topic `graph::memory::lesson-save` | Content-addressed lesson dedup; Ebbinghaus confidence reinforcement; exports skills above threshold |
| `UserProfileWorker` | `graph::memory::user-profile` | `scheduled` — cron `0 3 * * *` (3 AM daily) | Synthesizes cross-scope user profile from Crystal entities for each `human` protocol agent |
| `ConflictResolverWorker` | `graph::conflict-resolver` | Direct call (no trigger) | LLM-assisted semantic merge of conflicting OCC writes using a pg advisory lock |
| `SubScopeResultWorker` | `graph::scope::sub-scope-result` | `durable:subscriber` — topic `graph::scope::sub_scope_resolved` | LLM result synthesis from child scope; writes `memory_updated` to parent scope (ADR 23) |
| `McpClientWorker` | `graph::integration::mcp-client` | `@startup` + boot-time connect | Connects to external MCP servers listed in `MCP_SERVER_URLS`; dynamically registers per-tool iii functions |
| `PatternDiscoveryWorker` | `graph::patterns::discover` | `cron` — `0 0 */6 * * * *` (every 6 hours) | WL graph-kernel cross-domain pattern clustering; skips until corpus reaches `MIN_CORPUS_THRESHOLD` |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `III_URL` | No | `ws://localhost:49134` | WebSocket URL of the iii server |
| `DATABASE_URL` | No | `postgres://localhost:5432/graph` | PostgreSQL connection string |
| `LLM_API` | No | `openai-completions` | LLM provider API type (`openai-completions`, `anthropic`, etc.) |
| `LLM_MODEL` | No | `llama3` | Chat model name |
| `LLM_BASE_URL` | No | _(provider default)_ | Base URL for the LLM provider |
| `LLM_API_KEY` | No | `""` | API key for the LLM provider |
| `LLM_MAX_TOKENS` | No | _(provider default)_ | Maximum tokens per LLM response |
| `EMBEDDING_MODEL` | No | value of `LLM_MODEL` | Embedding model (always uses `openai-completions`; Anthropic has no embeddings endpoint) |
| `MCP_SERVER_URLS` | No | _(none)_ | Comma-separated URLs of external MCP servers to connect at startup |
| `SKILLS_DIR` | No | `./skills` | Directory where `LessonSaveWorker` writes exported skill files |
| `SKILL_EXPORT_THRESHOLD` | No | `0.7` | Minimum confidence for a lesson to be written to `SKILLS_DIR` |

## Starting the Worker Process

```bash
# From the repo root
node --import tsx/esm packages/workers/src/index.ts
```

Or via a workspace script if defined:

```bash
npm run start --workspace=packages/workers
```

The process connects to `III_URL`, registers all workers, performs a boot-time idempotent
`INSERT` of all worker agent cards into `agent_registry` (ON CONFLICT DO NOTHING), and begins
processing.

## Registration Pattern

All registrations happen **only** in `src/index.ts`. Individual worker files export their
trigger config constants but do not self-register. The boot entry point:

1. Reads env vars and creates shared `Pool` and `LLMProvider` instances.
2. Calls `registerWorker(III_URL, { workerName: 'graph-workers' })` once.
3. Calls `worker.registerFunction(function_id, handler)` for each worker.
4. Calls `worker.registerTrigger(TRIGGER_CONFIG)` for workers that use event or cron triggers.

## Adding a New Worker

1. Create `src/<area>/<name>.worker.ts`. Export the worker class and a `*_TRIGGER_CONFIG`
   constant (if event- or cron-driven). Workers receive injected dependencies — no direct
   `process.env` reads inside the class.
2. Import both in `src/index.ts`.
3. Instantiate the class with its injected pool/LLM/reader.
4. Call `worker.registerFunction('graph::<your-function-id>', handler)`.
5. Call `worker.registerTrigger(YOUR_TRIGGER_CONFIG)` if applicable.
6. Add an `INSERT` row to the `agent_registry` boot block (stable UUID, descriptive skills array).

## Exports (Library Consumers)

Context assembly utilities used by the HTTP gateway are re-exported from this package:

```typescript
import { assembleContext } from '@graph/workers';
import { knapsackFit }     from '@graph/workers/context/knapsack';
import { handleOverflow }  from '@graph/workers/context/overflow';
```
