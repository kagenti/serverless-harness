#!/usr/bin/env bash
# deploy/knative/leaf-gate-smoke.sh
# Gated Kind smoke for the human-gate (design section 7.2). Proves: pause (awaiting_approval marker),
# scale-to-zero while parked, resume-approve to verdict, reject-then-approve, abort, idempotent resume.
# Prereq: setup-kind.sh (incl. KEDA) done; image rebuilt with the gate code; leaf-pvc.yaml +
#   leaf-orchestrator.yaml + leaf-scaledjob.yaml applied; sandbox-0 up.
# Usage: GATE_LIVE_SMOKE=1 bash deploy/knative/leaf-gate-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${GATE_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set GATE_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator; SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
RUN="grun-$$"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
MODEL="${SH_MODEL:-claude-haiku-4-5}"
trap 'kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/$RUN" 2>/dev/null || true' EXIT
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
leaf_job_pods() { kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '; }

# Seed one gated item (require_approval:true) and the fixture repo file.
oexec mkdir -p "$INPUTS" "$RES"
oexec sh -c "cat > $INPUTS/i1.json" <<JSON
{ "item_id": "i1", "file": "a.py", "pattern": "eval(", "require_approval": true }
JSON
kubectl -n "$NS" exec "$SBOX" -- sh -c "mkdir -p $SBOX_REPO && printf 'x = eval(\"1+1\")\n' > $SBOX_REPO/a.py"

# Dispatch async; substitute resume fields per call.
dispatch() { # $1=extra-json
  jq -nc --arg s "$RUN/i1" --arg m "$MODEL" --arg in "$INPUTS/i1.json" --arg out "$RES/i1.json" --arg ws "$SBOX_REPO" \
    --argjson extra "${1:-{}}" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws, async:true} + $extra' \
  | curl -s --max-time 30 -H "$HOST_HEADER" -H "Content-Type: application/json" -d @- "$BASE/run-leaf"
}
write_decision() { # $1=action $2=feedback?
  jq -nc --argjson g 0 --arg a "$1" --arg f "${2:-}" '{gateId:$g, action:$a} + (if $f=="" then {} else {feedback:$f} end)' \
  | oexec sh -c "cat > $RES/i1.json.decision"
}
gate_marker() { oexec sh -c "cat $RES/i1.json.gate 2>/dev/null || true"; }
result() { oexec sh -c "cat $RES/i1.json 2>/dev/null || true"; }
done_marker() { oexec sh -c "cat $RES/i1.json.status 2>/dev/null || true"; }
wait_for() { local f="$1" n=0; until oexec sh -c "test -f $f"; do n=$((n+1)); [ $n -gt 60 ] && { echo "TIMEOUT $f"; exit 1; }; sleep 2; done; }

claim 1 "Pause: dispatch a gated leaf -> awaiting_approval gate marker, no result"
dispatch >/dev/null
wait_for "$RES/i1.json.gate"
gate_marker | grep -q '"status":"awaiting_approval"' || { echo "FAIL: no awaiting_approval marker"; exit 1; }
gate_marker | grep -q '"gateId":0' || { echo "FAIL: gateId 0 expected"; exit 1; }
oexec sh -c "test ! -f $RES/i1.json" || { echo "FAIL: result written before approval"; exit 1; }
echo "OK gate marker present, no verdict"

claim 2 "Scale-to-zero while parked"
n=0; until [ "$(leaf_job_pods)" = "0" ]; do n=$((n+1)); [ $n -gt 60 ] && { echo "FAIL: pods did not scale to zero"; exit 1; }; sleep 5; done
echo "OK leaf-job pods at zero while gate pending"

claim 3 "Resume-approve -> verdict"
write_decision approve
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
result | grep -q '"verdict":"FLAGGED"' || { echo "FAIL: expected FLAGGED verdict after approve"; exit 1; }
done_marker | grep -q '"status":"done"' || { echo "FAIL: expected done marker"; exit 1; }
echo "OK approved -> FLAGGED verdict, done"

claim 4 "Idempotent resume: re-invoke with the same consumed decision -> still done, no change"
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
done_marker | grep -q '"status":"done"' || { echo "FAIL: terminal state changed on re-invoke"; exit 1; }
echo "OK idempotent re-invoke stable"

# Abort scenario on a fresh run id.
RUN="grun-abort-$$"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
oexec mkdir -p "$INPUTS" "$RES"
oexec sh -c "cat > $INPUTS/i1.json" <<JSON
{ "item_id": "i1", "file": "a.py", "pattern": "eval(", "require_approval": true }
JSON
kubectl -n "$NS" exec "$SBOX" -- sh -c "mkdir -p $SBOX_REPO && printf 'x = eval(\"1+1\")\n' > $SBOX_REPO/a.py"

claim 5 "Abort -> aborted marker, no verdict"
dispatch >/dev/null
wait_for "$RES/i1.json.gate"
write_decision abort
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
done_marker | grep -q '"status":"aborted"' || { echo "FAIL: expected aborted marker"; exit 1; }
oexec sh -c "test ! -f $RES/i1.json" || { echo "FAIL: verdict written on abort"; exit 1; }
echo "OK aborted, no verdict"

echo ""; echo "ALL GATE SMOKE CLAIMS PASSED"
