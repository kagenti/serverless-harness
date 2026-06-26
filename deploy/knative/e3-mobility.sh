#!/usr/bin/env bash
# deploy/knative/e3-mobility.sh
# E3-mobility: plant a token on instance A, force the pod to zero, then a fresh
# instance B must answer a follow-up from the Redis log (not in-pod memory).
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

TOKEN="ZEBRA42"
echo "--- E3: session mobility (token=$TOKEN) ---"

# Turn 1 on instance A: plant the token.
RESP=$(turn "Remember the code word: ${TOKEN}. Reply only with OK.")
SID=$(echo "$RESP" | jq -r '.sessionId // empty')
[ -n "$SID" ] || { ko "no sessionId from first turn: $RESP"; echo "=== $PASS passed, $FAIL failed ==="; exit 1; }
echo "  sessionId=$SID"

# Force a fresh instance: ensure serverless, scale to zero, assert the pod is gone.
set_min_scale 0
if wait_for_zero_pods 120; then echo "  pod scaled to zero (instance A gone)"; else ko "pod did not scale to zero"; fi

# Follow-up on instance B (cold start): must recall the token from the log.
RESP2=$(turn "What is the code word? Reply with just the word. Do not add any other words." "$SID")
SID2=$(echo "$RESP2" | jq -r '.sessionId // empty')
ANS=$(echo "$RESP2" | jq -r '.response // empty')
echo "  fresh-pod response: $ANS"

if [ "$SID2" = "$SID" ] && echo "$ANS" | grep -q "$TOKEN"; then
  ok "fresh instance recalled '$TOKEN' from the Redis log"
else
  ko "expected '$TOKEN' from sid=$SID, got sid=$SID2 response=$ANS"
fi
echo "=== E3: $PASS passed, $FAIL failed ==="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
