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
# Driver-shell selector (mirrors measure-swebench-runtimes.sh): pool_pod_counts (lib.sh) reads this
# from the driver's own environment, not from the ksvc container env set below via set_ksvc_env.
KAGENTI_SANDBOX_POOL_SELECTOR="${KAGENTI_SANDBOX_POOL_SELECTOR:-sh.kagenti.io/sandbox-pool=swebench}"
DECK="${DECK:-$(cd ../.. && pwd)/experiments/swebench/deck.json}"
PRED="${PREDICTIONS:-${LOG_DIR:-/tmp/kagenti/planC}/predictions-e1.jsonl}"
USAGE="${USAGE:-${LOG_DIR:-/tmp/kagenti/planC}/usage-e1.jsonl}"  # per-leaf token usage for cost pricing
mkdir -p "$(dirname "$PRED")"; mkdir -p "$(dirname "$USAGE")"; : >"$USAGE"
# Health tally (spec §8): only solved leaves count toward resvSec/leaf, p95, throughput; broken
# leaves are excluded and surfaced. Accumulated across both arms from run_arm's emitted counts.
H_SOLVED=0; H_FAILED=0; H_SATURATED=0; H_TRANSPORT=0

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
  set_scale 1 "$SWEEP_MAX_SHARED"   # enough harness pods to offer C (SWEEP_MAX_SHARED set above)
  : >"$PRED"
  f=$(mktemp); lat_d=$(mktemp -d)
  local sampler; sampler=$(start_pool_lease_sampler "$f")
  t0=$(now_ms); local i=0
  # NOTE: a `for row in $(jq -c '.[]' <<<"$ITEMS")` loop word-splits each JSON object on the spaces
  # in the embedded problem statement (the same bug fixed in Task 4). Use a newline-safe read loop
  # fed via process substitution (NOT a pipe — a pipe would subshell the loop and lose pids/jobs).
  while IFS= read -r row; do
    # Status gate (spec §8): write .ms + .pred (⇒ count toward resvSec/leaf, p95, throughput) ONLY
    # for a solved leaf; always write .class for the tally. if/fi keeps the subshell exit 0.
    ( id=$(jq -r '.instanceId' <<<"$row"); bk=$(jq -r '.label' <<<"$row"); post=$(jq -c '.post' <<<"$row")
      ts=$(now_ms); resp=$(dispatch_solve "e1b-$arm-$RANDOM-$i-$$" "$post" || true)
      cls=$(leaf_health_class "$resp"); echo "$cls" > "$lat_d/$i.class"
      if [ "$cls" = solved ]; then
        echo $(( $(now_ms) - ts )) > "$lat_d/$i.ms"
        append_prediction "$lat_d/$i.pred" "$id" "${SH_MODEL:-claude-haiku-4-5}" "$resp"
        append_usage "$lat_d/$i.use" "$id" "$bk" "$resp"
      fi ) &
    pids="$pids $!"; i=$((i + 1))
    # cap offered concurrency at C
    # -1 discounts the lease sampler background job so the cap counts only leaf dispatches.
    while [ "$(( $(jobs -rp | wc -l) - 1 ))" -ge "$C" ]; do sleep 0.5; done
  done < <(jq -c '.[]' <<<"$ITEMS")
  # shellcheck disable=SC2086
  wait $pids || true
  cat "$lat_d"/*.pred >> "$PRED" 2>/dev/null || true
  cat "$lat_d"/*.use >> "$USAGE" 2>/dev/null || true
  wall=$(( $(now_ms) - t0 )); [ "$wall" -lt 1 ] && wall=1
  stop_sampler "$sampler"
  # Tally leaves by class (one .class per dispatch); done_n counts only solved (.ms) leaves.
  local ac_solved=0 ac_failed=0 ac_saturated=0 ac_transport=0 cf
  for cf in "$lat_d"/*.class; do
    [ -e "$cf" ] || continue
    case "$(cat "$cf")" in
      solved)    ac_solved=$((ac_solved + 1)) ;;
      saturated) ac_saturated=$((ac_saturated + 1)) ;;
      transport) ac_transport=$((ac_transport + 1)) ;;
      *)         ac_failed=$((ac_failed + 1)) ;;
    esac
  done
  resv=$(pool_lease_seconds_from "$f")
  peak=$(sort -n "$f" | tail -1)
  done_n=$(find "$lat_d" -name '*.ms' | wc -l | tr -d ' ')
  # Guard p95 for the all-excluded case (done_n=0 ⇒ no .ms files ⇒ cat glob would fail under pipefail).
  if ls "$lat_d"/*.ms >/dev/null 2>&1; then
    p95=$(cat "$lat_d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
  else p95=999999; fi
  thr=$(awk -v n="$done_n" -v w="$wall" 'BEGIN{printf "%.3f", n/(w/1000.0)}')
  local rspl; rspl=$(awk -v r="$resv" -v n="$done_n" 'BEGIN{printf "%.1f", (n>0?r/n:0)}')
  rm -f "$f"; rm -rf "$lat_d"
  echo "$rspl $p95 $thr ${peak:-0} $ac_solved $ac_failed $ac_saturated $ac_transport"
}

echo "--- E1 benefit: $NITEMS leaves, C=$C, dedicated(cap=1) vs shared@N($N) ---"
# Real swebench solve leaves run minutes (>> default 300s); bump the ksvc request timeout once (both
# arms' set_ksvc_env/set_scale preserve it) so long leaves are not killed. Needs cluster Knative
# max-revision-timeout-seconds >= this. Reset to 300 by the EXIT trap (restore_ksvc_env).
set_ksvc_timeout "${SWEBENCH_LEAF_TIMEOUT:-1800}"
read -r ded_r ded_p ded_t ded_peak d_sv d_fl d_sa d_tr <<<"$(run_arm dedicated 1)"
read -r shr_r shr_p shr_t shr_peak s_sv s_fl s_sa s_tr <<<"$(run_arm shared "$N")"
H_SOLVED=$((H_SOLVED + ${d_sv:-0} + ${s_sv:-0})); H_FAILED=$((H_FAILED + ${d_fl:-0} + ${s_fl:-0}))
H_SATURATED=$((H_SATURATED + ${d_sa:-0} + ${s_sa:-0})); H_TRANSPORT=$((H_TRANSPORT + ${d_tr:-0} + ${s_tr:-0}))
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
H_TOTAL=$((H_SOLVED + H_FAILED + H_SATURATED + H_TRANSPORT))
HEALTH="health=$H_SOLVED/$H_TOTAL failed=$H_FAILED saturated=$H_SATURATED transport=$H_TRANSPORT"
# Per-leaf token cost for both arms, summed from the pi session streams (all e1b leaves share "-$$").
COST=$(run_cost_report "$$" "${USAGE:-${LOG_DIR:-/tmp/kagenti/planC}/usage-e1.jsonl}.cost" 2>/dev/null || echo "COST_REPORT unavailable")
echo "E1B_RESULT benefit=${RATIO}x withinDegrade=$WITHIN dedicated_resv=$ded_r shared_resv=$shr_r $HEALTH"
echo "  $COST"
{
  echo ""
  echo "### E1 benefit run $(hostname 2>/dev/null || echo host)"
  echo "- leaves=$NITEMS C=$C sharedCap=$N seed=$SEED"
  echo "- dedicated: resvSec/leaf=$ded_r p95=$ded_p thr=$ded_t peakPods=$ded_peak"
  echo "- shared@$N: resvSec/leaf=$shr_r p95=$shr_p thr=$shr_t peakPods=$shr_peak"
  echo "- benefit (dedicated:shared) = ${RATIO}x (withinDegrade=$WITHIN)"
  echo "- leaf health (excluded from metrics): $HEALTH"
  echo "- $COST"
} >> EXPERIMENTS.md
