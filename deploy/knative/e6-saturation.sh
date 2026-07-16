#!/usr/bin/env bash
# deploy/knative/e6-saturation.sh
# E6 (workload-parameterized, spec 2026-07-03-e6-workload-parameterized-sandbox-load):
#  Phase 1 — N-vs-workload curve: per-leaf sandbox duty at C=1 on a WARM pod (exec-timing delta
#    per leaf, median of E6_SAMPLES) across real code-review variants L0/L1/L2 -> N = 1/duty as a
#    function of per-leaf sandbox work. This is confound-free (one leaf, no concurrency).
#  Phase 2 — concurrency sweep at the HEAVIEST variant (L2) with the harness UN-CAPPED
#    (max-scale raised so the sandbox, not the 5-pod harness cap, limits concurrency), warm,
#    multi-sampled, fed to the sustained-decline detectKnee. Knee reported as a floor.
# Gated by E6_LIVE=1. Records to EXPERIMENTS.md.
# Usage: E6_LIVE=1 [E6_SAMPLES=3] [E6_SWEEP_MAX_SCALE=20] bash deploy/knative/e6-saturation.sh
#
# WORKLOAD=synthetic|swebench (default synthetic, Plan C): swebench drives real solve leaves
# per weight bucket (Phase 1) and sweeps the heaviest instance (Phase 2) via the workload-provider
# seam (experiments/src/workload.ts), splitting solve-duty from setup-duty (spec Plan C §4) and
# capturing predictions.jsonl. The synthetic path's behavior is unchanged.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091  # lib.sh is co-located; not available to shellcheck at lint time
source ./lib.sh

[ "${E6_LIVE:-0}" = "1" ] || { echo "SKIP (set E6_LIVE=1)"; exit 0; }
# Restore ksvc env + scale on ANY exit; installed AFTER the gate so a SKIP run never touches the cluster.
trap 'restore_ksvc_env' EXIT

SAMPLES="${E6_SAMPLES:-3}"
LADDER="${E6_LADDER:-1 2 4 8 16}"
DEGRADE_X="${E6_DEGRADE_X:-2}"
MIN_C="${E6_MIN_CONCURRENCY:-4}"
SWEEP_MAX="${E6_SWEEP_MAX_SCALE:-20}"
PIN="${KAGENTI_SANDBOX_POD:-sandbox-0}"
WREF="work"
# Archetype-A code-review variants of increasing review scope: "label:file:pattern".
VARIANTS=("L0:small.py:password" "L1:medium.py:eval(" "L2:large.py:eval(")

# Plan C: WORKLOAD=synthetic|swebench switch. synthetic (default) keeps the original behavior
# exactly; swebench drives real solve leaves through the workload-provider seam (Task 1/3).
WORKLOAD="${WORKLOAD:-synthetic}"
PROVIDER_DECK="${DECK:-$(cd ../.. && pwd)/experiments/swebench/deck.json}"  # CWD is the script dir (cd above); mirror e1-benefit.sh
PREDICTIONS="${PREDICTIONS:-${LOG_DIR:-/tmp/kagenti/planC}/predictions.jsonl}"

echo "--- E6: workload curve + un-capped sweep (samples=$SAMPLES pin=$PIN sweepMax=$SWEEP_MAX) ---"
ensure_port_forward >/dev/null || true

if [ "$WORKLOAD" = "synthetic" ]; then
  wait_gitd 120 || { echo "gitd not ready"; exit 1; }
  # gitd has no readiness probe and pushes the "work" ref LAST; wait until it actually
  # resolves so Phase 1's first sample doesn't race the seed.
  for _ in $(seq 1 30); do
    if kubectl -n "$NS" exec deploy/gitd -- git ls-remote "$(gitd_repo_url)" "$WREF" 2>/dev/null | grep -q "$WREF"; then
      break
    fi
    sleep 2
  done

  # Pin one sandbox, disable pool routing, enable exec timing; warm exactly one harness pod (min=max=1)
  # so C=1 has no cold start and a single stable pod owns the [exec-timing] log across samples.
  set_ksvc_env KAGENTI_SANDBOX_POD="$PIN" KAGENTI_SANDBOX_POOL_SELECTOR- KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000
  set_scale 1 1

  harness_pod() {
    kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | awk 'NR==1{print $1}'
  }

  # wait_ksvc_ready confirms the ksvc config is Ready but NOT that a pod is Running; without a
  # Running pod, harness_pod() returns "" and the exec-timing delta reads a non-existent pod name
  # (execCount=0 for every sample). Wait for the pinned min-scale pod, then warm the converge path
  # (shared /workspace/repo clone) so the first real sample isn't cold-start/first-clone inflated.
  # (Both discovered live on Kind — wait_ksvc_ready is necessary but not sufficient here.)
  for _ in $(seq 1 60); do [ -n "$(harness_pod)" ] && break; sleep 2; done
  dispatch_converge "e6-warmup-$RANDOM-$$" "L0" "small.py" "password" "$WREF" >/dev/null 2>&1 || true

  # --- Phase 1: N-vs-workload curve (C=1, warm, exec-timing DELTA per leaf, median of SAMPLES) ---
  CURVE_IN="[]"
  for v in "${VARIANTS[@]}"; do
    IFS=: read -r label file pat <<<"$v"
    ms_s=""; cnt_s=""; wall_s=""
    for _ in $(seq 1 "$SAMPLES"); do
      # Aggregate the exec-timing delta over ALL Running harness pods: Knative keeps multiple revision
      # pods Running across a config transition and may route this leaf to any of them, so a single
      # sampled pod (harness_pod) misses execs served elsewhere (observed: execCount=0). All pods pin
      # into the same sandbox, so the union of their [exec-timing] lines is the leaf's true work.
      before_ms="$(sum_exec_ms_all)"; before_cnt="$(count_exec_lines_all)"
      t0=$(now_ms)
      dispatch_converge "e6-$label-$RANDOM-$$" "$label" "$file" "$pat" "$WREF" >/dev/null 2>&1 || true
      wall=$(( $(now_ms) - t0 ))
      after_ms="$(sum_exec_ms_all)"; after_cnt="$(count_exec_lines_all)"
      ms_s="$ms_s$(( after_ms - before_ms ))
"; cnt_s="$cnt_s$(( after_cnt - before_cnt ))
"; wall_s="$wall_s$wall
"
    done
    medMs=$(printf '%s' "$ms_s"   | grep -v '^$' | median); [ "$medMs" -lt 1 ] && medMs=1
    medCnt=$(printf '%s' "$cnt_s" | grep -v '^$' | median)
    medWall=$(printf '%s' "$wall_s" | grep -v '^$' | median); [ "$medWall" -lt 1 ] && medWall=1
    echo "  $label file=$file execCount=$medCnt execMs=$medMs wallMs=$medWall"
    CURVE_IN=$(jq -c --arg l "$label" --argjson m "$medMs" --argjson c "$medCnt" --argjson w "$medWall" \
      '. + [{label:$l, execMs:$m, execCount:$c, wallMs:$w}]' <<<"$CURVE_IN")
  done
else
  # Repos are baked into the swebench image; no gitd wait needed. Route into the swebench sandbox
  # pool (by label, not a single-pod pin) and warm exactly one harness pod, same as synthetic C=1.
  mkdir -p "$(dirname "$PREDICTIONS")"; : >"$PREDICTIONS"
  set_ksvc_env KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=swebench KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000
  set_scale 1 1

  harness_pod() {
    kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | awk 'NR==1{print $1}'
  }
  for _ in $(seq 1 60); do [ -n "$(harness_pod)" ] && break; sleep 2; done

  # --- Phase 1: N-vs-workload curve (C=1, warm, one representative solve leaf per weight bucket) ---
  # shellcheck disable=SC2016  # single-quoted TypeScript literal, not bash expansion
  CURVE_ITEMS=$(WORKLOAD=swebench DECK="$PROVIDER_DECK" npx tsx -e '
    import { getWorkloadProvider } from "../../experiments/src/workload.ts";
    const p = getWorkloadProvider(process.env, process.env.DECK);
    process.stdout.write(JSON.stringify(p.curveItems()));
  ')
  CURVE_IN="[]"
  while IFS= read -r row; do
    label=$(jq -r '.label' <<<"$row"); id=$(jq -r '.instanceId' <<<"$row"); post=$(jq -c '.post' <<<"$row")
    ms_s=""; cnt_s=""; wall_s=""
    for _ in $(seq 1 "$SAMPLES"); do
      before_ms="$(sum_exec_ms_all)"; before_cnt="$(count_exec_lines_all)"; before_setup="$(sum_setup_ms_all)"
      t0=$(now_ms)
      resp=$(dispatch_solve "e6-$label-$RANDOM-$$" "$post" || true)
      wall=$(( $(now_ms) - t0 ))
      after_ms="$(sum_exec_ms_all)"; after_cnt="$(count_exec_lines_all)"; after_setup="$(sum_setup_ms_all)"
      append_prediction "$PREDICTIONS" "$id" "${SH_MODEL:-claude-haiku-4-5}" "$resp"
      # solve-duty = total exec delta − setup delta (spec §4).
      solve_ms=$(( (after_ms - before_ms) - (after_setup - before_setup) )); [ "$solve_ms" -lt 0 ] && solve_ms=0
      ms_s="$ms_s$solve_ms
"; cnt_s="$cnt_s$(( after_cnt - before_cnt ))
"; wall_s="$wall_s$wall
"
    done
    medMs=$(printf '%s' "$ms_s" | grep -v '^$' | median); [ "$medMs" -lt 1 ] && medMs=1
    medCnt=$(printf '%s' "$cnt_s" | grep -v '^$' | median)
    medWall=$(printf '%s' "$wall_s" | grep -v '^$' | median); [ "$medWall" -lt 1 ] && medWall=1
    echo "  $label instance=$id execCount=$medCnt solveMs=$medMs wallMs=$medWall"
    CURVE_IN=$(jq -c --arg l "$label" --argjson m "$medMs" --argjson c "$medCnt" --argjson w "$medWall" \
      '. + [{label:$l, execMs:$m, execCount:$c, wallMs:$w}]' <<<"$CURVE_IN")
  done < <(jq -c '.[]' <<<"$CURVE_ITEMS")
fi

# shellcheck disable=SC2016  # single-quoted TypeScript literal, not bash expansion
CURVE=$(npx tsx -e '
  import { buildRatioCurve } from "../../experiments/src/sharing.ts";
  process.stdout.write(JSON.stringify(buildRatioCurve(JSON.parse(process.argv[1]))));
' "$CURVE_IN")
echo "  RATIO_CURVE=$CURVE"

# --- Phase 2: concurrency sweep at the heaviest variant/instance, harness UN-CAPPED + warm ---
if [ "$WORKLOAD" = "synthetic" ]; then
  IFS=: read -r hl hf hp <<<"${VARIANTS[2]}"
  SWEEP_DESC="L2 '$hf'"
  set_scale 1 "$SWEEP_MAX"

  run_rung() {  # $1=c ; echoes "<medianThroughput> <medianP95>"
    local c="$1" thr_s="" p95_s="" i pids d t0 wall
    for _ in $(seq 1 "$SAMPLES"); do
      d="$(mktemp -d)"; pids=""; i=0; t0=$(now_ms)
      while [ "$i" -lt "$c" ]; do
        ( ts=$(now_ms); dispatch_converge "e6sw-$c-$RANDOM-$i-$$" "$hl" "$hf" "$hp" "$WREF" >/dev/null 2>&1 || true
          echo $(( $(now_ms) - ts )) > "$d/$i.ms" ) & pids="$pids $!"
        i=$((i + 1))
      done
      # shellcheck disable=SC2086
      wait $pids
      wall=$(( $(now_ms) - t0 )); [ "$wall" -lt 1 ] && wall=1
      thr_s="$thr_s$(awk -v c="$c" -v w="$wall" 'BEGIN{printf "%.3f", c/(w/1000.0)}')
"
      if ls "$d"/*.ms >/dev/null 2>&1; then
        p95_s="$p95_s$(cat "$d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
"
      else p95_s="${p95_s}999999
"; fi
      rm -rf "$d"
    done
    # median throughput is a float; median() is integer-only, so pick the middle sorted float via awk.
    local mthr mp95
    mthr=$(printf '%s' "$thr_s" | grep -v '^$' | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:a[NR/2]}')
    mp95=$(printf '%s' "$p95_s" | grep -v '^$' | median)
    echo "$mthr $mp95"
  }
else
  # shellcheck disable=SC2016  # single-quoted TypeScript literal, not bash expansion
  SWEEP_POST=$(WORKLOAD=swebench DECK="$PROVIDER_DECK" npx tsx -e '
    import { getWorkloadProvider } from "../../experiments/src/workload.ts";
    process.stdout.write(JSON.stringify(getWorkloadProvider(process.env, process.env.DECK).sweepItem().post));
  ')
  SWEEP_DESC="heavy (swebench)"
  set_scale 1 "$SWEEP_MAX"

  run_rung() {  # $1=c ; echoes "<medianThroughput> <medianP95>"
    local c="$1" thr_s="" p95_s="" i pids d t0 wall
    for _ in $(seq 1 "$SAMPLES"); do
      d="$(mktemp -d)"; pids=""; i=0; t0=$(now_ms)
      while [ "$i" -lt "$c" ]; do
        ( ts=$(now_ms); dispatch_solve "e6sw-$c-$RANDOM-$i-$$" "$SWEEP_POST" >/dev/null 2>&1 || true
          echo $(( $(now_ms) - ts )) > "$d/$i.ms" ) & pids="$pids $!"
        i=$((i + 1))
      done
      # shellcheck disable=SC2086
      wait $pids
      wall=$(( $(now_ms) - t0 )); [ "$wall" -lt 1 ] && wall=1
      thr_s="$thr_s$(awk -v c="$c" -v w="$wall" 'BEGIN{printf "%.3f", c/(w/1000.0)}')
"
      if ls "$d"/*.ms >/dev/null 2>&1; then
        p95_s="$p95_s$(cat "$d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
"
      else p95_s="${p95_s}999999
"; fi
      rm -rf "$d"
    done
    # median throughput is a float; median() is integer-only, so pick the middle sorted float via awk.
    local mthr mp95
    mthr=$(printf '%s' "$thr_s" | grep -v '^$' | sort -n | awk '{a[NR]=$1} END{print (NR%2)?a[(NR+1)/2]:a[NR/2]}')
    mp95=$(printf '%s' "$p95_s" | grep -v '^$' | median)
    echo "$mthr $mp95"
  }
fi

POINTS="[]"
for c in $LADDER; do
  read -r thr p95 <<<"$(run_rung "$c")"
  echo "  sweep c=$c throughput=$thr p95Ms=$p95"
  POINTS=$(jq -c --argjson c "$c" --argjson t "$thr" --argjson p "$p95" \
    '. + [{c:$c, throughput:$t, p95Ms:$p}]' <<<"$POINTS")
done

# shellcheck disable=SC2016
KF=$(npx tsx -e '
  import { detectKnee, sanityFloorPass } from "../../experiments/src/sharing.ts";
  const pts = JSON.parse(process.argv[1]);
  const knee = detectKnee(pts, Number(process.argv[2]));
  process.stdout.write(`${knee} ${sanityFloorPass(knee, Number(process.argv[3]))}`);
' "$POINTS" "$DEGRADE_X" "$MIN_C")
read -r KNEE FLOOR <<<"$KF"
echo "  knee(CAP floor)=$KNEE floorPass=$FLOOR maxScale=$SWEEP_MAX"

echo "E6_RESULT ratioCurve=$CURVE knee=$KNEE floorPass=$FLOOR maxScale=$SWEEP_MAX pass=$([ "$FAIL" = 0 ] && echo yes || echo no)"
{
  echo ""
  echo "### E6 run $(hostname 2>/dev/null || echo host)"
  echo "- N-vs-workload curve (C=1, samples=$SAMPLES): $CURVE"
  echo "- sweep points ($SWEEP_DESC, max-scale=$SWEEP_MAX): $POINTS"
  echo "- knee floor: $KNEE (floorPass=$FLOOR)"
} >> EXPERIMENTS.md

[ "$FAIL" = 0 ] || exit 1
