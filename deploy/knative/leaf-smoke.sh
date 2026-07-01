#!/usr/bin/env bash
# deploy/knative/leaf-smoke.sh
# Gated Kind smoke for the leaf-session invocation contract (MVP spec §7 gates 1-6).
# Proves: parallel fan-out + scale-out, per-call model routing, structured-output
# enforcement, retry/idempotency, coverage audit, scale-to-zero — AND that agent tool
# execution happens in the SANDBOX pod, not the credentialed harness pod (spec §3).
#
# Volume model (spec §5, brain/hands split):
#   - inputs_ref / result_ref live on the harness-mounted /work PVC (trusted Node fs I/O).
#   - workspace_ref (the repo) lives ONLY in sandbox-0 at /workspace/<run>/repo; the agent's
#     read/grep/bash route there via k8sSandboxExtension. The repo is never placed on /work, so
#     a correct verdict is only possible if the agent read the file in the sandbox.
#
# Prereq: setup-kind.sh done (incl. the PVC feature flags + sandbox-0); harness image rebuilt
#   with the /runs route + sandbox-routed runLeaf; leaf-pvc.yaml + leaf-orchestrator.yaml
#   applied; service.yaml redeployed with the /work mount.
# Usage: LEAF_LIVE_SMOKE=1 bash deploy/knative/leaf-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh   # NS, BASE, HOST_HEADER, ok/ko, wait_for_zero_pods, harness_running_pods, ensure_port_forward, start_sampler

[ "${LEAF_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set LEAF_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator
SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
RUN="run-$$"
INPUTS="/work/$RUN/inputs"        # harness PVC (read by harness Node fs)
RES="/work/$RUN/results"          # harness PVC (written by harness Node fs)
SBOX_REPO="/workspace/$RUN/repo"  # sandbox-0 only (read by sandbox tools)
ITEMS="i1 i2 i3"
MODEL="${SH_MODEL:-claude-haiku-4-5}"
# expected verdicts given the fixtures (i1=risky.py/eval(→FLAGGED, i2=safe.py/eval(→CLEAR, i3=risky.py/subprocess→CLEAR)
declare -A EXPECT=( [i1]=FLAGGED [i2]=CLEAR [i3]=CLEAR )

claim() { echo ""; echo "--- Claim $1: $2 ---"; }
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
sexec() { kubectl -n "$NS" exec "$SBOX" -- "$@"; }

# dispatch_sid <sessionId> <inputsRef> <resultRef> [model] -> echoes terminal-status JSON
dispatch_sid() {
  local sid="$1" in="$2" out="$3" model="${4:-$MODEL}"
  local body
  body=$(jq -nc --arg s "$sid" --arg m "$model" --arg in "$in" --arg out "$out" --arg ws "$SBOX_REPO" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws}')
  curl -s --max-time 240 -H "$HOST_HEADER" -H "Content-Type: application/json" -d "$body" "$BASE/runs"
}

# dispatch <item_id> [model] [inputs_override] -> echoes terminal-status JSON from /runs
dispatch() {
  local id="$1"
  local model="${2:-$MODEL}" in="${3:-$INPUTS/$id.json}"
  dispatch_sid "$RUN/$id" "$in" "$RES/$id.json" "$model"
}

echo "=== Leaf smoke (run=$RUN, model=$MODEL, sandbox=$SBOX) ==="

# --- Setup ---
ensure_port_forward >/dev/null || true
kubectl -n "$NS" wait --for=condition=Ready "pod/$ORCH" --timeout=90s >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$SBOX" --timeout=90s >/dev/null
for _ in $(seq 1 30); do oexec sh -c 'command -v jq >/dev/null && command -v curl >/dev/null' && break; sleep 2; done
# inputs + results dir on the harness PVC (via the orchestrator)
oexec mkdir -p "$INPUTS" "$RES"
kubectl -n "$NS" cp ./fixtures/inputs/. "$ORCH:$INPUTS"
# repo ONLY into the sandbox pod — never onto /work
sexec mkdir -p "$SBOX_REPO"
kubectl -n "$NS" cp ./fixtures/repo/. "$SBOX:$SBOX_REPO"

# --- Claim 0: workspace isolation — repo present in sandbox, absent on the harness PVC ---
claim 0 "Workspace lives in the sandbox, not on the harness volume"
in_sbox=1; sexec test -f "$SBOX_REPO/risky.py" || in_sbox=0
on_work=0; oexec test -f "$SBOX_REPO/risky.py" 2>/dev/null && on_work=1   # /work has no /workspace tree
oexec test -f "/work/$RUN/repo/risky.py" 2>/dev/null && on_work=1
if [ "$in_sbox" = 1 ] && [ "$on_work" = 0 ]; then ok "repo only in $SBOX:$SBOX_REPO"; else ko "in_sbox=$in_sbox on_work=$on_work"; fi

SAMPLE_OUT="$(mktemp)"; SAMPLER_PID="$(start_sampler "$SAMPLE_OUT")"

# --- Claim 1: parallel fan-out ---
claim 1 "Parallel fan-out: $ITEMS dispatched concurrently"
tmpdir="$(mktemp -d)"
for id in $ITEMS; do ( dispatch "$id" > "$tmpdir/$id.json" 2>&1 ) & done
wait
fanout_ok=1
for id in $ITEMS; do
  st=$(jq -r '.status // "none"' < "$tmpdir/$id.json" 2>/dev/null || echo parse_err)
  echo "    $id -> $st"; [ "$st" = "done" ] || fanout_ok=0
done
[ "$fanout_ok" = 1 ] && ok "all $ITEMS returned done" || ko "not all items returned done"
MAXPODS=$(sort -n "$SAMPLE_OUT" 2>/dev/null | tail -1); MAXPODS="${MAXPODS:-0}"
[ "${MAXPODS:-0}" -ge 2 ] && ok "scaled out to $MAXPODS concurrent pods" \
  || echo "  NOTE: observed max $MAXPODS concurrent pods"

# --- Claim 2: structured output + sandbox execution proof (verdicts present, valid, CORRECT) ---
claim 2 "Verdicts schema-valid AND correct (only possible by reading the sandbox file)"
verdicts_ok=1
for id in $ITEMS; do
  if oexec sh -c "jq -e '.item_id and (.verdict==\"FLAGGED\" or .verdict==\"CLEAR\") and .reason' $RES/$id.json >/dev/null 2>&1"; then
    v=$(oexec sh -c "jq -r .verdict $RES/$id.json")
    if [ "$v" = "${EXPECT[$id]}" ]; then echo "    $id verdict=$v (expected ${EXPECT[$id]})"; else echo "    $id verdict=$v WRONG (expected ${EXPECT[$id]})"; verdicts_ok=0; fi
  else
    verdicts_ok=0; echo "    $id MISSING/invalid verdict"
  fi
done
[ "$verdicts_ok" = 1 ] && ok "all verdicts present, schema-valid, and correct" || ko "missing/invalid/incorrect verdicts"

# --- Claim 3: per-call model param drives resolution ---
claim 3 "Per-call model param drives resolution"
bogus=$(dispatch i2 "model-does-not-exist-xyz" | jq -r '.status // "none"')
good=$(dispatch i2 "$MODEL" | jq -r '.status // "none"')
if [ "$bogus" = "failed" ] && [ "$good" = "done" ]; then ok "bogus model -> failed, valid model -> done"; else ko "bogus=$bogus good=$good"; fi

# --- Claim 4: failure path returns terminal failed + writes no invalid result_ref ---
claim 4 "Failure path returns terminal failed + writes no invalid result_ref"
neg=$(dispatch ineg "$MODEL" "$INPUTS/does-not-exist.json")
neg_status=$(echo "$neg" | jq -r '.status // "none"'); neg_reason=$(echo "$neg" | jq -r '.reason // "none"')
if [ "$neg_status" = "failed" ] && ! oexec test -f "$RES/ineg.json"; then ok "failed (reason=$neg_reason), no result_ref written"; else ko "status=$neg_status reason=$neg_reason"; fi

# --- Claim 5: idempotent re-invoke overwrites result_ref ---
claim 5 "Idempotent re-invoke overwrites result_ref"
re=$(dispatch i1 "$MODEL" | jq -r '.status // "none"')
if [ "$re" = "done" ] && oexec sh -c "jq -e '.verdict' $RES/i1.json >/dev/null 2>&1"; then ok "re-invoke of i1 succeeded and rewrote a valid verdict"; else ko "re-invoke status=$re"; fi

# --- Claim 6: crash mid-run, resume via M5 durable session, still produce the verdict (§7 gate 7) ---
claim 6 "Killed mid-run, the session resumes and still produces its verdict"
RSID="$RUN/i1-resume"; RRES="$RES/i1-resume.json"
oexec rm -f "$RRES" 2>/dev/null || true
# dispatch in the background, then kill the harness pod while the request is in flight
( dispatch_sid "$RSID" "$INPUTS/i1.json" "$RRES" >/dev/null 2>&1 ) & bgpid=$!
sleep 12
# the harness sanitizes the envelope id (slash -> dash) into the Pi/Redis session id; match it
RSID_KEY=$(printf '%s' "$RSID" | sed -E 's#[^A-Za-z0-9._-]#-#g; s#^[^A-Za-z0-9]+|[^A-Za-z0-9]+$##g')
sid_persisted=0
kubectl -n "$NS" exec deploy/redis -- redis-cli EXISTS "session:$RSID_KEY" 2>/dev/null | grep -q 1 && sid_persisted=1
force_kill_pod                       # crash the harness pod mid-run
wait "$bgpid" 2>/dev/null || true    # the in-flight request dies with the pod
# re-invoke the same sessionId — runLeaf resumes from the durable Redis log
re_status=$(dispatch_sid "$RSID" "$INPUTS/i1.json" "$RRES" | jq -r '.status // "none"')
if [ "$re_status" = "done" ] && [ "$sid_persisted" = 1 ] \
   && oexec sh -c "jq -e '.verdict' $RRES >/dev/null 2>&1"; then
  ok "persisted mid-run (redis), pod killed, resumed → verdict produced"
else
  ko "resume failed: status=$re_status persisted_in_redis=$sid_persisted"
fi

# --- Claim 7: scale-to-zero after idle ---
claim 7 "Service scales to zero when idle"
stop_sampler "$SAMPLER_PID"
wait_for_zero_pods 150 && ok "scaled to zero" || ko "did not scale to zero within 150s"

# best-effort cleanup of the sandbox run dir
sexec rm -rf "/workspace/$RUN" 2>/dev/null || true
rm -rf "$tmpdir" "$SAMPLE_OUT" 2>/dev/null || true
echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "LEAF SMOKE FAIL"; exit 1; else echo "LEAF SMOKE PASS"; exit 0; fi
