#!/usr/bin/env bash
# Experiment A — independent admission verifier vs baseline.
#
# Paired, same-session, same-model design (controls for endpoint drift since the
# original 0.55 baseline). Each arm = 8 curves x 10 runs, SUBSTRATE OFF (single
# variable = admission), model-pinned. loop-gate prints each arm's collapse-rate;
# MAX_COLLAPSE_RATE=1 so it never exits non-zero (we read the measured rate, not a
# pass/fail bar). Compare A's collapse-rate to baseline's: A is the independent
# verifier the freshness arc concluded was the only lever that could beat baseline.
set -u
export VITEST=1
export TEST_DB="postgres://postgres:password@localhost:5432/graph_test"
export EVAL_LOOP_CURVES=8
export EVAL_LOOP_RUNS=10
export EVAL_LOOP_SKIP_B2=1
export EVAL_LOOP_MAX_COLLAPSE_RATE=1.0
export EVAL_LOOP_MODEL_PIN="openai/gpt-oss-120b"

echo "############ ARM 1: BASELINE (admission OFF, substrate OFF) — $(date) ############"
unset EVAL_LOOP_ADMISSION
npx tsx scripts/eval/loop-gate.ts

echo "############ ARM 2: A (admission ON, substrate OFF) — $(date) ############"
export EVAL_LOOP_ADMISSION=1
npx tsx scripts/eval/loop-gate.ts

echo "############ DONE — $(date) ############"
