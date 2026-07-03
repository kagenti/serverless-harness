#!/usr/bin/env bash
# deploy/knative/e6-saturation.sh
# E6: per-sandbox saturation curve. Pins one sandbox, sweeps concurrent leaves over
# E6_LADDER, and reports the knee (recommended KAGENTI_SANDBOX_CAP) + the C=1 duty cycle
# (=> derived N). Gate: hard sanity floor (knee >= E6_MIN_CONCURRENCY);
# the knee/N themselves are reported. Then a feed-back check runs the pool at the derived
# CAP and asserts leases never exceed it. Records results to EXPERIMENTS.md.
#
# Usage: E6_LIVE=1 [E6_LADDER="1 2 4 8 16"] bash deploy/knative/e6-saturation.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091  # lib.sh is co-located; not available to shellcheck at lint time
source ./lib.sh

[ "${E6_LIVE:-0}" = "1" ] || { echo "SKIP (set E6_LIVE=1)"; exit 0; }

# Restore ksvc to service.yaml defaults on any exit (normal or error) so a partial run
# never leaves the ksvc mutated for the next smoke. Installed AFTER the gate so an
# ungated SKIP run never issues a kubectl call.
trap 'restore_ksvc_env' EXIT

LADDER="${E6_LADDER:-1 2 4 8 16}"
DEGRADE_X="${E6_DEGRADE_X:-2}"
MIN_C="${E6_MIN_CONCURRENCY:-4}"
PIN="${KAGENTI_SANDBOX_POD:-sandbox-0}"   # single-pod pin for the curve
REF="branch-0"

echo "--- E6: saturation (ladder='$LADDER' pin=$PIN degradeX=$DEGRADE_X floor=$MIN_C) ---"
ensure_port_forward >/dev/null || true
wait_gitd 120 || { echo "gitd not ready"; exit 1; }

# Pin all leaves to one sandbox + enable exec timing; force a new revision and wait Ready.
# Remove KAGENTI_SANDBOX_POOL_SELECTOR so the single-pod pin actually takes effect
# (the pool selector has precedence and would otherwise ignore KAGENTI_SANDBOX_POD).
set_ksvc_env KAGENTI_SANDBOX_POD="$PIN" KAGENTI_SANDBOX_POOL_SELECTOR- KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000

# Fire C concurrent converge-leaves at ref branch-0; echo "<throughput> <p95ms>".
run_rung() {
  local c="$1" d; d="$(mktemp -d)"
  local t0 t1 pids=""
  t0=$(now_ms)
  local i=0
  while [ "$i" -lt "$c" ]; do
    ( ts=$(now_ms)
      dispatch_converge "e6-$c-$i-$$" "e6" "marker.txt" "$REF" "$REF" >/dev/null 2>&1
      echo $(( $(now_ms) - ts )) > "$d/$i.ms" ) & pids="$pids $!"
    i=$((i + 1))
  done
  # shellcheck disable=SC2086
  wait $pids
  t1=$(now_ms)
  local wall=$(( t1 - t0 )); [ "$wall" -lt 1 ] && wall=1
  local thr; thr=$(awk -v c="$c" -v w="$wall" 'BEGIN{printf "%.3f", c/(w/1000.0)}')
  local p95
  # Guard the glob: if all dispatches in this rung failed (no .ms files), record a large
  # sentinel p95 rather than aborting under set -e. A fully-failed rung is a visible
  # degraded data point rather than a script crash.
  if ls "$d"/*.ms >/dev/null 2>&1; then
    p95=$(cat "$d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
  else
    p95=999999
    thr=0
  fi
  rm -rf "$d"
  echo "$thr $p95"
}

# Drain any harness pods left over from the pin's prior revision (or earlier runs) so the C=1
# leaf cold-starts a FRESH pod whose log holds only its own [exec-timing] lines. Without this,
# the C=1 duty-cycle sum picks up execs accumulated by a lingering warm pod across many leaves.
wait_for_zero_pods 90 || true

POINTS="[]"
EXEC_MS=0
BASE_WALL=0
for c in $LADDER; do
  read -r thr p95 <<<"$(run_rung "$c")"
  echo "  c=$c throughput=$thr p95Ms=$p95"
  POINTS=$(jq -c --argjson c "$c" --argjson t "$thr" --argjson p "$p95" \
    '. + [{c:$c, throughput:$t, p95Ms:$p}]' <<<"$POINTS")
  # Duty cycle MUST be captured at C=1, while the harness pod that served it is still Running:
  # Knative scales it to zero within the retention window before the whole sweep finishes, so a
  # post-sweep read finds an idle/absent pod (execMs=0). Sum exec-timing across the pods live now.
  if [ "$c" = 1 ]; then
    EXEC_MS=$(for p in $(kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | awk '{print $1}'); do
        sum_exec_ms "$p"; done | awk '{s+=$1} END{printf "%d", s+0}')
    BASE_WALL="$p95"   # c=1 p95 == the single leaf's wall time (denominator for duty cycle)
  fi
done

# Knee (recommended CAP) + sanity floor — always computed from the curve.
# shellcheck disable=SC2016  # single quotes intentional: TypeScript literal, not bash expansion
read -r KNEE FLOOR <<<"$(npx tsx -e '
  import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
  const pts = JSON.parse(process.argv[1]);
  const knee = detectKnee(pts, Number(process.argv[2]));
  process.stdout.write(`${knee} ${sanityFloorPass(knee, Number(process.argv[3]))}`);
' "$POINTS" "$DEGRADE_X" "$MIN_C")"

# Duty cycle (C=1) -> derived N. Guarded: if exec timing was not captured (EXEC_MS=0) the tested
# derivedRatio throws on duty<=0 by design, so report NA rather than aborting and losing the knee.
if [ "${EXEC_MS:-0}" -gt 0 ] && [ "${BASE_WALL:-0}" -gt 0 ]; then
  # shellcheck disable=SC2016
  read -r DUTY NRATIO <<<"$(npx tsx -e '
    import { dutyCycle, derivedRatio } from "../../experiments/src/sharing.ts";
    const d = dutyCycle(Number(process.argv[1]), Number(process.argv[2]));
    process.stdout.write(`${d.toFixed(3)} ${derivedRatio(d)}`);
  ' "$EXEC_MS" "$BASE_WALL")"
else
  DUTY=NA; NRATIO=NA
fi

echo "  knee(CAP)=$KNEE dutyCycle=$DUTY derivedN=$NRATIO floorPass=$FLOOR execMs=$EXEC_MS baseWall=$BASE_WALL"

# --- Feed-back check: pool at the derived CAP, leases never exceed it ---
# Unpin the single sandbox and restore pool mode so the burst runs against the full pool
# at the derived CAP (without restoring the selector, neither pod nor pool is set, causing
# null selection where max_leases_across_pool returns 0 and the MAXL <= KNEE check trivially passes).
set_ksvc_env KAGENTI_SANDBOX_POD- KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=default KAGENTI_SANDBOX_CAP="$KNEE"
BURST=$(( KNEE * 3 ))
fb_pids=""
for i in $(seq 1 "$BURST"); do
  ( dispatch_converge "e6-fb-$i-$$" "e6" "marker.txt" "$REF" "$REF" >/dev/null 2>&1 ) & fb_pids="$fb_pids $!"
done
MAXL=0
for _ in $(seq 1 30); do m=$(max_leases_across_pool); [ "$m" -gt "$MAXL" ] && MAXL="$m"; sleep 0.5; done
# shellcheck disable=SC2086
wait $fb_pids
# shellcheck disable=SC2015  # ok/ko are counters, not exits; C may run when A is true is intentional
[ "$MAXL" -le "$KNEE" ] && ok "feed-back: max leases/pod $MAXL <= CAP $KNEE" \
  || ko "feed-back: max leases/pod $MAXL exceeded CAP $KNEE"

# --- Gate + record ---
if [ "$FLOOR" = "true" ] && [ "$FAIL" = 0 ]; then GATE=yes; else GATE=no; fi
echo "E6_RESULT knee=$KNEE dutyCycle=$DUTY derivedN=$NRATIO floorPass=$FLOOR maxLeases=$MAXL pass=$GATE"
{
  echo ""
  echo "### E6 run $(cat /proc/sys/kernel/hostname 2>/dev/null || echo host)"
  echo "- ladder: $LADDER"
  echo "- points: $POINTS"
  echo "- knee (recommended CAP): $KNEE"
  echo "- duty cycle (C=1): $DUTY  =>  derived N ~= $NRATIO : 1"
  echo "- sanity floor (>= $MIN_C): $FLOOR"
  echo "- feed-back max leases/pod at CAP=$KNEE: $MAXL"
  echo "- verdict: $GATE"
} >> EXPERIMENTS.md

[ "$GATE" = yes ] || exit 1
