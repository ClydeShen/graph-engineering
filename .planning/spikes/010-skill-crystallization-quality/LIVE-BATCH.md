# Spike 010 — Live validation batch (ready-to-start runbook)

分支: `eval/learning-engine-live`（从 master 切）
状态: **READY TO START — blocked only on env (DB + LLM).** 日期: 2026-06-26

Confirms the *statistical* efficacy of the mechanisms whose *logic* the four deterministic
cores already proved. Only **PoC-1** (crystallization robustness) and **PoC-3**
(error-transfer + oracle gate) need a live run — PoC-2/PoC-4 are pure logic, the
deterministic cores suffice.

---

## 0. Preconditions (verify with `preflight.ts`)

```
npx tsx .planning/spikes/010-skill-crystallization-quality/preflight.ts
```
Must report **READY**:
1. **PostgreSQL** reachable at `TEST_DB` (default `postgres://postgres:password@localhost:5432/graph_test`), migrations applied (`execution_event_log` present).
2. **LLM keys** in `.env` (`LLM_*` / `*API_KEY` / `*BASE_URL`) — the harnesses read them from `process.env` via `loop-gate.ts:childEnv()`.
3. Baseline env sanity: `npm run eval:loop` runs and the §5 + B2 curves complete (this is the *control* harness; it must work before we change anything).

## 1. Bring the gate onto this branch (start-step — needs care)

The gate already exists as **Experiment A** (`4803a31c` on `exp/admission-verifier`), 5 files:
| file | role |
|---|---|
| `scripts/eval/faithful-ab/admission.ts` | the verifier: `parseOrderingRules` (LLM text → ordering rules) → `runbookContradictsDag` against `DEPS` (NEW file, conflict-free — deps `conformance.ts`/`dag.ts` are on master) |
| `packages/workers/src/memory/template-proposal.worker.ts` | +18: the crystallization-gate wiring point |
| `scripts/eval/faithful-ab/run.ts` | +11: wires the gate into the curve loop |
| `scripts/eval/faithful-ab/experiment-a.sh` | the A/B run script |
| `scripts/journey-admission.ts` | a journey |

**Divergence warning:** `exp/admission-verifier` carries the unmerged freshness arc, so
`run.ts` and `template-proposal.worker.ts` there differ from master beyond the +18/+11
gate hunks. Do **not** blind cherry-pick `4803a31c`.

Procedure:
1. `git checkout exp/admission-verifier -- scripts/eval/faithful-ab/admission.ts` (clean new file).
2. **Manually** port the +18 `template-proposal.worker.ts` hunk and the +11 `run.ts` hunk onto master's versions (read the diff: `git show 4803a31c -- <file>`). These are loop assets.
3. **Immediately** run `npm run eval:loop` → must stay green (repo discipline: never change a
   loop asset without the gate green). If it regresses, the port is wrong — fix before measuring.

## 2. Experiment (the measurement)

- **Control** = current text-Lesson crystallization, **gate OFF**:
  `npx tsx scripts/eval/faithful-ab/run.ts curve 10` → records `events_by_run` (baseline variance/collapse profile).
- **Treatment** = admission-**gated** crystallization (gate ON): same command with the gate
  enabled → records `events_by_run`.
- Paired, repeat enough times to see the variance distribution (the curve JSON lands in
  `.harness/analysis/faithful-ab/curve-*.json`).

## 3. Kill-criterion (from `docs/VALIDATION-PLAN.md` PoC-1/PoC-3)

- ✅ **VALIDATED** = the gated path stays **in the working band** (last-3 events `< 80`,
  mean `≤ 50`, per `loop-gate.ts`) across runs where the ungated baseline **collapses**
  (~100–121 = TURN_CAP). i.e. the gate measurably reduces variance/collapse — the
  executable-skill/oracle lever is real on live LLM trajectories.
- ❌ **INVALIDATED** = the gate does not reduce collapse vs baseline → the executable form
  is not the robustness lever; stop and rethink the crystallizer (do not build downstream).

## 4. Record

- `MANIFEST.md` 010 → VALIDATED / INVALIDATED + one-line finding.
- `docs/VALIDATION-PLAN.md` PoC-1/PoC-3 → mark live result.
- The deterministic cores (`step-dag.ts`/`meta-cue.ts`/`error-transfer.ts`/`stigmergy.ts`)
  stay as the logic proof; this batch is the statistics proof.

---

## Why the gate is not pre-wired here

Wiring the gate edits `template-proposal.worker.ts` + `run.ts` — **loop assets**. The repo
rule (CLAUDE.md / `scripts/eval/README.md`) is: run `eval:loop` before changing any loop
asset. Without a live env that gate cannot run, so pre-wiring would be an unverified change
to the most regression-prone code. Ready-to-start = everything safe is staged (this runbook
+ `preflight.ts`); the wiring is step 1 of the live run, done with the env so `eval:loop`
verifies it.
