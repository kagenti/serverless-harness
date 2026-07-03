#!/usr/bin/env bash
# deploy/knative/e7-converge-contention.sh
# E7: converge/fetch contention + mixed-ref correctness. Fires E7_REFS leaves that each
# converge a DISTINCT ref (branch-0..branch-{E7_REFS-1}) on one pinned sandbox. Hard gate:
# every leaf's worktree observed ONLY its own ref's marker (no cross-contamination) — this
# is the live mixed-ref validation deferred from P2 Task 7. Reports converge-wait contention
# (total exec ms under the shared /workspace/.sh-fetch.lock as concurrency rises).
#
# Usage: E7_LIVE=1 [E7_REFS=8] bash deploy/knative/e7-converge-contention.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091  # lib.sh is co-located; not available to shellcheck at lint time
source ./lib.sh

[ "${E7_LIVE:-0}" = "1" ] || { echo "SKIP (set E7_LIVE=1)"; exit 0; }

# Restore ksvc to service.yaml defaults on any exit (normal or error) so a partial run
# never leaves the ksvc mutated for the next smoke. Installed AFTER the gate so an
# ungated SKIP run never issues a kubectl call.
trap 'restore_ksvc_env' EXIT

REFS="${E7_REFS:-8}"
PIN="${KAGENTI_SANDBOX_POD:-sandbox-0}"

echo "--- E7: converge contention + mixed-ref (refs=$REFS pin=$PIN) ---"
ensure_port_forward >/dev/null || true
wait_gitd 120 || { echo "gitd not ready"; exit 1; }
# Remove KAGENTI_SANDBOX_POOL_SELECTOR so the single-pod pin actually takes effect
# (the pool selector has precedence and would otherwise ignore KAGENTI_SANDBOX_POD).
set_ksvc_env KAGENTI_SANDBOX_POD="$PIN" KAGENTI_SANDBOX_POOL_SELECTOR- KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000

d="$(mktemp -d)"; pids=""; t0=$(now_ms)
i=0
while [ "$i" -lt "$REFS" ]; do
  ref="branch-$i"
  # Each leaf reviews marker.txt for its OWN branch name; a correct verdict requires the
  # worktree to be pinned at that ref. We capture the terminal JSON and (separately) read
  # the marker the leaf's worktree actually held.
  ( dispatch_converge "e7-$i-$$" "e7" "marker.txt" "$ref" "$ref" > "$d/$ref.json" 2>&1 ) & pids="$pids $!"
  i=$((i + 1))
done
# shellcheck disable=SC2086
wait $pids
t1=$(now_ms)

# Read each leaf's worktree marker from the pinned pod (worktrees survive until cleanup;
# we read via a fresh exec keyed by the runId path the harness derived).
OBS="[]"
i=0
while [ "$i" -lt "$REFS" ]; do
  ref="branch-$i"; sid="e7-$i-$$"
  # toSessionId sanitizes sid; the worktree path is /workspace/leaves/<sanitized sid>.
  wt="/workspace/leaves/${sid//[^A-Za-z0-9._-]/-}"
  marker=$(kubectl -n "$NS" exec "$PIN" -- sh -c "cat '$wt/marker.txt' 2>/dev/null" | tr -d '[:space:]')
  marker="${marker:-MISSING}"
  OBS=$(jq -c --arg r "$sid" --arg e "$ref" --arg o "$marker" \
    '. + [{runId:$r, expectedRef:$e, observedMarker:$o}]' <<<"$OBS")
  i=$((i + 1))
done

# Hard correctness gate via the tested checker.
# shellcheck disable=SC2016  # single quotes intentional: TypeScript code literal, not bash expansion
CONSISTENT=$(npx tsx -e '
  import { worktreeConsistent } from "../../experiments/src/sharing.ts";
  const r = worktreeConsistent(JSON.parse(process.argv[1]));
  process.stdout.write(r.ok ? "ok" : "mismatch:" + JSON.stringify(r.mismatches));
' "$OBS")

# shellcheck disable=SC2015  # ok/ko are counters, not exits; the || branch is intentional
[ "$CONSISTENT" = "ok" ] && ok "mixed-ref: every leaf saw only its own ref" \
  || ko "mixed-ref cross-contamination: $CONSISTENT"

CONVERGE_MS=$(sum_exec_ms "$(kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
  --field-selector=status.phase=Running --no-headers 2>/dev/null | awk 'NR==1{print $1}')")
WALL=$(( t1 - t0 ))
echo "E7_RESULT refs=$REFS wallMs=$WALL totalExecMs=${CONVERGE_MS:-0} consistent=$([ "$CONSISTENT" = ok ] && echo yes || echo no)"
{
  echo ""
  echo "### E7 run"
  echo "- refs (distinct, concurrent): $REFS"
  echo "- mixed-ref consistency: $CONSISTENT"
  echo "- wall ms: $WALL ; total sandbox exec ms (converge+tools): ${CONVERGE_MS:-0}"
  echo "- observations: $OBS"
} >> EXPERIMENTS.md
rm -rf "$d"

[ "$FAIL" = 0 ] || exit 1
