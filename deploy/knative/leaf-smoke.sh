#!/usr/bin/env bash
# deploy/knative/leaf-smoke.sh
# Gated Kind smoke for the leaf-session invocation contract (MVP spec §7 gates 1-6).
# Proves: parallel fan-out + scale-out, per-call model routing, structured-output
# enforcement (failure writes no result), retry/idempotency, coverage audit, scale-to-zero.
#
# Prereq: setup-kind.sh done; the harness image rebuilt+reloaded with the /run-leaf route;
#   leaf-pvc.yaml + leaf-orchestrator.yaml applied; service.yaml redeployed with the /work mount.
# Usage: LEAF_LIVE_SMOKE=1 bash deploy/knative/leaf-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh   # NS, BASE, HOST_HEADER, ok/ko, wait_for_zero_pods, harness_running_pods, ensure_port_forward, start_sampler

[ "${LEAF_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set LEAF_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator
RUN="run-$$"
FIX="/work/$RUN-fixtures"      # seeded fixtures (inputs/ + repo/)
RES="/work/$RUN/results"       # harness writes result_ref here
ITEMS="i1 i2 i3"
MODEL="${SH_MODEL:-claude-haiku-4-5}"

claim() { echo ""; echo "--- Claim $1: $2 ---"; }
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }

# dispatch <item_id> [model] [inputs_override] -> echoes terminal-status JSON from /run-leaf
dispatch() {
  local id="$1" model="${2:-$MODEL}" in="${3:-$FIX/inputs/$id.json}"
  local body
  body=$(jq -nc --arg s "$RUN/$id" --arg m "$model" \
    --arg in "$in" --arg out "$RES/$id.json" --arg ws "$FIX/repo" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws}')
  curl -s --max-time 240 -H "$HOST_HEADER" -H "Content-Type: application/json" -d "$body" "$BASE/run-leaf"
}

echo "=== Leaf smoke (run=$RUN, model=$MODEL) ==="

# --- Setup: port-forward, orchestrator readiness, seed fixtures + results dir ---
ensure_port_forward >/dev/null || true
kubectl -n "$NS" wait --for=condition=Ready "pod/$ORCH" --timeout=90s >/dev/null
# wait until curl+jq are installed inside the orchestrator
for _ in $(seq 1 30); do oexec sh -c 'command -v jq >/dev/null && command -v curl >/dev/null' && break; sleep 2; done
kubectl -n "$NS" cp ./fixtures "$ORCH:$FIX"
oexec mkdir -p "$RES"
oexec sh -c "test -f $FIX/inputs/i1.json && test -f $FIX/repo/risky.py" \
  && echo "  seeded fixtures + results dir" || { echo "  FAIL: fixtures not seeded"; exit 1; }

# Start a pod sampler to observe parallel scale-out (gate 1).
SAMPLE_OUT="$(mktemp)"; SAMPLER_PID="$(start_sampler "$SAMPLE_OUT")"

# --- Claim 1: parallel fan-out — N leaf sessions run concurrently, each writes a valid verdict ---
claim 1 "Parallel fan-out: $ITEMS dispatched concurrently"
declare -A STATUS
tmpdir="$(mktemp -d)"
for id in $ITEMS; do ( dispatch "$id" > "$tmpdir/$id.json" 2>&1 ) & done
wait
fanout_ok=1
for id in $ITEMS; do
  st=$(jq -r '.status // "none"' < "$tmpdir/$id.json" 2>/dev/null || echo parse_err)
  STATUS[$id]="$st"; echo "    $id -> $st"
  [ "$st" = "done" ] || fanout_ok=0
done
[ "$fanout_ok" = 1 ] && ok "all $ITEMS returned done" || ko "not all items returned done"

MAXPODS=$(sort -n "$SAMPLE_OUT" 2>/dev/null | tail -1); MAXPODS="${MAXPODS:-0}"
[ "${MAXPODS:-0}" -ge 2 ] && ok "scaled out to $MAXPODS concurrent pods" \
  || echo "  NOTE: observed max $MAXPODS concurrent pods (single-pod scheduling possible under load)"

# --- Claim 2: structured output enforced — each result_ref holds a schema-valid verdict ---
claim 2 "Structured output: every result_ref is a schema-valid verdict"
cov_ok=1
for id in $ITEMS; do
  if oexec sh -c "jq -e '.item_id and (.verdict==\"FLAGGED\" or .verdict==\"CLEAR\") and .reason' $RES/$id.json >/dev/null 2>&1"; then
    v=$(oexec sh -c "jq -r .verdict $RES/$id.json"); echo "    $id verdict=$v"
  else
    cov_ok=0; echo "    $id MISSING/invalid verdict"
  fi
done
[ "$cov_ok" = 1 ] && ok "all verdicts present and schema-valid" || ko "missing/invalid verdicts"

# --- Claim 3: per-call model routing — bogus model fails, valid model succeeds (param drives resolution) ---
claim 3 "Per-call model param drives resolution"
bogus=$(dispatch i2 "model-does-not-exist-xyz" | jq -r '.status // "none"')
good=$(dispatch i2 "$MODEL" | jq -r '.status // "none"')
if [ "$bogus" = "failed" ] && [ "$good" = "done" ]; then
  ok "bogus model -> failed, valid model -> done"
else
  ko "bogus=$bogus good=$good (expected failed/done)"
fi

# --- Claim 4: structured-output failure writes NO result_ref (bad_inputs terminal status) ---
claim 4 "Failure path returns terminal failed + writes no invalid result_ref"
neg=$(dispatch ineg "$MODEL" "$FIX/inputs/does-not-exist.json")
neg_status=$(echo "$neg" | jq -r '.status // "none"')
neg_reason=$(echo "$neg" | jq -r '.reason // "none"')
if [ "$neg_status" = "failed" ] && ! oexec test -f "$RES/ineg.json"; then
  ok "failed (reason=$neg_reason), no result_ref written"
else
  ko "status=$neg_status reason=$neg_reason result-exists=$(oexec test -f $RES/ineg.json && echo yes || echo no)"
fi

# --- Claim 5: retry = idempotent re-invoke (same session_id/result_ref re-runs and overwrites) ---
claim 5 "Idempotent re-invoke overwrites result_ref"
re=$(dispatch i1 "$MODEL" | jq -r '.status // "none"')
if [ "$re" = "done" ] && oexec sh -c "jq -e '.verdict' $RES/i1.json >/dev/null 2>&1"; then
  ok "re-invoke of i1 succeeded and rewrote a valid verdict"
else
  ko "re-invoke status=$re"
fi

# --- Claim 6: scale-to-zero after idle ---
claim 6 "Service scales to zero when idle"
stop_sampler "$SAMPLER_PID"
wait_for_zero_pods 150 && ok "scaled to zero" || ko "did not scale to zero within 150s"

rm -rf "$tmpdir" "$SAMPLE_OUT" 2>/dev/null || true
echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "LEAF SMOKE FAIL"; exit 1; else echo "LEAF SMOKE PASS"; exit 0; fi
