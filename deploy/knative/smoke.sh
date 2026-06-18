#!/usr/bin/env bash
# deploy/knative/smoke.sh
# Live smoke: proves scale 0→1→0 and session recall across cold starts.
#
# Prerequisites: setup-kind.sh completed, port-forward running:
#   kubectl port-forward -n kourier-system svc/kourier 8080:80
#
# Usage:
#   ./deploy/knative/smoke.sh [--port 8080]

set -euo pipefail

PORT="${PORT:-8080}"
HOST_HEADER="Host: serverless-harness.default.example.com"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0

for arg in "$@"; do
  case $arg in
    --port) shift; PORT="$1" ;;
    --port=*) PORT="${arg#*=}" ;;
  esac
  shift 2>/dev/null || true
done

claim() {
  echo ""
  echo "--- Claim $1: $2 ---"
}

pass() {
  echo "  PASS"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

# Helper: wait for scale-to-zero
wait_for_zero_pods() {
  echo "  Waiting for scale-to-zero (up to 90s)..."
  for i in $(seq 1 18); do
    COUNT=$(kubectl get pods -l serving.knative.dev/service=serverless-harness \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [ "$COUNT" = "0" ]; then
      echo "  Scaled to zero after ~$((i * 5))s"
      return 0
    fi
    sleep 5
  done
  echo "  WARNING: did not scale to zero within 90s"
  return 1
}

# ============================================================
claim 1 "Health endpoint responds"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" -H "$HOST_HEADER" "$BASE/health")
if [ "$HEALTH" = "200" ]; then pass; else fail "got HTTP $HEALTH"; fi

# ============================================================
claim 2 "POST /turn creates a new session"
RESP=$(curl -s -H "$HOST_HEADER" -H "Content-Type: application/json" \
  -d '{"prompt":"Remember the number 7777. Reply only with OK."}' \
  "$BASE/turn")

SESSION_ID=$(echo "$RESP" | jq -r '.sessionId // empty')
RESPONSE=$(echo "$RESP" | jq -r '.response // empty')

if [ -n "$SESSION_ID" ] && echo "$RESPONSE" | grep -qi "ok"; then
  pass
  echo "  sessionId=$SESSION_ID"
else
  fail "sessionId=$SESSION_ID response=$RESPONSE"
fi

# ============================================================
claim 3 "Pod scales to zero after idle"
wait_for_zero_pods && pass || fail "pods did not scale to zero"

# ============================================================
claim 4 "Cold-start resume recalls session state from Redis"
RESP2=$(curl -s -H "$HOST_HEADER" -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"prompt\":\"What number did I ask you to remember? Reply with just the number.\"}" \
  "$BASE/turn")

RESPONSE2=$(echo "$RESP2" | jq -r '.response // empty')
SID2=$(echo "$RESP2" | jq -r '.sessionId // empty')

if [ "$SID2" = "$SESSION_ID" ] && echo "$RESPONSE2" | grep -q "7777"; then
  pass
else
  fail "sessionId=$SID2 (expected $SESSION_ID) response=$RESPONSE2"
fi

# ============================================================
claim 5 "Pod scaled up from zero for claim 4"
COUNT=$(kubectl get pods -l serving.knative.dev/service=serverless-harness \
  --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -ge "1" ]; then
  pass
else
  fail "expected >=1 running pod, got $COUNT"
fi

# ============================================================
claim 6 "404 on unknown session"
RESP3=$(curl -s -w "\n%{http_code}" -H "$HOST_HEADER" -H "Content-Type: application/json" \
  -d '{"sessionId":"does-not-exist-xyz","prompt":"hello"}' \
  "$BASE/turn")
HTTP_CODE=$(echo "$RESP3" | tail -1)
if [ "$HTTP_CODE" = "404" ]; then pass; else fail "got HTTP $HTTP_CODE"; fi

# ============================================================
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then exit 1; fi
