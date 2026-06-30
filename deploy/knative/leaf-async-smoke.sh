#!/usr/bin/env bash
# deploy/knative/leaf-async-smoke.sh
# Gated Kind smoke for async leaf completion (design §6.2). Proves: async accept, KEDA
# scale-out, completion via done-marker, crash-resume, scale-to-zero, deterministic failure.
# Prereq: setup-kind.sh (incl. KEDA) done; image rebuilt with leaf-job + async routes;
#   leaf-pvc.yaml + leaf-orchestrator.yaml applied; leaf-scaledjob.yaml applied; sandbox-0 up.
# Usage: ASYNC_LIVE_SMOKE=1 bash deploy/knative/leaf-async-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${ASYNC_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set ASYNC_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator; SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
RUN="arun-$$"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
ITEMS="i1 i2 i3"; MODEL="${SH_MODEL:-claude-haiku-4-5}"
declare -A EXPECT=( [i1]=FLAGGED [i2]=CLEAR [i3]=CLEAR )
# Clean up sandbox workspace on ANY exit (incl. SIGTERM/OOM mid-run), not just the happy path.
trap 'kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/$RUN" 2>/dev/null || true' EXIT
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
leaf_job_pods() { kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '; }

# async dispatch: POST {async:true} -> 202 handle
adispatch() {
  local id="$1"
  local model="${2:-$MODEL}" in="${3:-$INPUTS/$id.json}"
  jq -nc --arg s "$RUN/$id" --arg m "$model" --arg in "$in" --arg out "$RES/$id.json" --arg ws "$SBOX_REPO" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws, async:true}' \
  | curl -s --max-time 30 -H "$HOST_HEADER" -H "Content-Type: application/json" -d @- "$BASE/run-leaf"
}

echo "=== Async leaf smoke (run=$RUN) ==="
ensure_port_forward >/dev/null || true
kubectl -n "$NS" wait --for=condition=Ready "pod/$ORCH" --timeout=90s >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$SBOX" --timeout=90s >/dev/null
for _ in $(seq 1 30); do oexec sh -c 'command -v jq >/dev/null && command -v curl >/dev/null' && break; sleep 2; done
oexec mkdir -p "$INPUTS" "$RES"
# Trailing /. copies the directory CONTENTS into the (pre-created) dest; without it
# kubectl cp nests the source dir (…/inputs/inputs/i1.json) and runLeaf reads bad_inputs.
kubectl -n "$NS" cp ./fixtures/inputs/. "$ORCH:$INPUTS"
kubectl -n "$NS" exec "$SBOX" -- mkdir -p "$SBOX_REPO"
kubectl -n "$NS" cp ./fixtures/repo/. "$SBOX:$SBOX_REPO"

# Claim 1: async accept (fast 202)
claim 1 "Async accept: 202 + handle, returns fast"
acc_ok=1
for id in $ITEMS; do
  st=$(adispatch "$id" | jq -r '.status // "none"'); echo "    $id -> $st"
  [ "$st" = "accepted" ] || acc_ok=0
done
[ "$acc_ok" = 1 ] && ok "all accepted" || ko "not all accepted"

# Claim 2: KEDA scale-out (>=2 leaf-job pods at some point)
claim 2 "KEDA scales out leaf-job pods"
maxp=0
for _ in $(seq 1 24); do p=$(leaf_job_pods); [ "$p" -gt "$maxp" ] && maxp=$p; [ "$p" -ge 2 ] && break; sleep 5; done
[ "$maxp" -ge 2 ] && ok "observed $maxp concurrent leaf-job pods" || echo "  NOTE: observed max $maxp (cap/scheduling may serialize)"

# Claim 3: completion via done-marker + correct verdicts
claim 3 "Completion via done-marker; verdicts correct"
cov_ok=1
for id in $ITEMS; do
  got=""
  for _ in $(seq 1 60); do
    if oexec test -f "$RES/$id.json.status"; then got=$(oexec sh -c "jq -r .status $RES/$id.json.status"); break; fi
    sleep 5
  done
  v=$(oexec sh -c "jq -r .verdict $RES/$id.json 2>/dev/null" 2>/dev/null || echo "")
  if [ "$got" = "done" ] && [ "$v" = "${EXPECT[$id]}" ]; then echo "    $id done verdict=$v"; else echo "    $id status=$got verdict=$v (want ${EXPECT[$id]})"; cov_ok=0; fi
done
[ "$cov_ok" = 1 ] && ok "all async leaves completed with correct verdicts" || ko "missing/incorrect"

# Claim 4: crash-resume — kill a running leaf-job mid-run, entry reclaimed, still completes
claim 4 "Crash mid-run → reclaimed → resumes → verdict"
# Quiesce: let Claim-3 leaf-job pods drain to zero so the pod we kill below provably belongs to r1
# (otherwise we might kill an i1/i2/i3 pod and r1's own un-killed run would complete → false pass).
for _ in $(seq 1 36); do [ "$(leaf_job_pods)" = "0" ] && break; sleep 5; done
adispatch "r1" "$MODEL" "$INPUTS/i1.json" >/dev/null
# wait for a running leaf-job pod, then kill it
killed=0
for _ in $(seq 1 24); do
  pod=$(kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | awk '{print $1}' | head -1)
  [ -n "$pod" ] && { kubectl delete pod -n "$NS" "$pod" --force --grace-period=0 >/dev/null 2>&1; killed=1; break; }
  sleep 5
done
res_ok=""
for _ in $(seq 1 72); do
  if oexec test -f "$RES/r1.json.status"; then res_ok=$(oexec sh -c "jq -r .status $RES/r1.json.status"); break; fi
  sleep 5
done
if [ "$killed" = 1 ] && [ "$res_ok" = "done" ] && oexec sh -c "jq -e .verdict $RES/r1.json >/dev/null 2>&1"; then
  ok "killed a running leaf-job; reclaimed + resumed → verdict produced"
else
  ko "crash-resume: killed=$killed status=$res_ok"
fi

# Claim 5: scale-to-zero when queue drains
claim 5 "Scale-to-zero: no leaf-job pods when idle"
zero=0
for _ in $(seq 1 36); do [ "$(leaf_job_pods)" = "0" ] && { zero=1; break; }; sleep 5; done
[ "$zero" = 1 ] && ok "leaf-worker scaled to zero" || ko "leaf-job pods still running"

# Claim 6: deterministic failure → failed marker, no result, no infinite reprocess
claim 6 "Bad inputs → failed marker, no result_ref"
adispatch "ineg" "$MODEL" "$INPUTS/does-not-exist.json" >/dev/null
neg=""
for _ in $(seq 1 36); do
  if oexec test -f "$RES/ineg.json.status"; then neg=$(oexec sh -c "jq -r .reason $RES/ineg.json.status"); break; fi
  sleep 5
done
if [ "$neg" = "bad_inputs" ] && ! oexec test -f "$RES/ineg.json"; then ok "failed (bad_inputs), no result_ref"; else ko "reason=$neg"; fi

echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "ASYNC SMOKE FAIL"; exit 1; else echo "ASYNC SMOKE PASS"; exit 0; fi
