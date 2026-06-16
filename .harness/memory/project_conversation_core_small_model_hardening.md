---
name: project_conversation_core_small_model_hardening
description: "ADR-54 conversation core hardened for small local models — history re-projection, tool gating, conversational prompt"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1c613c0c-86d9-43b0-8f65-ecf83d6bc83b
---

The ADR-54 conversation core (`packages/gateway/src/conversation/core.ts`) was hardened (2026-06-14, commits b70f7646 + 3be4d58c) after live NVIDIA NIM testing showed small models (llama-3.1-8b) breaking chat three ways:

1. **No memory / repeating** — each turn sent only the current user line; prior turns lived in the graph but never reached the model. Fixed: `loadConversationHistory()` re-projects conversation.user/assistant events as real `user`/`assistant` ChatMessages (capped HISTORY_LIMIT=20). This IS ADR-54 stateless re-derivation, done right.
2. **Reflexive empty tool calls + leaked tool JSON** — the `memex_retrieve` tool was offered every turn; small models emit an empty-prose tool call even for "hi", and leak the tool JSON as text. Fixed: tool offered only when `ctx.droppedCount > 0`; else plain `chat()`. Plus an empty-reply fallback to a tool-free turn.
3. **Parroting the trail dump** — `STABLE_SYSTEM_ROLE` ("you are a graph-native agent… context is a graph projection") + a raw `## Trail Context [event_type]{json}` listing made the model echo the dump and invent fake event lines. Fixed: conversation surface uses its own `CONVERSATION_SYSTEM_ROLE` (prose-first) + a `## MEMORY` block of lessons/capabilities only — no parrotable trail listing. `formatContextBlock` → `conversationMemoryBlock`. **The agentic path's STABLE_SYSTEM_ROLE is unchanged.**

**Why it matters:** the conversation surface (MemexShell, [[project_memex_terminal_design]]) is distinct from the agentic projection — they need different system prompts. Don't reintroduce raw trail dumps or always-on tools into chat. Live-verified: 4-turn zh conversation stays coherent and recalls prior turns.

Related: this surfaced while fixing the [[feedback_never_npm_audit_fix_force]] session's NVIDIA onboarding ([[project_onboarding_provider_arc]]).
