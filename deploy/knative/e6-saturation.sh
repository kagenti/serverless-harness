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

LADDER="${E6_LADDER:-1 2 4 8 16}"
DEGRADE_X="${E6_DEGRADE_X:-2}"
MIN_C="${E6_MIN_CONCURRENCY:-4}"
PIN="${KAGENTI_SANDBOX_POD:-sandbox-0}"   # single-pod pin for the curve
REF="branch-0"

echo "--- E6: saturation (ladder='$LADDER' pin=$PIN degradeX=$DEGRADE_X floor=$MIN_C) ---"
ensure_port_forward >/dev/null || true
wait_gitd 120 || { echo "gitd not ready"; exit 1; }

# Pin all leaves to one sandbox + enable exec timing; force a new revision and wait Ready.
kubectl set env ksvc/"$KSVC" -n "$NS" \
  KAGENTI_SANDBOX_POD="$PIN" KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000 >/dev/null
wait_ksvc_ready

# Fire C concurrent converge-leaves at ref branch-0; echo "<throughput> <p95ms>".
run_rung() {
  local c="$1" d; d="$(mktemp -d)"
  local t0 t1 pids=""
  t0=$(date +%s%3N)
  local i=0
  while [ "$i" -lt "$c" ]; do
    ( ts=$(date +%s%3N)
      dispatch_converge "e6-$c-$i-$$" "e6" "marker.txt" "$REF" "$REF" >/dev/null 2>&1
      echo $(( $(date +%s%3N) - ts )) > "$d/$i.ms" ) & pids="$pids $!"
    i=$((i + 1))
  done
  # shellcheck disable=SC2086
  wait $pids
  t1=$(date +%s%3N)
  local wall=$(( t1 - t0 )); [ "$wall" -lt 1 ] && wall=1
  local thr; thr=$(awk -v c="$c" -v w="$wall" 'BEGIN{printf "%.3f", c/(w/1000.0)}')
  local p95; p95=$(cat "$d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
  rm -rf "$d"
  echo "$thr $p95"
}

POINTS="[]"
for c in $LADDER; do
  read -r thr p95 <<<"$(run_rung "$c")"
  echo "  c=$c throughput=$thr p95Ms=$p95"
  POINTS=$(jq -c --argjson c "$c" --argjson t "$thr" --argjson p "$p95" \
    '. + [{c:$c, throughput:$t, p95Ms:$p}]' <<<"$POINTS")
done

# C=1 duty cycle: sum exec ms from the (single) harness pod that served the c=1 leaf.
HARNESS_POD=$(kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
  --field-selector=status.phase=Running --no-headers 2>/dev/null | awk 'NR==1{print $1}')
EXEC_MS=$(sum_exec_ms "$HARNESS_POD"); EXEC_MS="${EXEC_MS:-0}"
BASE_WALL=$(jq -r '.[0].p95Ms' <<<"$POINTS")   # c=1 p95 ~= the single leaf wall time

# Compute knee, duty cycle, derived N, floor verdict via the tested analysis functions.
# shellcheck disable=SC2016  # single quotes intentional: TypeScript code literal, not bash expansion
read -r KNEE DUTY NRATIO FLOOR <<<"$(npx tsx -e '
  import { detectKnee, dutyCycle, derivedRatio, sanityFloorPass } from "./experiments/src/sharing.ts";
  const pts = JSON.parse(process.argv[1]);
  const knee = detectKnee(pts, Number(process.argv[2]));
  const duty = dutyCycle(Number(process.argv[3]), Number(process.argv[4]));
  const n = derivedRatio(duty);
  const floor = sanityFloorPass(knee, Number(process.argv[5]));
  process.stdout.write(`${knee} ${duty.toFixed(3)} ${n} ${floor}`);
' "$POINTS" "$DEGRADE_X" "$EXEC_MS" "$BASE_WALL" "$MIN_C")"

echo "  knee(CAP)=$KNEE dutyCycle=$DUTY derivedN=$NRATIO floorPass=$FLOOR"

# --- Feed-back check: pool at the derived CAP, leases never exceed it ---
kubectl set env ksvc/"$KSVC" -n "$NS" \
  KAGENTI_SANDBOX_POD- KAGENTI_SANDBOX_CAP="$KNEE" >/dev/null   # unpin, set CAP=knee
wait_ksvc_ready
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
