#!/usr/bin/env bash
# deploy/knative/smoke.sh
# Live smoke: proves scale 0→1→0 and session recall across cold starts.
# Prereq: setup-kind.sh done + port-forward: kubectl port-forward -n kourier-system svc/kourier 8080:80
# Usage: ./deploy/knative/smoke.sh [--port=8080]
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

for arg in "$@"; do
  case $arg in
    --port=*) PORT="${arg#*=}"; BASE="http://localhost:${PORT}" ;;
  esac
done

claim() { echo ""; echo "--- Claim $1: $2 ---"; }

claim 1 "Health endpoint responds"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" -H "$HOST_HEADER" "$BASE/health")
[ "$HEALTH" = "200" ] && ok || ko "got HTTP $HEALTH"

claim 2 "POST /turn creates a new session"
RESP=$(turn "Remember the number 7777. Reply only with OK.")
SESSION_ID=$(echo "$RESP" | jq -r '.sessionId // empty')
RESPONSE=$(echo "$RESP" | jq -r '.response // empty')
if [ -n "$SESSION_ID" ] && echo "$RESPONSE" | grep -qi "ok"; then ok "sessionId=$SESSION_ID"; else ko "sessionId=$SESSION_ID response=$RESPONSE"; fi

claim 3 "Pod scales to zero after idle"
wait_for_zero_pods 90 && ok || ko "pods did not scale to zero"

claim 4 "Cold-start resume recalls session state from Redis"
RESP2=$(turn "What number did I ask you to remember? Reply with just the number." "$SESSION_ID")
RESPONSE2=$(echo "$RESP2" | jq -r '.response // empty')
SID2=$(echo "$RESP2" | jq -r '.sessionId // empty')
if [ "$SID2" = "$SESSION_ID" ] && echo "$RESPONSE2" | grep -q "7777"; then ok; else ko "sessionId=$SID2 (expected $SESSION_ID) response=$RESPONSE2"; fi

claim 5 "Pod scaled up from zero for claim 4"
[ "$(harness_running_pods)" -ge 1 ] && ok || ko "expected >=1 running pod"

claim 6 "404 on unknown session"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 -H "$HOST_HEADER" -H "Content-Type: application/json" \
  -d '{"sessionId":"does-not-exist-xyz","prompt":"hello"}' "$BASE/turn")
[ "$HTTP_CODE" = "404" ] && ok || ko "got HTTP $HTTP_CODE"

echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
