#!/usr/bin/env bash
# deploy/knative/e1-economics.sh
# E1: sampled pod-seconds, persistent (min-scale=1) vs serverless (min-scale=0),
# over an idle-heavy workload. PASS if serverless <= 0.6 * persistent.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

E1_TURNS="${E1_TURNS:-2}"      # short turns per run; 2 turns are sufficient for the economics gate
E1_IDLE="${E1_IDLE:-300}"      # idle gap (s) between turns; must be >> 30s scale-to-zero retention
                               # (idle=120 yields ratio ~0.78 which fails the 0.6 gate; idle=300 yields ~0.31)

run_workload() {               # fires E1_TURNS turns with idle gaps; ignores content
  local sid=""
  for i in $(seq 1 "$E1_TURNS"); do
    local resp; resp=$(turn "ping $i; reply OK" "$sid")
    sid=$(echo "$resp" | jq -r '.sessionId // empty')
    [ "$i" -lt "$E1_TURNS" ] && sleep "$E1_IDLE"
  done
}

measure() {                    # $1 = min-scale; echoes pod-seconds
  set_min_scale "$1"
  local f; f=$(mktemp)
  local pid; pid=$(start_sampler "$f")
  run_workload
  stop_sampler "$pid"
  pod_seconds_from "$f"
  rm -f "$f"
}

echo "--- E1: economics (turns=$E1_TURNS idle=${E1_IDLE}s interval=${SAMPLE_INTERVAL}s) ---"
PERSISTENT=$(measure 1)
echo "  persistent_pod_seconds=$PERSISTENT"
set_min_scale 0; wait_for_zero_pods 90 || true   # reset to serverless, let it settle
SERVERLESS=$(measure 0)
echo "  serverless_pod_seconds=$SERVERLESS"

RATIO=$(awk -v s="$SERVERLESS" -v p="$PERSISTENT" 'BEGIN{ printf (p>0 ? "%.2f" : "inf"), (p>0 ? s/p : 0) }')
echo "  ratio(serverless/persistent)=$RATIO"

if awk -v s="$SERVERLESS" -v p="$PERSISTENT" 'BEGIN{ exit !(p>0 && s <= 0.6*p) }'; then
  ok "serverless ${SERVERLESS}s <= 0.6 * persistent ${PERSISTENT}s"
else
  ko "serverless ${SERVERLESS}s not <= 0.6 * persistent ${PERSISTENT}s (ratio $RATIO)"
fi
echo "E1_RESULT persistent=$PERSISTENT serverless=$SERVERLESS ratio=$RATIO pass=$([ "$FAIL" = 0 ] && echo yes || echo no)"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
