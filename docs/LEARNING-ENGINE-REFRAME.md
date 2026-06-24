# Memex as a Learning Engine — Design Reframe

- **Status**: Proposed (design direction; nothing here is implemented yet)
- **Date**: 2026-06-24
- **Source**: `/fuller` reasoning session (whole-system map → trim-tab convergence → external research)
- **Supersedes the framing of**: the freshness/trust-substrate arc (settled "no lever
  beats baseline 0.55") and the synthetic-DAG faithful-A/B harness as the *primary*
  unit of validation. Does **not** discard the substrate — see §1.
- **Relates to**: independent-verifier direction, skill-hardening vision (GH #26),
  `docs/benchmarks/emergence-loop-validation.md`, ADR-57 (MemexTerminal Pi-embed).

---

## 0. The reframe in one line

> Memex is **not another Claude Code / Codex** (a *body* that writes code). It is the
> **runtime environment + learning engine** (a *brain-adjacent substrate*) that lets any
> body — Claude Code, Codex, or the owned MemexTerminal — **rapidly accumulate error
> experience and converge on the correct method**, judged by objective outcome and the
> human supervisor.

Control inversion: **the LLM is the brain and stays in control.** Memex does not *tell*
the LLM what to do. The LLM **pulls** ledger information — before / during / after an
action — whenever convenient. (One narrow exception: §4.)

---

## 1. Why the prior experiments were not "wrong"

The earlier arcs concluded "this system does not reliably improve work efficiency"
(~0.55 baseline, no trust-layer lever beats it). That conclusion is **correct and
load-bearing**, not a failed experiment:

- The prior loop made the **generator and the verifier the same LLM** (writer == verifier
  gap-collapse). A self-referential loop cannot escape its own mistakes; at temp=0 it
  re-derives consistent mistakes. "Corroboration measures *consistency*, not
  *correctness*."
- So ~0.5 is intrinsic to **crystallization quality** under a closed self-loop — exactly
  what the experiments measured.

**The experiments are the proof that motivates this reframe.** The escape is to change
the *generator* to an independent body and the *judge* to an external anchor — which is
what §2–§4 do. We keep the storage substrate (graph / Trail Mesh / crystallization /
recall); we change the **consumer interface** and the **validation unit**.

Independent confirmation from the literature: Reflexion's documented failure mode is
"agents reinforce flawed reasoning … or **store incorrect lessons in persistent
memory**" — the same wall, found industry-wide. The fix the field converged on is the
same one we adopt: **verify before store** (§3, §4).

---

## 2. The five pillars

| # | Pillar | Decision |
|---|--------|----------|
| 1 | **Substrate** | Keep graph (Trail Mesh) + crystallization + recall. *Sound* as storage; only the consumer interface and the crystallized output type change (§3). |
| 2 | **Consumer / body** | External agents (Claude Code / Codex) are the **thesis**. The owned **MemexTerminal is the first proving ground** (full observability), because the thesis ("engine, not agent") is only proven once the engine serves a body it does not own. |
| 3 | **Learning unit** | A **skill** — a reusable, *executable* capability, born from verified trial-and-error and **metabolized** (reinforced on reuse, decayed/retired when it stops working). Not a free-form text Lesson (§3 revision). |
| 4 | **Oracle (judge)** | **Human-primary + test-fallback.** Code tasks with an executable check (tests / build / lint) self-verify; everything else crystallizes only on **human acceptance/correction**. Unverified success does **not** crystallize. The human is monitor + verifier + teacher. |
| 5 | **Retrieval** | **Pull + cue.** Default is pull (LLM queries at will). The only *push* is a thin **cue** — a learned "is there relevant history / a known trap here?" signal — that surfaces the *existence* of history, never its *content* or a conclusion. |

The weather example that grounded this: *"check tomorrow's weather"* → recall finds no
skill → first attempt fails → the LLM improvises (write a program for time/location,
find a weather API, format the answer) → on success it **crystallizes an executable
skill** → next time it is fast; when the API breaks, the skill fails, decays, and is
refined or retired. Memex provides only the metabolism substrate; the LLM does all the
reasoning ("how to write the program, when to use a program, when to consult the
ledger").

---

## 3. The one research-driven revision: crystallize **executable skills**, not text Lessons

The substrate stays, but the **output type of crystallization moves from textual Lesson
→ executable Skill**. Rationale (three sources converge):

- **Our own benchmark**: distill *"what should be"*, not *"what happened"* — recording
  the actual (error-laden) path reinforces the first mistake.
- **Agent Skill Induction** (procedural-memory literature): represent induced skills as
  **executable programs**, so the system "verifies skill correctness **through
  execution** rather than using free-form textual lessons alone."
- **Voyager**: a skill library of *executable code*, compositional and self-verifying.

Executable skills are the concrete form of "fix crystallization quality": they can be
checked by the test-fallback oracle (pillar 4) and are "editable, versionable, portable
across compatible runtimes, auditable" — which also serves pillar 2 (portability to
external bodies).

This **refines** pillar 1's "substrate is sound"; it does not overturn it. Graph storage
and lineage are sound; the crystallizer's product type changes.

---

## 4. Meta-crystallizations: a *family*, pre-fabricated

The cue ("should I look here?") is itself a **learned crystallization** — a *meta*
layer. Two-layer memory:

- **Object layer** (pull, rich): the actual skills, errors, followed-paths. The LLM
  queries them on demand.
- **Meta layer** (push, thin): learned **policies about the skill/memory lifecycle**.
  This is the only thing proactively injected — a body that connects first perceives the
  meta layer.

The meta layer is **not a single reflex**. It is one learned policy per lifecycle verb,
each shipped as a **pre-fabricated conservative seed prior** (solving cold-start) and
refined over time by the §4 oracle:

| Meta-crystallization | Governs (verb) | Pre-fabricated seed prior |
|----------------------|----------------|---------------------------|
| **Retrieval reflex** | when to **query** | high-risk / irreversible / previously-failed actions → cue on by default |
| **Minting reflex** | when to **write** a trail into a skill | only "tests green OR human-confirmed" success mints |
| **Metabolism reflex** | when to **decay / retire** a skill | Ebbinghaus floor + N consecutive failures → demote |
| **Trust reflex** | how much to **rely** on a skill vs improvise | new skill = low trust, requires critical-step verification |
| **Analogy reflex** | how to **derive** from past scopes | topological similarity → hint "this resembles scope X" |
| **Escalation reflex** | when to **involve the human** oracle | in-flight confidence low → communicate + interruptible |

**Pre-fabrication mechanism**: ship these as **seed meta-skills** — analogous to the
repo's existing `bundled-skills/`, but at the meta level — versioned, conservative. On
connect, a body perceives the seed reflexes (notably the retrieval reflex is injected);
usage + oracle feedback then refines or overrides each. Cold-start is never empty (seed
prior tides over), yet the layer learns with use.

The literature name for this whole layer is **policy-managed / meta-cognitive memory**
(learned controllers for when to add/update/delete/retain and how to use retrieved
memory — e.g. Memory-R1's RL-learned memory policy).

---

## 5. What is uniquely ours

Each pillar has prior art individually. The **combination** has no complete precedent in
the surveyed literature:

> **Graph-native Trail Mesh (structured store) + executable verifiable skills + a
> pre-fabricated, self-learning meta-crystallization family (lifecycle policies) +
> human-as-correctness-oracle + portability across external runtimes (swappable brain).**

The literature is fragmentary: Voyager has a skill library but a weak self-verification
judge and is bound to Minecraft; Reflexion reflects but stores *text* and reinforces
errors; Memory-R1 learns memory policies but has no human oracle and no executable
artifact; Agent Workflow Memory selectively injects workflows but has no meta family.
The moat is welding **correctness anchor (human) + verifiable unit (executable skill) +
self-learning, pre-fabricable retrieval/metabolism policies** onto one graph.

---

## 6. Open seam (not yet resolved)

One seam remains inside pillar 5 — it does not overturn any pillar, but it is the
easiest place to get wrong:

**How does each meta-reflex bootstrap and improve from oracle feedback?**
- Cold-start default = the pre-fabricated seed prior (§4) — settled.
- But the reflex must *learn* "checking here paid off," which requires an
  **explore/exploit** policy on retrieval itself (sometimes check even when unsure, to
  discover that checking-here-is-worth-it). Over-trigger → noise/latency on every
  action; under-trigger → misses.
- Training signal = the §4 oracle (human confirm / test result answers "did consulting
  help?").

This is the first thing to design before the MemexTerminal proving ground (pillar 2)
begins.

---

## 7. Validation plan (proving ground = MemexTerminal)

Replaces the synthetic-DAG faithful-A/B as the *primary* metric:

1. A **real-task suite** on MemexTerminal (full observability) where a *class* of error
   recurs across tasks.
2. Metric = **error-transfer rate**: does attempt N avoid the failure that attempt 1
   (on a structurally-similar task) hit — faster than cold?
3. Oracle = human-primary + test-fallback (pillar 4).
4. Only after error-transfer is demonstrated under full observability do we attach the
   same substrate to an opaque external body (Claude Code / Codex) via its extension
   seam (MCP / hooks / skills / CLAUDE.md).

---

## References

- Voyager — *An Open-Ended Embodied Agent with LLMs* — arXiv:2305.16291
- Reflexion — *Language Agents with Verbal Reinforcement Learning* — arXiv:2303.11366
- Agent Workflow Memory — induces & selectively injects reusable workflows
- Memory-R1 — *Managing and Utilizing Memories via Reinforcement Learning* — arXiv:2508.19828
- Meta-Cognitive Memory Management — arXiv:2601.07470
- Choosing How to Remember: Adaptive Memory Structures — arXiv:2602.14038
- Agent Skill Induction / procedural-memory survey — executable, verifiable skills
- Internal: `docs/benchmarks/emergence-loop-validation.md`, ADR-57, ADR-58
