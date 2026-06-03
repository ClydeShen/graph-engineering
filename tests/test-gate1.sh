#!/usr/bin/env bash
# Gate 1 manual test — Scenarios A-E
# Usage: bash scripts/test-gate1.sh

GW="${PORT:+http://localhost:$PORT}"
GW="${GW:-http://localhost:4000}"

echo "=== Scenario A: Create Scope ==="
RESULT=$(curl -s -X POST "$GW/v1/scopes" \
  -H "Content-Type: application/json" \
  -d '{"intent":"smoke test"}')
echo "$RESULT"

SCOPE_ID=$(echo "$RESULT" | grep -o '"scope_id":"[^"]*"' | cut -d'"' -f4)
PLAN_HASH=$(echo "$RESULT" | grep -o '"plan_hash":"[^"]*"' | cut -d'"' -f4)
echo "scope_id=$SCOPE_ID"
echo "plan_hash=$PLAN_HASH"

echo ""
echo "=== Scenario B: Write Event ==="
curl -s -X POST "$GW/v1/scopes/$SCOPE_ID/events" \
  -H "Content-Type: application/json" \
  -d "{\"event_type\":\"task_spawned\",\"entity_id\":\"550e8400-e29b-41d4-a716-446655440001\",\"predecessor_hash\":\"$PLAN_HASH\",\"payload\":{\"task\":\"test\"}}"

echo ""
echo ""
echo "=== Scenario C: Read Scope State ==="
curl -s "$GW/v1/scopes/$SCOPE_ID"

echo ""
echo ""
echo "=== Scenario D: Zod Rejects Invalid Request ==="
curl -s -X POST "$GW/v1/scopes/not-a-uuid/events" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"task_spawned","entity_id":"bad","predecessor_hash":"bad","payload":{}}'

echo ""
echo ""
echo "=== Scenario E: OCC Conflict (same predecessor_hash twice) ==="
echo "--- Write 1 ---"
curl -s -X POST "$GW/v1/scopes/$SCOPE_ID/events" \
  -H "Content-Type: application/json" \
  -d "{\"event_type\":\"memory_updated\",\"entity_id\":\"550e8400-e29b-41d4-a716-446655440002\",\"predecessor_hash\":\"$PLAN_HASH\",\"payload\":{\"note\":\"A\"}}"
echo ""
echo "--- Write 2 (same predecessor) ---"
curl -s -X POST "$GW/v1/scopes/$SCOPE_ID/events" \
  -H "Content-Type: application/json" \
  -d "{\"event_type\":\"memory_updated\",\"entity_id\":\"550e8400-e29b-41d4-a716-446655440003\",\"predecessor_hash\":\"$PLAN_HASH\",\"payload\":{\"note\":\"B\"}}"
echo ""
