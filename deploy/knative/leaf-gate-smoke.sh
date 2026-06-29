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
RUN_REJ="grun-rej-$$"
MODEL="${SH_MODEL:-claude-haiku-4-5}"
trap '
  kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/$RUN" 2>/dev/null || true
  kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/$RUN_REJ" 2>/dev/null || true
' EXIT
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
# Stdin-forwarding variant (-i) for writes fed by a heredoc or a pipe. Without -i, kubectl exec
# does NOT forward local stdin to the pod, so `cat > file` would write an empty file.
oexec_i() { kubectl -n "$NS" exec -i "$ORCH" -- "$@"; }
leaf_job_pods() { kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '; }

# Seed one gated item (require_approval:true) and the fixture repo file.
oexec mkdir -p "$INPUTS" "$RES"
# The harness now runs non-root (uid 65532); the orchestrator (this pod, root) must provision the
# /work result dirs writable by it. chmod 0777 the run dir models that operational contract.
oexec chmod -R 0777 "/work/$RUN"
oexec_i sh -c "cat > $INPUTS/i1.json" <<JSON
{ "item_id": "i1", "file": "a.py", "pattern": "eval(", "require_approval": true }
JSON
kubectl -n "$NS" exec "$SBOX" -- sh -c "mkdir -p $SBOX_REPO && printf 'x = eval(\"1+1\")\n' > $SBOX_REPO/a.py"

# Dispatch async; substitute resume fields per call.
dispatch() { # $1=extra-json (defaults to {}); avoid ${1:-{}} which bash mis-parses (trailing })
  local extra="${1:-}"; [ -n "$extra" ] || extra='{}'
  jq -nc --arg s "$RUN/i1" --arg m "$MODEL" --arg in "$INPUTS/i1.json" --arg out "$RES/i1.json" --arg ws "$SBOX_REPO" \
    --argjson extra "$extra" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws, async:true} + $extra' \
  | curl -s --max-time 30 -H "$HOST_HEADER" -H "Content-Type: application/json" -d @- "$BASE/run-leaf"
}
# write_decision GATEID ACTION [FEEDBACK]
write_decision() { # $1=gateId $2=action $3=feedback?
  jq -nc --argjson g "$1" --arg a "$2" --arg f "${3:-}" '{gateId:$g, action:$a} + (if $f=="" then {} else {feedback:$f} end)' \
  | oexec_i sh -c "cat > $RES/i1.json.decision"
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
write_decision 0 approve
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
result | grep -q '"verdict":"FLAGGED"' || { echo "FAIL: expected FLAGGED verdict after approve"; exit 1; }
done_marker | grep -q '"status":"done"' || { echo "FAIL: expected done marker"; exit 1; }
echo "OK approved -> FLAGGED verdict, done"

claim 4 "Idempotent resume: re-invoke with consumed decision -> still done, verdict unchanged, no duplicate result file"
before="$(result)"
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
# Best-effort: poll up to 60s for a new leaf-job pod to appear then drain. NOTE: an idempotent
# re-invoke of an already-completed session hits the verdict fast-path (M5 recovery, no agent/model
# call), so the pod's Running window is sub-second and the 5s poll may not observe it. Pod
# observation is therefore NOT a hard gate (it would be flaky); the real idempotency proof is the
# terminal-state-unchanged assertions below (done stable, verdict content identical, exactly 1
# result file). The loop also serves as a settle delay before asserting. Deeper idempotency is
# unit-tested (decideSeed double-resume; verdict fast-path recovery).
n=0
while [ $n -lt 12 ]; do
  if [ "$(leaf_job_pods)" != "0" ]; then
    # A pod appeared; now wait for it to drain.
    m=0; until [ "$(leaf_job_pods)" = "0" ]; do m=$((m+1)); [ $m -gt 24 ] && break; sleep 5; done
    break
  fi
  n=$((n+1)); sleep 5
done
# Whether or not a pod ran, assert terminal state is unchanged.
done_marker | grep -q '"status":"done"' || { echo "FAIL: terminal state changed on re-invoke"; exit 1; }
after="$(result)"
[ "$after" = "$before" ] || { echo "FAIL: result content changed on re-invoke"; exit 1; }
nfiles=$(oexec sh -c "ls $RES/i1.json 2>/dev/null | wc -l | tr -d ' '")
[ "$nfiles" = "1" ] || { echo "FAIL: expected exactly 1 result file, got $nfiles"; exit 1; }
echo "OK idempotent re-invoke: done status stable, verdict unchanged, exactly 1 result file"

# Reject scenario on a fresh run id.
RUN="$RUN_REJ"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
oexec mkdir -p "$INPUTS" "$RES"
# The harness now runs non-root (uid 65532); the orchestrator (this pod, root) must provision the
# /work result dirs writable by it. chmod 0777 the run dir models that operational contract.
oexec chmod -R 0777 "/work/$RUN"
oexec_i sh -c "cat > $INPUTS/i1.json" <<JSON
{ "item_id": "i1", "file": "a.py", "pattern": "eval(", "require_approval": true }
JSON
kubectl -n "$NS" exec "$SBOX" -- sh -c "mkdir -p $SBOX_REPO && printf 'x = eval(\"1+1\")\n' > $SBOX_REPO/a.py"

claim 6 "Reject continuation: reject -> agent reaches done (or re-gates) -> final done with a verdict"
dispatch >/dev/null
wait_for "$RES/i1.json.gate"
gate_marker | grep -q '"gateId":0' || { echo "FAIL: first gate should be gateId 0"; exit 1; }
write_decision 0 reject "reconsider and double-check before deciding"
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null

# Poll up to 120s for EITHER a done marker OR a gateId-1 gate marker.
final_gate_id=0
n=0
while [ $n -lt 60 ]; do
  if oexec sh -c "test -f $RES/i1.json.status" 2>/dev/null; then
    echo "INFO: agent reached done directly after reject"
    break
  fi
  gate_content="$(oexec sh -c "cat $RES/i1.json.gate 2>/dev/null || true")"
  if echo "$gate_content" | grep -q '"gateId":1'; then
    echo "INFO: agent re-gated at gateId 1 after reject"
    final_gate_id=1
    break
  fi
  n=$((n+1)); sleep 2
done
[ $n -lt 60 ] || { echo "FAIL: timeout waiting for done or gateId-1 after reject"; exit 1; }

# If agent re-gated, approve the second gate.
if [ "$final_gate_id" = "1" ]; then
  write_decision 1 approve
  dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
  wait_for "$RES/i1.json.status"
fi

done_marker | grep -q '"status":"done"' || { echo "FAIL: expected done marker after reject continuation"; exit 1; }
oexec sh -c "test -f $RES/i1.json" || { echo "FAIL: no result verdict file after reject continuation"; exit 1; }
echo "OK reject continuation: session reached done with a result verdict (re-gated=$final_gate_id)"

# Abort scenario on a fresh run id.
RUN="grun-abort-$$"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
oexec mkdir -p "$INPUTS" "$RES"
# The harness now runs non-root (uid 65532); the orchestrator (this pod, root) must provision the
# /work result dirs writable by it. chmod 0777 the run dir models that operational contract.
oexec chmod -R 0777 "/work/$RUN"
oexec_i sh -c "cat > $INPUTS/i1.json" <<JSON
{ "item_id": "i1", "file": "a.py", "pattern": "eval(", "require_approval": true }
JSON
kubectl -n "$NS" exec "$SBOX" -- sh -c "mkdir -p $SBOX_REPO && printf 'x = eval(\"1+1\")\n' > $SBOX_REPO/a.py"

claim 5 "Abort -> aborted marker, no verdict"
dispatch >/dev/null
wait_for "$RES/i1.json.gate"
write_decision 0 abort
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
done_marker | grep -q '"status":"aborted"' || { echo "FAIL: expected aborted marker"; exit 1; }
oexec sh -c "test ! -f $RES/i1.json" || { echo "FAIL: verdict written on abort"; exit 1; }
echo "OK aborted, no verdict"

echo ""; echo "ALL GATE SMOKE CLAIMS PASSED"
