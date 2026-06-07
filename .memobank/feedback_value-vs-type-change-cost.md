---
name: value-vs-type-change-cost
description: "When assessing the cost of making something 'runtime-configurable', distinguish mutating a config VALUE (shallow) from swapping a TYPE/implementation (deep) — confirmed 2026-06-08 after overestimating LLM runtime-switching cost"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 34d8dadb-193c-4b05-9349-b6cfc1eb25a9
---

When the user challenged my "this requires deep refactoring" assessment of making Memex's LLM provider runtime-switchable — pointing out they could already switch models via `.env` at startup, so "为什么不能在 runtime 时换" — reading the actual provider code (`OpenAICompatibleProvider.chat()/embed()`, `packages/shared/src/llm/openai-compatible.provider.ts:29-50`) revealed I had conflated two architecturally distinct operations:

- **Switching the provider implementation class** (e.g., `OpenAICompatibleProvider` → a native `AnthropicProvider`) — genuinely deep: touches the `LLMProvider` interface contract and every injection point across 6 Worker classes
- **Switching model/baseUrl/apiKey within the SAME provider class** (e.g., openai → gemini → nvidia, all served via OpenAI-compatible endpoints) — genuinely shallow: the provider doesn't bake an SDK client at construction, it re-reads `this.config` fresh on every `fetch()` call. Removing `readonly` and adding a setter is a ~10-line change with zero architectural disruption.

**Why:** I produced a "blast radius" analysis that treated "runtime LLM switching" as one undifferentiated thing and rated it at the cost of the deepest possible case. The user's pushback ("这应该不影响系统构造") was the correct intuition — swapping a config *value* should not cost what swapping a *type* costs — and grounding in the actual `chat()` implementation proved it. This nearly steered the design toward rejecting a cheap, valuable feature based on an inflated estimate, and the user had to push back twice before I went and read the code that settled it.

**How to apply:** Before rating "make X runtime-configurable" as expensive, go read the actual consuming code and ask: does it hold a reference to a fixed *value* baked in at construction (cheap to make mutable — the hard part is usually just "stop freezing it"), or to a specific *type/implementation* chosen at construction (expensive — needs a factory/registry layer that can resolve to different implementations)? Don't let surface-level association with a "big" operation (provider switching sounds architectural) inflate the estimate for what's actually a "small" one (parameter switching). [[console-unifies-to-graph-projection]] documents the LLM-settings design that emerged once this distinction was made explicit.
