#!/usr/bin/env bash
# deploy/knative/leaf-cron-smoke.sh
# Gated Kind smoke for scheduled leaf dispatch (Archetype C, design §6.2). Proves: the CronJob's
# dispatcher enqueues a config list onto the async path (leaves complete with correct verdicts) and
# a re-run of the SAME fire is idempotent (same fire-stamped paths, no second run dir).
# Deterministic: fires with `kubectl create job --from=cronjob/leaf-cron` (no waiting on a cron tick).
# Prereq: async path deployed (KEDA + ScaledJob); image rebuilt with cron-dispatch.ts; leaf-cron.yaml
#   applied; sandbox-0 + leaf-work PVC up.
# Usage: CRON_LIVE_SMOKE=1 bash deploy/knative/leaf-cron-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${CRON_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set CRON_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator; SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
FIRE="cronfire-$$"                       # the manual fire id (becomes the Job name -> JOB_NAME label)
NRES="/work/nightly/$FIRE/results"        # fire-stamped result dir the config templates produce
ITEMS="i1 i2 i3"
declare -A EXPECT=( [i1]=FLAGGED [i2]=CLEAR [i3]=CLEAR )
trap 'kubectl -n "$NS" delete job "$FIRE" --force --grace-period=0 >/dev/null 2>&1 || true; kubectl -n "$NS" exec "$ORCH" -- sh -c "rm -rf /work/nightly/$FIRE" 2>/dev/null || true; kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/nightly" 2>/dev/null || true' EXIT
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
fire_and_wait() {  # create a Job named $FIRE from the cronjob, wait for the dispatcher to finish
  kubectl -n "$NS" delete job "$FIRE" --force --grace-period=0 >/dev/null 2>&1 || true
  kubectl -n "$NS" create job --from=cronjob/leaf-cron "$FIRE" >/dev/null
  kubectl -n "$NS" wait --for=condition=complete "job/$FIRE" --timeout=120s >/dev/null 2>&1 \
    || kubectl -n "$NS" wait --for=condition=failed "job/$FIRE" --timeout=5s >/dev/null 2>&1 || true
}

echo "=== Scheduled leaf dispatch smoke (fire=$FIRE) ==="
kubectl -n "$NS" wait --for=condition=Ready "pod/$ORCH" --timeout=90s >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$SBOX" --timeout=90s >/dev/null
for _ in $(seq 1 30); do oexec sh -c 'command -v jq >/dev/null' && break; sleep 2; done
# seed fixtures at the fixed paths the config references
oexec mkdir -p /work/nightly/inputs
kubectl -n "$NS" cp ./fixtures/inputs/. "$ORCH:/work/nightly/inputs"
kubectl -n "$NS" exec "$SBOX" -- mkdir -p /workspace/nightly/repo
kubectl -n "$NS" cp ./fixtures/repo/. "$SBOX:/workspace/nightly/repo"

# Claim 1: schedule validity (the CronJob exists / applied clean)
claim 1 "CronJob applied and present"
if kubectl -n "$NS" get cronjob leaf-cron >/dev/null 2>&1; then ok "leaf-cron CronJob present"; else ko "leaf-cron CronJob missing"; fi

# Claim 2: a fire dispatches the list; leaves complete with correct verdicts under the fire-stamped dir
claim 2 "Fire dispatches list; leaves complete with correct verdicts"
fire_and_wait
cov_ok=1
for id in $ITEMS; do
  got=""
  for _ in $(seq 1 60); do
    if oexec test -f "$NRES/$id.json.status"; then got=$(oexec sh -c "jq -r .status $NRES/$id.json.status"); break; fi
    sleep 5
  done
  v=$(oexec sh -c "jq -r .verdict $NRES/$id.json 2>/dev/null" 2>/dev/null || echo "")
  if [ "$got" = "done" ] && [ "$v" = "${EXPECT[$id]}" ]; then echo "    $id done verdict=$v"; else echo "    $id status=$got verdict=$v (want ${EXPECT[$id]})"; cov_ok=0; fi
done
[ "$cov_ok" = 1 ] && ok "all dispatched leaves completed with correct verdicts" || ko "missing/incorrect"

# Claim 3: re-running the SAME fire id is idempotent -- the dispatcher re-runs to completion, writes to
# the SAME fire-stamped dir (no second run directory), markers still done with the same verdicts.
claim 3 "Idempotent retry: same fire id -> re-dispatch completes, same paths, no duplicate run dir"
before=$(oexec sh -c 'ls -1d /work/nightly/cronfire-* 2>/dev/null | wc -l' | tr -d ' ')
fire_and_wait
refire_done=0
kubectl -n "$NS" wait --for=condition=complete "job/$FIRE" --timeout=120s >/dev/null 2>&1 && refire_done=1
after=$(oexec sh -c 'ls -1d /work/nightly/cronfire-* 2>/dev/null | wc -l' | tr -d ' ')
still_done=1
for id in $ITEMS; do
  s=$(oexec sh -c "jq -r .status $NRES/$id.json.status" 2>/dev/null || echo "")
  v=$(oexec sh -c "jq -r .verdict $NRES/$id.json 2>/dev/null" 2>/dev/null || echo "")
  { [ "$s" = "done" ] && [ "$v" = "${EXPECT[$id]}" ]; } || still_done=0
done
if [ "$refire_done" = 1 ] && [ "$before" = "$after" ] && [ "$still_done" = 1 ]; then
  ok "re-fire ran+completed, reused id (dirs: $before->$after), markers still done"
else
  ko "refire_done=$refire_done dirs $before->$after still_done=$still_done"
fi

echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "CRON SMOKE FAIL"; exit 1; else echo "CRON SMOKE PASS"; exit 0; fi
