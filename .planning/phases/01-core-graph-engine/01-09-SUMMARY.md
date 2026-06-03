---
plan: 09
phase: 01-core-graph-engine
status: complete
commit: 5eee288
wave: 5
completed: 2026-06-03
---

# Plan 09 — LLM Provider + Worker Registrations (REQ-21)

## Delivered

| Artifact | Description |
|----------|-------------|
| `packages/workers/src/llm/provider.interface.ts` | `LLMProvider` + `EmbeddingProvider` interfaces; `EmbedResult.countedAgainstBudget: false` |
| `packages/workers/src/llm/openai-compatible.provider.ts` | REST provider targeting `/v1/chat/completions` + `/v1/embeddings`; credentials injected via constructor |
| `packages/workers/src/concrete/context-assembly.worker.ts` | Full Worker: loads events → `InMemoryKnapsackGraph` → `assembleContext()` → writes projection in Writing phase |
| `packages/workers/src/concrete/conflict-resolver.worker.ts` | Phase 1 stub; no LLM call; cites OCC hard-stop (ADR 11) |
| `packages/workers/src/index.ts` | Single boot entry point: all 4 workers + FRONTIER + PATTERN_DISCOVERY triggers registered |
| `src/__tests__/llm-provider.test.ts` | 5 unit tests: chat URL, embed URL, countedAgainstBudget, no hardcoded credentials, error path |

## Decisions

- `KnapsackGraph` requires SYNC `getEventByHash`/`getSiblings` — `ContextAssemblyWorker.onScheduled` loads all scope events into `InMemoryKnapsackGraph` before the Processing phase.
- `FRONTIER_TRIGGER_CONFIG.topic` moved to nested `config.topic` to match iii-sdk `RegisterTriggerInput` shape (was top-level; caused tsc error).
- Credentials read from env vars in `index.ts` only — `OpenAICompatibleProvider` receives an injected `ProviderConfig`, never touches `process.env`.

## Test Results

```
71/71 unit tests pass, tsc --noEmit clean
```
