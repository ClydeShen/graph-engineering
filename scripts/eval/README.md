# Loop regression gate

The emergence loop (crystallize → recall → reinforce → consolidate) is a statistical
LLM-in-the-loop system. Its correctness is **behavioral, not logical** — unit tests
cannot catch a regression in it. The proof: a one-line change to the crystallization
prompt once collapsed the §5 curve from a stable 38/0 to 121/52 while all 109 unit
tests stayed green.

So the loop has an executable spec instead: two faithful curves that must learn and hold.

```bash
npm run eval:loop      # ~20 min, needs Docker (graph_test) + LLM keys in .env
```

It runs both curves and checks the criteria, exiting non-zero on regression.

The loop runs on a non-deterministic model (temperature=0 still varies), so the gate is
**statistical** — it asserts the loop converges and does not collapse, not an exact number.
A working loop settles in the ~38-46 band; a regressed one collapses to ~100-121 (the turn
cap) when a corrupted or absent runbook misleads the agent.

| Suite | What it proves | Pass criteria (last 3 runs) |
|---|---|---|
| `faithful-ab` (§5) | The 18-step DAG curve converges and does not collapse | events max < 80 **and** mean ≤ 50 |
| `cli-precondition` (B2) | The loop learns a real tool precondition ("install before use") | discovery failures = 0 |

## When to run it

Before merging any change to a **loop asset**, or before swapping the LLM model
(effect size is model-dependent). Loop assets:

- `packages/workers/src/memory/template-proposal.worker.ts` — crystallization + merge prompts
- `packages/workers/src/memory/reflect.function.ts` — recall tiers + SQL
- `packages/workers/src/base/memory-repository.ts` — consolidation (`findMergeableTemplate` / supersede)

These prompts are **brittle and scale-sensitive** — treat them as a frozen interface and
change them only behind this gate.

Background and full method: [`docs/benchmarks/emergence-loop-validation.md`](../../docs/benchmarks/emergence-loop-validation.md).
