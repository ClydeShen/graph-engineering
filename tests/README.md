# Tests

Automated gate tests. Run from a separate terminal while `npm run dev` is active.

## Structure

```
tests/
  test-gate1.sh   — Gate 1: Phase 1 Core Infrastructure (Scenarios A–E)
  test-gate2.sh   — Gate 2: Phase 2 Memory & Retrieval (planned)
```

## Running

```bash
# Requires curl + jq
bash tests/test-gate1.sh

# Custom port
PORT=4001 bash tests/test-gate1.sh
```

`PORT` defaults to `4000` (gateway default). The script exits non-zero if any scenario fails unexpectedly.

## Requirements

- `npm run dev` running in another terminal (starts gateway:4000, iii:4001, workers, ctrl)
- Docker PostgreSQL running (`graph-pg` container, port 5432)
- `curl` and `jq` on PATH

## Gate coverage

| Gate | Phase | Scenarios |
|------|-------|-----------|
| 1 | Phase 1 Core Graph Engine | A: create scope · B: event + hash chain · C: read scope · D: Zod rejection · E: OCC conflict demoted |
| 2 | Phase 2 Memory & Retrieval | TBD |

## Naming convention

`test-gate<N>.sh` — one file per gate, tests all scenarios for that gate sequentially.  
Scripts are self-contained: they extract IDs from prior responses and reuse them in later scenarios.

## E2E automation (Phase 2+)

After each development phase, the gate test is completed and run autonomously:

1. Claude writes `tests/test-gate<N>.sh` covering all gate scenarios
2. Runs the test via subagent + background task
3. Reports pass/fail per scenario before triggering `/context-handover`

Manual runs by the user remain the primary acceptance signal; autonomous runs catch regressions.
