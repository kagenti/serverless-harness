#!/usr/bin/env bash
# deploy/knative/e4-recovery.sh
# E4: complete three turns, force-kill the pod mid-session, then a new turn must
# recall all three completed turns from the persisted Redis log.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

echo "--- E4: crash recovery ---"
FRUITS=(APPLE BANANA CHERRY)

RESP=$(turn "We are listing fruits. Fruit 1 is ${FRUITS[0]}. Reply only with OK.")
SID=$(echo "$RESP" | jq -r '.sessionId // empty')
[ -n "$SID" ] || { ko "no sessionId from first turn: $RESP"; echo "=== $PASS passed, $FAIL failed ==="; exit 1; }
echo "  sessionId=$SID"
turn "Fruit 2 is ${FRUITS[1]}. Reply only with OK." "$SID" >/dev/null
turn "Fruit 3 is ${FRUITS[2]}. Reply only with OK." "$SID" >/dev/null

# Crash: force-kill the harness pod mid-session.
echo "  force-killing harness pod..."
force_kill_pod
# Best-effort settle. force-kill (not min-scale=0) means Knative may reschedule a pod
# immediately, so this often times out — that's fine. Unlike E3, scale state is NOT the gate
# here; the post-crash recall grep below is. So `|| true` is correct (not the E3 fall-through).
wait_for_zero_pods 60 || true

# Next turn on a freshly-started pod: must recall all three completed turns.
RESP2=$(turn "List all the fruits I told you, in order. Reply with just the fruit names, comma-separated." "$SID")
ANS=$(echo "$RESP2" | jq -r '.response // empty')
echo "  post-crash response: $ANS"

MISSING=""
for f in "${FRUITS[@]}"; do echo "$ANS" | grep -q "$f" || MISSING="$MISSING $f"; done
if [ -z "$MISSING" ]; then
  ok "all completed turns survived the crash (${FRUITS[*]})"
else
  ko "lost turns after crash; missing:$MISSING (response=$ANS)"
fi
echo "=== E4: $PASS passed, $FAIL failed ==="
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
