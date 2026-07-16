#!/usr/bin/env bash
# deploy/knative/e1-benefit.sh
# E1 benefit arm (Plan C, spec §7): run the same sampled SWE-bench deck to completion at a matched
# offered concurrency C under two topologies — dedicated (KAGENTI_SANDBOX_CAP=1) vs shared@N — and
# report reservation-seconds/leaf (Σ pool-lease-seconds ÷ completed leaves), p95, throughput, peak
# pods, and the dedicated:shared benefit ratio with a p95 guardrail. OCP-only (swebench pool image).
# Gated by E1B_LIVE=1.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091  # lib.sh is co-located; not available to shellcheck at lint time
source ./lib.sh
[ "${E1B_LIVE:-0}" = "1" ] || { echo "SKIP (set E1B_LIVE=1)"; exit 0; }
trap 'restore_ksvc_env' EXIT

C="${E1B_CONCURRENCY:-4}"
N="${E1B_SHARED_CAP:-8}"          # shared@N cap (default = a mid knee; override from the E6 knee)
PER_BUCKET="${E1B_PER_BUCKET:-2}"
SEED="${E1B_SEED:-7}"
DEGRADE_X="${E1B_DEGRADE_X:-2}"
DECK="${DECK:-$(cd ../.. && pwd)/experiments/swebench/deck.json}"
PRED="${PREDICTIONS:-${LOG_DIR:-/tmp/kagenti/planC}/predictions-e1.jsonl}"
mkdir -p "$(dirname "$PRED")"

# The deck slice (deterministic).
# shellcheck disable=SC2016
ITEMS=$(WORKLOAD=swebench DECK="$DECK" npx tsx -e '
  import { getWorkloadProvider } from "../../experiments/src/workload.ts";
  const p = getWorkloadProvider(process.env, process.env.DECK);
  process.stdout.write(JSON.stringify(p.sliceItems({ perBucket: '"$PER_BUCKET"', seed: '"$SEED"' })));
')
NITEMS=$(jq 'length' <<<"$ITEMS")

SWEEP_MAX_SHARED="${E1B_MAX_SCALE:-20}"

run_arm() {  # $1=arm label ; $2=cap ; echoes "resvSecPerLeaf p95Ms throughput peakPods"
  local arm="$1" cap="$2" f lat_d done_n=0 pids="" t0 wall p95 thr resv peak
  set_ksvc_env KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=swebench KAGENTI_SANDBOX_CAP="$cap"
  set_scale 1 "$SWEEP_MAX_SHARED"   # enough harness pods to offer C; SWEEP_MAX_SHARED default below
  : >"$PRED"
  f=$(mktemp); lat_d=$(mktemp -d)
  local sampler; sampler=$(start_pool_lease_sampler "$f")
  t0=$(now_ms); local i=0
  # NOTE: a `for row in $(jq -c '.[]' <<<"$ITEMS")` loop word-splits each JSON object on the spaces
  # in the embedded problem statement (the same bug fixed in Task 4). Use a newline-safe read loop
  # fed via process substitution (NOT a pipe — a pipe would subshell the loop and lose pids/jobs).
  while IFS= read -r row; do
    ( id=$(jq -r '.instanceId' <<<"$row"); post=$(jq -c '.post' <<<"$row")
      ts=$(now_ms); resp=$(dispatch_solve "e1b-$arm-$RANDOM-$i-$$" "$post" || true)
      echo $(( $(now_ms) - ts )) > "$lat_d/$i.ms"
      append_prediction "$PRED" "$id" "${SH_MODEL:-claude-haiku-4-5}" "$resp" ) &
    pids="$pids $!"; i=$((i + 1))
    # cap offered concurrency at C
    while [ "$(jobs -rp | wc -l)" -ge "$C" ]; do sleep 0.5; done
  done < <(jq -c '.[]' <<<"$ITEMS")
  # shellcheck disable=SC2086
  wait $pids
  wall=$(( $(now_ms) - t0 )); [ "$wall" -lt 1 ] && wall=1
  stop_sampler "$sampler"
  resv=$(pool_lease_seconds_from "$f")
  peak=$(sort -n "$f" | tail -1)
  done_n=$(find "$lat_d" -name '*.ms' | wc -l | tr -d ' ')
  p95=$(cat "$lat_d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
  thr=$(awk -v n="$done_n" -v w="$wall" 'BEGIN{printf "%.3f", n/(w/1000.0)}')
  local rspl; rspl=$(awk -v r="$resv" -v n="$done_n" 'BEGIN{printf "%.1f", (n>0?r/n:0)}')
  rm -f "$f"; rm -rf "$lat_d"
  echo "$rspl $p95 $thr ${peak:-0}"
}

echo "--- E1 benefit: $NITEMS leaves, C=$C, dedicated(cap=1) vs shared@N($N) ---"
read -r ded_r ded_p ded_t ded_peak <<<"$(run_arm dedicated 1)"
read -r shr_r shr_p shr_t shr_peak <<<"$(run_arm shared "$N")"
echo "  dedicated: resvSecPerLeaf=$ded_r p95Ms=$ded_p throughput=$ded_t peakPods=$ded_peak"
echo "  shared@$N: resvSecPerLeaf=$shr_r p95Ms=$shr_p throughput=$shr_t peakPods=$shr_peak"

# shellcheck disable=SC2016
BEN=$(npx tsx -e '
  import { reservationBenefit } from "../../experiments/src/sharing.ts";
  const d = JSON.parse(process.argv[1]), s = JSON.parse(process.argv[2]);
  const r = reservationBenefit(d, s, Number(process.argv[3]));
  process.stdout.write(`${r.ratio} ${r.withinDegrade}`);
' "$(jq -nc --arg r "$ded_r" --arg p "$ded_p" --arg t "$ded_t" --arg k "$ded_peak" '{arm:"dedicated",resvSecPerLeaf:($r|tonumber),p95Ms:($p|tonumber),throughput:($t|tonumber),peakPods:($k|tonumber)}')" \
  "$(jq -nc --arg r "$shr_r" --arg p "$shr_p" --arg t "$shr_t" --arg k "$shr_peak" '{arm:"shared",resvSecPerLeaf:($r|tonumber),p95Ms:($p|tonumber),throughput:($t|tonumber),peakPods:($k|tonumber)}')" \
  "$DEGRADE_X")
read -r RATIO WITHIN <<<"$BEN"
echo "E1B_RESULT benefit=${RATIO}x withinDegrade=$WITHIN dedicated_resv=$ded_r shared_resv=$shr_r"
{
  echo ""
  echo "### E1 benefit run $(hostname 2>/dev/null || echo host)"
  echo "- leaves=$NITEMS C=$C sharedCap=$N seed=$SEED"
  echo "- dedicated: resvSec/leaf=$ded_r p95=$ded_p thr=$ded_t peakPods=$ded_peak"
  echo "- shared@$N: resvSec/leaf=$shr_r p95=$shr_p thr=$shr_t peakPods=$shr_peak"
  echo "- benefit (dedicated:shared) = ${RATIO}x (withinDegrade=$WITHIN)"
} >> EXPERIMENTS.md
