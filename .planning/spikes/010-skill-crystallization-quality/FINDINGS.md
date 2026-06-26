# Spike 010 — Live-batch findings

## Env fix (2026-06-27) — embedding was the blocker, not dirty data

`~/.memex/config.json` `embedding` pointed at a dead local llama.cpp endpoint
(`http://127.0.0.1:8082`, bge-m3 GGUF); Ollama was uninstalled too. So recall ran
degraded ("embedding unavailable — degraded BM25 recall") and the loop could not learn.
Fix: switched `embedding` → `{ provider: "nvidia", model: "baai/bge-m3" }` (same NVIDIA
key as chat; `baai/bge-m3` is the verified-symmetric NIM embed model — the asymmetric
nv-embedqa/E5 models need an `input_type` param the generic path does not send). Backed up
to `config.json.bak-preNvidiaEmbed`. `preflight.ts` hardened to probe the embedding
endpoint + load `.env` (it had given a false READY — "reachable != functional" again).

## §5 ungated baseline (the control for the gate experiment) — live collapse reproduced

Clean run, NVIDIA `openai/gpt-oss-120b` chat + `baai/bge-m3` embed, fresh `graph_test`:

| run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|-----|---|---|---|---|---|---|---|---|---|----|
| events | 44 | 50 | 38 | 40 | 38 | **102** | 42 | 42 | 54 | 48 |
| gateFails | 3 | 6 | 0 | 1 | 0 | **32** | 2 | 2 | 8 | 5 |
| recall | f | f | t | t | t | t | t | t | t | t |

- The loop **does learn**: runs 3–5 reach near-optimal (gateFails 0–1) once recall fires.
- Then **run 6 collapses** (102 events / 32 gate-failures) and never returns to a clean 0
  — an ungated crystallization wrote a contradictory runbook that recall then injected.
- This is the documented "good-sample-not-robust → bimodal collapse" fragility, reproduced
  live. **It is exactly what the admission gate (PoC-1/PoC-3) targets — an ideal control.**
- The combined `eval:loop` gate FAILs, but on §5 only because of the collapse variance; the
  §5 curve itself is the measurement instrument for the gate experiment (collapse incidence
  / variance before vs after the gate), independent of B2 below.

## PARKED — B2 (cli-precondition) anomaly: recall fires but behavior never changes

| run | 1 | 2 | 3 | … | 10 |
|-----|---|---|---|---|----|
| discoveryFails | 1 | 1 | 1 | 1 | 1 |
| installedFirst | f | f | f | f | f |
| recall | f | **t** | t | t | t |
| events | 8 | 8 | 8 | 8 | 8 |

From run 2 `recall=true`, yet `discoveryFails` stays at 1, `installedFirst` stays false,
and `events` is dead-flat at 8 across all 10 runs — **the injected lesson has zero effect on
behavior**. This is distinct from §5 (which both learns and collapses). Not central to
PoC-1/PoC-3 (those concern the faithful-ab/§5 crystallization), so **parked**.

Candidate causes to investigate later:
1. The cli-precondition crystallization does not encode "install before use" in an
   actionable form (lesson recalled but not behaviorally usable).
2. The injection point does not reach the agent's *first* action (the precondition check
   happens before the recalled context bites).
3. `discoveryFails=1` is structurally unavoidable in this harness's task shape regardless of
   recall (a measurement artifact, not a learning failure).

→ Worth a separate spike / issue once the §5 gate experiment (PoC-1/3) concludes.
