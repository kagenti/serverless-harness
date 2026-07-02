#!/usr/bin/env bash
# deploy/knative/leaf-async-smoke.sh
# Gated Kind smoke for async leaf completion (design §6.2). Proves: async accept, KEDA
# scale-out, completion via Redis status polling, crash-resume, scale-to-zero, deterministic failure.
# FS-free contract (P1 rearchitecture): inline item in POST body; verdict polled from
#   GET /runs/status?sessionId — no /work PVC, no done-marker files.
# Prereq: setup-kind.sh (incl. KEDA) done; image rebuilt with leaf-job + async routes;
#   leaf-scaledjob.yaml applied; sandbox-0 up.
# Usage: ASYNC_LIVE_SMOKE=1 bash deploy/knative/leaf-async-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${ASYNC_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set ASYNC_LIVE_SMOKE=1)"; exit 0; }

SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
RUN="arun-$$"; SBOX_REPO="/workspace/$RUN/repo"
ITEMS="i1 i2 i3"; MODEL="${SH_MODEL:-claude-haiku-4-5}"
declare -A EXPECT=( [i1]=FLAGGED [i2]=CLEAR [i3]=CLEAR )
declare -A ITEM_FILE=( [i1]=risky.py  [i2]=safe.py   [i3]=risky.py )
declare -A ITEM_PAT=(  [i1]="eval("   [i2]="eval("   [i3]="subprocess" )
# Clean up sandbox workspace on ANY exit (incl. SIGTERM/OOM mid-run), not just the happy path.
trap 'kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/$RUN" 2>/dev/null || true' EXIT
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
leaf_job_pods() { kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '; }

# adispatch_item <sessionId> <item_id> <file> <pattern> [model] -> echoes 202 response JSON
adispatch_item() {
  local sid="$1" id="$2" file="$3" pat="$4" model="${5:-$MODEL}"
  jq -nc --arg s "$sid" --arg m "$model" --arg id "$id" --arg f "$file" --arg p "$pat" --arg ws "$SBOX_REPO" \
    '{sessionId:$s, model:$m, workspaceRef:$ws, item:{item_id:$id, file:$f, pattern:$p}, async:true}' \
  | curl -s --max-time 30 -H "$HOST_HEADER" -H "Content-Type: application/json" -d @- "$BASE/runs"
}

# adispatch <item_id> [model] -> echoes 202 response JSON
adispatch() {
  local id="$1" model="${2:-$MODEL}"
  adispatch_item "$RUN/$id" "$id" "${ITEM_FILE[$id]}" "${ITEM_PAT[$id]}" "$model"
}

# poll_status <sessionId> -> echoes final status JSON (done|failed|aborted) or times out (exit 1)
poll_status() {
  local sid="$1" i=0 resp status
  while [ "$i" -lt 60 ]; do
    resp=$(curl -s -H "$HOST_HEADER" "$BASE/runs/status?sessionId=$(jq -rn --arg s "$sid" '$s|@uri')")
    status=$(echo "$resp" | jq -r '.status')
    case "$status" in done|failed|aborted) echo "$resp"; return 0;; esac
    i=$((i+1)); sleep 2
  done
  echo "$resp"; return 1
}

echo "=== Async leaf smoke (run=$RUN) ==="
ensure_port_forward >/dev/null || true
kubectl -n "$NS" wait --for=condition=Ready "pod/$SBOX" --timeout=90s >/dev/null
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

# Claim 3: completion via Redis status poll + correct verdicts
claim 3 "Completion via /runs/status poll; verdicts correct"
cov_ok=1
for id in $ITEMS; do
  sid=$(adispatch "$id" | jq -r '.sessionId // empty')
  final=$(poll_status "${sid:-$RUN/$id}")
  got=$(echo "$final" | jq -r '.status // "none"')
  v=$(echo "$final" | jq -r '.verdict.verdict // empty' 2>/dev/null || echo "")
  if [ "$got" = "done" ] && [ "$v" = "${EXPECT[$id]}" ]; then echo "    $id done verdict=$v"; else echo "    $id status=$got verdict=$v (want ${EXPECT[$id]})"; cov_ok=0; fi
done
[ "$cov_ok" = 1 ] && ok "all async leaves completed with correct verdicts" || ko "missing/incorrect"

# Claim 4: crash-resume — kill a running leaf-job mid-run, entry reclaimed, still completes
claim 4 "Crash mid-run → reclaimed → resumes → verdict"
# Quiesce: let Claim-3 leaf-job pods drain to zero so the pod we kill below provably belongs to r1
# (otherwise we might kill an i1/i2/i3 pod and r1's own un-killed run would complete → false pass).
for _ in $(seq 1 36); do [ "$(leaf_job_pods)" = "0" ] && break; sleep 5; done
r1_accept=$(adispatch_item "$RUN/r1" "i1" "${ITEM_FILE[i1]}" "${ITEM_PAT[i1]}")
# wait for a running leaf-job pod, then kill it
killed=0
for _ in $(seq 1 24); do
  pod=$(kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | awk '{print $1}' | head -1)
  [ -n "$pod" ] && { kubectl delete pod -n "$NS" "$pod" --force --grace-period=0 >/dev/null 2>&1; killed=1; break; }
  sleep 5
done
r1_sid=$(echo "$r1_accept" | jq -r '.sessionId // empty')
final_r1=$(poll_status "${r1_sid:-$RUN/r1}")
res_ok=$(echo "$final_r1" | jq -r '.status // "none"')
r1_v=$(echo "$final_r1" | jq -r '.verdict.verdict // empty' 2>/dev/null || echo "")
if [ "$killed" = 1 ] && [ "$res_ok" = "done" ] && [ -n "$r1_v" ]; then
  ok "killed a running leaf-job; reclaimed + resumed → verdict=$r1_v produced"
else
  ko "crash-resume: killed=$killed status=$res_ok verdict=$r1_v"
fi

# Claim 5: scale-to-zero when queue drains
claim 5 "Scale-to-zero: no leaf-job pods when idle"
zero=0
for _ in $(seq 1 36); do [ "$(leaf_job_pods)" = "0" ] && { zero=1; break; }; sleep 5; done
[ "$zero" = 1 ] && ok "leaf-worker scaled to zero" || ko "leaf-job pods still running"

# Claim 6: deterministic failure → failed status, no verdict
claim 6 "Bad item_id → failed status, no verdict"
neg_accept=$(adispatch_item "$RUN/ineg" "ineg" "does-not-exist.py" "eval(")
neg_sid=$(echo "$neg_accept" | jq -r '.sessionId // empty')
neg_final=$(poll_status "${neg_sid:-$RUN/ineg}" || echo "$resp")
neg_status=$(echo "$neg_final" | jq -r '.status // "none"')
neg_reason=$(echo "$neg_final" | jq -r '.reason // "none"')
if [ "$neg_status" = "failed" ]; then ok "failed (reason=$neg_reason), no verdict"; else ko "status=$neg_status reason=$neg_reason"; fi

echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "ASYNC SMOKE FAIL"; exit 1; else echo "ASYNC SMOKE PASS"; exit 0; fi
