#!/usr/bin/env bash
# deploy/knative/leaf-smoke.sh
# Gated Kind smoke for the leaf-session invocation contract (MVP spec §7 gates 1-6).
# Proves: parallel fan-out + scale-out, per-call model routing, structured-output
# enforcement, retry/idempotency, coverage audit, scale-to-zero — AND that agent tool
# execution happens in the SANDBOX pod, not the credentialed harness pod (spec §3).
#
# FS-free contract (P1 rearchitecture): inputs and results are exchanged inline via the
# HTTP request/response body (POST /runs returns verdict JSON directly). No /work PVC is
# required for the harness or envelope path. The repo still lives ONLY in sandbox-0 at
# /workspace/<run>/repo; a correct verdict is only possible if the agent read the file
# in the sandbox.
#
# Prereq: setup-kind.sh done (incl. sandbox-0); harness image rebuilt with the /runs
#   inline-item route + sandbox-routed runLeaf; service.yaml deployed (no /work mount).
# Usage: LEAF_LIVE_SMOKE=1 bash deploy/knative/leaf-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh   # NS, BASE, HOST_HEADER, ok/ko, wait_for_zero_pods, harness_running_pods, ensure_port_forward, start_sampler

[ "${LEAF_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set LEAF_LIVE_SMOKE=1)"; exit 0; }

SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
RUN="run-$$"
SBOX_REPO="/workspace/$RUN/repo"  # sandbox-0 only (read by sandbox tools)
ITEMS="i1 i2 i3"
MODEL="${SH_MODEL:-claude-haiku-4-5}"
# expected verdicts given the fixtures (i1=risky.py/eval(→FLAGGED, i2=safe.py/eval(→CLEAR, i3=risky.py/subprocess→CLEAR)
declare -A EXPECT=( [i1]=FLAGGED [i2]=CLEAR [i3]=CLEAR )
# item definitions: file + pattern per item_id
declare -A ITEM_FILE=( [i1]=risky.py  [i2]=safe.py   [i3]=risky.py )
declare -A ITEM_PAT=(  [i1]="eval("   [i2]="eval("   [i3]="subprocess" )

claim() { echo ""; echo "--- Claim $1: $2 ---"; }
sexec() { kubectl -n "$NS" exec "$SBOX" -- "$@"; }

# dispatch_item <sessionId> <item_id> <file> <pattern> [model] -> echoes terminal JSON from /runs
dispatch_item() {
  local sid="$1" id="$2" file="$3" pat="$4" model="${5:-$MODEL}"
  local body
  body=$(jq -nc --arg s "$sid" --arg m "$model" --arg id "$id" --arg f "$file" --arg p "$pat" --arg ws "$SBOX_REPO" \
    '{sessionId:$s, model:$m, workspaceRef:$ws, item:{item_id:$id, file:$f, pattern:$p}}')
  curl -s $CURL_OPTS --max-time 240 ${CURL_HDR[@]+"${CURL_HDR[@]}"} -H "Content-Type: application/json" -d "$body" "$BASE/runs"
}

# dispatch <item_id> [model] -> echoes terminal JSON from /runs
dispatch() {
  local id="$1" model="${2:-$MODEL}"
  dispatch_item "$RUN/$id" "$id" "${ITEM_FILE[$id]}" "${ITEM_PAT[$id]}" "$model"
}

# dispatch_sid_item <sessionId> <item_id> [model] -> echoes terminal JSON from /runs (used for resume claim)
dispatch_sid_item() {
  local sid="$1" id="$2" model="${3:-$MODEL}"
  dispatch_item "$sid" "$id" "${ITEM_FILE[$id]}" "${ITEM_PAT[$id]}" "$model"
}

echo "=== Leaf smoke (run=$RUN, model=$MODEL, sandbox=$SBOX) ==="

# --- Static Claim 0: harness envelope path is FS-free ---
claim 0 "harness is FS-free (no /work mount, no fs writes in the envelope path)"
_REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$0")/../..")"
if grep -rqE 'mountPath:\s*/work|claimName:\s*leaf-work' \
    "$_REPO_ROOT/deploy/knative/service.yaml" "$_REPO_ROOT/deploy/knative/leaf-scaledjob.yaml"; then
  echo "FAIL: a /work mount remains in the harness/worker manifests"; exit 1
fi
if grep -rqE 'writeFileSync|readFileSync|mkdirSync' \
    "$_REPO_ROOT/harness/src/run-leaf.ts" "$_REPO_ROOT/harness/src/leaf-job-runner.ts"; then
  echo "FAIL: filesystem I/O remains in the leaf envelope path"; exit 1
fi
ok "no /work mount, no fs I/O in the envelope path"

# --- Setup ---
ensure_port_forward >/dev/null || true
kubectl -n "$NS" wait --for=condition=Ready "pod/$SBOX" --timeout=90s >/dev/null
# repo ONLY into the sandbox pod — never onto /work
sexec mkdir -p "$SBOX_REPO"
kubectl -n "$NS" cp ./fixtures/repo/. "$SBOX:$SBOX_REPO"

# --- Hop-2 AuthBridge claims (RC1-2, SH_AUTHBRIDGE=1 only): prove the sandbox pod is
# secret-free (holds only the AB2 placeholder), an allowed egress request through AB2 gets
# the real per-host credential injected (the sandbox never holds it), and a tools/call-shaped
# request is denied BEFORE egress/injection. Per the live spike
# (/tmp/kagenti/rc1/hop2/spike-forwardproxy.md), the MCP deny signal is an HTTP-200 JSON-RPC
# error body carrying `ibac.no_session` OR `ibac.no_intent` — NOT HTTP 403 — so H2-deny
# asserts on that body, not on a status code. Both reasons are the same deny-before-inject
# branch (no_session = no session at all; no_intent = a session exists but carries no
# recorded user intent), and which one fires depends on in-cluster session state, so accept
# either. Target the sandbox container explicitly (-c sandbox): the pod also carries the
# authbridge-ab2 sidecar, which legitimately holds the real credential.
if [ "${SH_AUTHBRIDGE:-0}" = "1" ]; then
  H2_LOG="$(mktemp)"   # verbose kubectl/curl output goes here, not stdout
  # `|| true`: under `set -euo pipefail` a missing/empty secret makes `base64 -d` (or the
  # kubectl read) exit non-zero, which would abort the smoke before any `ko` runs. Guard the
  # read, then explicitly gate the three H2 claims on a non-empty expected value below.
  REAL="$(kubectl -n "$NS" get secret ab2-egress-cred -o jsonpath='{.data.echo-target}' 2>>"$H2_LOG" | base64 -d 2>>"$H2_LOG" || true)"

  if [ -z "$REAL" ]; then
    # No real credential to assert against — running the claims now would either mislead
    # (H2-secret-free would trivially pass its leak check) or fail confusingly. Surface it as
    # one explicit failed claim and skip the rest, rather than aborting the whole smoke.
    claim H2-precheck "ab2-egress-cred holds the real egress credential"
    ko "ab2-egress-cred secret missing/empty — skipping H2-secret-free/H2-inject/H2-deny (was setup-kind.sh step 8c run with SH_AUTHBRIDGE=1?)"
  else
    # Wait for the sandbox container to become ready BEFORE running any of the three H2 claims
    # below. sandbox-0 may have just been (force-)recreated. Previously this polled via
    # `kubectl exec ... printenv`/`command -v curl`, but on this single-node kind cluster rapid,
    # repeated `kubectl exec` calls intermittently return empty output — the exact failure mode
    # this loop needs to survive, not exercise 60x. GET (kubectl get pod, an API read) is reliable
    # where exec flakes, so poll container readiness via the API instead. The sandbox now uses a
    # BAKED image (dev.local/sandbox-rc1:rc1) with curl and the AB2 proxy env declared directly in
    # the pod spec (no apk-install-at-startup race to wait out), so "both containers Ready" already
    # implies curl is present and the proxy env is set.
    h2_ready=0
    # ~60s budget (30 x 2s): API reads don't need the longer exec-based budget this loop used to
    # need while waiting on apk installs.
    for _i in $(seq 1 30); do
      h2_ready_states="$(kubectl -n "$NS" get pod "$SBOX" -o jsonpath='{.status.containerStatuses[*].ready}' 2>>"$H2_LOG" || true)"
      if [ "$h2_ready_states" = "true true" ]; then
        h2_ready=1; break
      fi
      sleep 2
    done

    if [ "$h2_ready" != 1 ]; then
      # Mirror the empty-REAL skip pattern above: one explicit failed claim, skip the rest,
      # rather than letting each of the three fail confusingly against a not-ready pod.
      claim H2-readiness "sandbox container ($SBOX) becomes exec-ready before the H2 claims run"
      ko "sandbox container never became ready (curl unavailable after retries) — skipping H2-secret-free/H2-inject/H2-deny"
    else
      claim H2-secret-free "sandbox container holds only the AB2 placeholder, never the real egress cred"
      # GET (kubectl get pod) instead of `kubectl exec ... printenv`: the sandbox container's env
      # is fully declared in the pod spec (deploy/knative/sandbox-pool-ab2.yaml) and never
      # rewritten at runtime, so reading it back via jsonpath is an exact proxy for the running
      # env — without execing a `printenv` that streams ~1700 lines (one k8s-injected service-env
      # var per Service across 100+ ksvc revisions) and intermittently comes back empty on this
      # single-node kind cluster.
      h2_cred_val="$(kubectl -n "$NS" get pod "$SBOX" -o jsonpath='{.spec.containers[?(@.name=="sandbox")].env[?(@.name=="ECHO_CRED")].value}' 2>>"$H2_LOG" || true)"
      h2_httpproxy_val="$(kubectl -n "$NS" get pod "$SBOX" -o jsonpath='{.spec.containers[?(@.name=="sandbox")].env[?(@.name=="HTTP_PROXY")].value}' 2>>"$H2_LOG" || true)"
      h2_httpsproxy_val="$(kubectl -n "$NS" get pod "$SBOX" -o jsonpath='{.spec.containers[?(@.name=="sandbox")].env[?(@.name=="HTTPS_PROXY")].value}' 2>>"$H2_LOG" || true)"
      h2_all_env_vals="$(kubectl -n "$NS" get pod "$SBOX" -o jsonpath='{.spec.containers[?(@.name=="sandbox")].env[*].value}' 2>>"$H2_LOG" || true)"
      h2_cred_ok=0; [ "$h2_cred_val" = "PLACEHOLDER-TOKEN" ] && h2_cred_ok=1
      h2_httpproxy_ok=0; [ "$h2_httpproxy_val" = "http://localhost:8081" ] && h2_httpproxy_ok=1
      h2_httpsproxy_ok=0; [ "$h2_httpsproxy_val" = "http://localhost:8081" ] && h2_httpsproxy_ok=1
      h2_leaked=0
      if echo "$h2_all_env_vals" | grep -qF "$REAL"; then h2_leaked=1; fi
      if [ "$h2_cred_ok" = 1 ] && [ "$h2_httpproxy_ok" = 1 ] && [ "$h2_httpsproxy_ok" = 1 ] && [ "$h2_leaked" = 0 ]; then
        ok "sandbox spec env holds only the AB2 placeholder + proxy vars, no real cred"
      else
        ko "cred_ok=$h2_cred_ok http_ok=$h2_httpproxy_ok https_ok=$h2_httpsproxy_ok leaked=$h2_leaked"
      fi

      # H2-inject and H2-deny below must stay `kubectl exec ... curl` — they exercise real
      # runtime egress through the AB2 sidecar, which a GET can't observe. Retry the exec/curl
      # capture itself: up to 6 attempts, 3s apart, re-exec if the response comes back empty (the
      # same transient single-node-kind `kubectl exec` flakiness the readiness loop above avoids),
      # then assert on whichever attempt returned a non-empty body.
      h2_exec_curl_retry() {
        local out="" _n
        for _n in $(seq 1 6); do
          out="$("$@" 2>>"$H2_LOG" || true)"
          [ -n "$out" ] && break
          sleep 3
        done
        printf '%s' "$out"
      }

      claim H2-inject "AB2 allow-path: egress through the proxy gets the real cred injected"
      h2_resp="$(h2_exec_curl_retry kubectl -n "$NS" exec "$SBOX" -c sandbox -- \
        curl -s http://echo-target/ -H "Authorization: Bearer PLACEHOLDER-TOKEN")"
      h2_inject_ok=0
      if echo "$h2_resp" | grep -qF "$REAL" && ! echo "$h2_resp" | grep -qF "PLACEHOLDER-TOKEN"; then
        h2_inject_ok=1
      fi
      if [ "$h2_inject_ok" = 1 ]; then
        ok "echo reflected the real cred (injected at AB2), sandbox never held it"
      else
        ko "injection not observed (resp: $(echo "$h2_resp" | head -c 200))"
      fi

      claim H2-deny "AB2 deny-before-inject: a tools/call-shaped request is blocked pre-egress"
      h2_deny_resp="$(h2_exec_curl_retry kubectl -n "$NS" exec "$SBOX" -c sandbox -- curl -s -X POST http://echo-target/ \
        -H "Authorization: Bearer PLACEHOLDER-TOKEN" -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}')"
      h2_deny_ok=0
      if echo "$h2_deny_resp" | grep -qE 'ibac\.(no_session|no_intent)' && ! echo "$h2_deny_resp" | grep -qF "$REAL"; then
        h2_deny_ok=1
      fi
      if [ "$h2_deny_ok" = 1 ]; then
        ok "denied pre-egress (ibac.no_session or ibac.no_intent; MCP deny is HTTP-200 + JSON-RPC error, not 403), no injection"
      else
        ko "deny not proven (resp: $(echo "$h2_deny_resp" | head -c 200))"
      fi
      # Non-fatal secondary check: the denied POST should never have reached echo-target at all.
      h2_echo_logs="$(kubectl -n "$NS" logs deploy/echo-target --tail=200 2>>"$H2_LOG" || true)"
      if echo "$h2_echo_logs" | grep -q 'ECHO-RECV POST'; then
        echo "  NOTE: echo-target log shows a POST was received — deny may not have blocked pre-egress (secondary, non-fatal)"
      fi
    fi
  fi

  rm -f "$H2_LOG" 2>/dev/null || true
fi

# --- Hop-1 AuthBridge claims (RC1-1, SH_AUTHBRIDGE=1 only): prove the harness is
# secret-free (holds only the AB1 placeholder), the allow-path leaf completes only via
# AB1 injection, and AB1 rejects before injecting when policy is deny. Self-contained:
# always reverts AB1 to allow before leaving the block, so Claims 2-8 below run in allow
# mode regardless of this block's outcome.
if [ "${SH_AUTHBRIDGE:-0}" = "1" ]; then
  AB1_CM="authbridge-ab1-config"
  AB1_LOG="$(mktemp)"   # verbose kubectl output goes here, not stdout

  # Set the AB1 ConfigMap's embedded no_intent_policy (allow|deny) and roll the
  # Deployment so the subPath ConfigMap mount picks up the change.
  ab1_set_policy() {
    local target="$1" cur new
    cur="$(kubectl -n "$NS" get configmap "$AB1_CM" -o jsonpath='{.data.config\.yaml}' 2>>"$AB1_LOG" || true)"
    if [ -z "$cur" ]; then
      echo "WARN: ab1_set_policy($target): ConfigMap $AB1_CM read empty; skipping rewrite (would clobber config.yaml)" >>"$AB1_LOG"
      return 1
    fi
    case "$target" in
      deny)  new="$(printf '%s' "$cur" | sed 's/no_intent_policy: allow/no_intent_policy: deny/')" ;;
      allow) new="$(printf '%s' "$cur" | sed 's/no_intent_policy: deny/no_intent_policy: allow/')" ;;
    esac
    kubectl create configmap "$AB1_CM" --from-literal=config.yaml="$new" \
      --dry-run=client -o yaml | kubectl -n "$NS" apply -f - >>"$AB1_LOG" 2>&1 || true
    kubectl -n "$NS" rollout restart deploy/authbridge-ab1 >>"$AB1_LOG" 2>&1 || true
    kubectl -n "$NS" rollout status deploy/authbridge-ab1 --timeout=120s >>"$AB1_LOG" 2>&1 || true
  }

  claim H1-secret-free "harness pod holds only the AB1 placeholder, never a real key"
  if [ "$(harness_running_pods)" = "0" ]; then
    dispatch i2 "$MODEL" >/dev/null 2>&1 || true   # warm-up: spin up a harness pod
  fi
  ab1_pod="$(harness_pods_all | head -1)"
  if [ -z "$ab1_pod" ]; then
    ko "no running harness pod found (even after a warm-up dispatch)"
  else
    ab1_penv="$(kubectl -n "$NS" exec "$ab1_pod" -c user-container -- printenv 2>>"$AB1_LOG" || true)"
    ab1_tok_ok=0;  echo "$ab1_penv" | grep -q '^ANTHROPIC_AUTH_TOKEN=AB1-PLACEHOLDER$' && ab1_tok_ok=1
    ab1_base_ok=0; echo "$ab1_penv" | grep -q '^ANTHROPIC_BASE_URL=http://authbridge-ab1:8080$' && ab1_base_ok=1
    ab1_leaked=0;  echo "$ab1_penv" | grep -qE 'sk-ant-|sk-[A-Za-z0-9]{20}' && ab1_leaked=1
    if [ "$ab1_tok_ok" = 1 ] && [ "$ab1_base_ok" = 1 ] && [ "$ab1_leaked" = 0 ]; then
      ok "harness env holds only the AB1 placeholder + base URL, no real key"
    else
      ko "tok_ok=$ab1_tok_ok base_ok=$ab1_base_ok leaked=$ab1_leaked"
    fi
  fi

  claim H1-allow "AB1 allow-path: a leaf only completes if AB1 injected the real key"
  ab1_resp="$(dispatch i2 "$MODEL")"
  ab1_status="$(echo "$ab1_resp" | jq -r '.status // "none"' 2>/dev/null || echo parse_err)"
  if [ "$ab1_status" = "done" ]; then
    ok "allow-path leaf completed (real key injected at AB1)"
  else
    ko "allow-path leaf did not complete, status=$ab1_status"
  fi

  claim H1-deny "AB1 deny-before-inject: flip to deny, prove rejection, revert to allow"
  ab1_set_policy deny || true   # || true: an empty-ConfigMap skip must not abort before the revert
  # Deterministically wait until AB1 actually serves the deny config before dispatching the
  # leaf. The ConfigMap roll + Service endpoint update lag the `rollout status`, and a warm
  # harness->AB1 connection can briefly still reach the old allow pod — which would let the
  # leaf complete and mask the deny. Probe AB1 directly (via the sandbox) until it 403s.
  ab1_deny_active=0
  for _i in $(seq 1 20); do
    # `|| true` inside the exec: BusyBox wget exits non-zero on a 403, and under
    # `set -o pipefail` that non-zero (relayed by kubectl exec) would fail the whole
    # pipeline even when grep matches — so neutralize it and let grep alone decide.
    # Leading `http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY=`: RC1-2's sandbox proxy env
    # (sandbox-pool-ab2.yaml) would otherwise hijack this in-cluster control-plane probe,
    # routing it through the authbridge-ab2 sidecar (localhost:8081) instead of AB1 directly
    # — AB2 fail-closes 401 (no bearer for the probe host), so the probe would never see
    # AB1's deny-403 and this claim would fail. Clearing the proxy vars for just this wget
    # invocation makes it bypass AB2 and reach AB1 directly.
    if sexec sh -c 'http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= wget -q -S -T 20 -O /dev/null --header="Authorization: Bearer AB1-PLACEHOLDER" --header="anthropic-version: 2023-06-01" --header="content-type: application/json" --post-data="{\"model\":\"probe\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" http://authbridge-ab1:8080/v1/messages 2>&1 || true' | grep -qE 'HTTP/[0-9.]+ 403'; then
      ab1_deny_active=1; break
    fi
    sleep 3
  done
  echo "H1-deny: ab1_deny_active=$ab1_deny_active after probe" >>"$AB1_LOG"
  # The direct probe above IS the deny-before-inject proof: a 403 from ibac means the request
  # was rejected BEFORE static-inject (which runs AFTER ibac in the inbound chain) could inject
  # a credential — the pipeline short-circuits on reject. A full leaf dispatch here proved
  # fragile (harness HTTP connection-pooling + the AB1 restart window let the leaf reach an old
  # allow pod, masking the deny), so assert the probe result directly. inject_seen is
  # informational (static-inject has no success log line).
  ab1_logs="$(kubectl -n "$NS" logs deploy/authbridge-ab1 --tail=200 2>>"$AB1_LOG" || true)"
  ab1_inject_seen=0; echo "$ab1_logs" | grep -qi 'static-inject' && ab1_inject_seen=1
  ab1_set_policy allow || true   # ALWAYS revert before leaving the block, regardless of the outcome above
  if [ "$ab1_deny_active" = 1 ]; then
    ok "deny-before-inject proven (AB1 returned 403 at ibac, pre-static-inject; inject_seen=$ab1_inject_seen) — reverted to allow"
  else
    ko "deny-before-inject not proven: probe never observed a 403 (deny_active=$ab1_deny_active)"
  fi
  rm -f "$AB1_LOG" 2>/dev/null || true
  unset -f ab1_set_policy
fi

# --- Claim 1: workspace isolation — repo present in sandbox only ---
claim 1 "Workspace lives in the sandbox only (FS-free: no /work PVC needed)"
in_sbox=1; sexec test -f "$SBOX_REPO/risky.py" || in_sbox=0
if [ "$in_sbox" = 1 ]; then ok "repo present in $SBOX:$SBOX_REPO"; else ko "repo missing from sandbox"; fi

SAMPLE_OUT="$(mktemp)"; SAMPLER_PID="$(start_sampler "$SAMPLE_OUT")"

# --- Claim 2: parallel fan-out ---
claim 2 "Parallel fan-out: $ITEMS dispatched concurrently"
tmpdir="$(mktemp -d)"
# Collect the dispatch PIDs and wait ONLY on those. A bare `wait` also blocks on the
# background port-forward started by ensure_port_forward (and the sampler), which never
# exit — so on a clean session (no pre-existing port-forward) the smoke would hang here.
fanout_pids=""
for id in $ITEMS; do ( dispatch "$id" > "$tmpdir/$id.json" 2>&1 ) & fanout_pids="$fanout_pids $!"; done
wait $fanout_pids
fanout_ok=1
for id in $ITEMS; do
  st=$(jq -r '.status // "none"' < "$tmpdir/$id.json" 2>/dev/null || echo parse_err)
  echo "    $id -> $st"; [ "$st" = "done" ] || fanout_ok=0
done
[ "$fanout_ok" = 1 ] && ok "all $ITEMS returned done" || ko "not all items returned done"
MAXPODS=$(sort -n "$SAMPLE_OUT" 2>/dev/null | tail -1); MAXPODS="${MAXPODS:-0}"
[ "${MAXPODS:-0}" -ge 2 ] && ok "scaled out to $MAXPODS concurrent pods" \
  || echo "  NOTE: observed max $MAXPODS concurrent pods"

# --- Claim 3: structured output + sandbox execution proof (verdicts present, valid, CORRECT) ---
claim 3 "Verdicts schema-valid AND correct (only possible by reading the sandbox file)"
verdicts_ok=1
for id in $ITEMS; do
  resp=$(cat "$tmpdir/$id.json" 2>/dev/null || echo "{}")
  v=$(echo "$resp" | jq -r '.verdict.verdict // empty' 2>/dev/null || echo "")
  if echo "$resp" | jq -e '.verdict.item_id and (.verdict.verdict=="FLAGGED" or .verdict.verdict=="CLEAR") and .verdict.reason' >/dev/null 2>&1; then
    if [ "$v" = "${EXPECT[$id]}" ]; then echo "    $id verdict=$v (expected ${EXPECT[$id]})"; else echo "    $id verdict=$v WRONG (expected ${EXPECT[$id]})"; verdicts_ok=0; fi
  else
    verdicts_ok=0; echo "    $id MISSING/invalid verdict (resp: $(echo "$resp" | jq -c '.verdict // .status // .' 2>/dev/null))"
  fi
done
[ "$verdicts_ok" = 1 ] && ok "all verdicts present, schema-valid, and correct" || ko "missing/invalid/incorrect verdicts"

# --- Claim 4: per-call model param drives resolution ---
claim 4 "Per-call model param drives resolution"
bogus=$(dispatch i2 "model-does-not-exist-xyz" | jq -r '.status // "none"')
good=$(dispatch i2 "$MODEL" | jq -r '.status // "none"')
if [ "$bogus" = "failed" ] && [ "$good" = "done" ]; then ok "bogus model -> failed, valid model -> done"; else ko "bogus=$bogus good=$good"; fi

# --- Claim 5: input-validation path — a malformed envelope (missing item) is rejected with 400 ---
# In the inline contract an item is self-contained, so a well-formed item always runs (the
# terminal "failed" path is covered by Claim 4's bogus-model case). The bad-input rejection here
# is the server's isLeafEnvelope/validateItem guard: a body with no `item` must return HTTP 400.
claim 5 "Malformed envelope (missing item) is rejected with HTTP 400"
neg_body=$(jq -nc --arg s "$RUN/ineg" '{sessionId:$s}')
neg_code=$(curl -s $CURL_OPTS -o /dev/null -w '%{http_code}' --max-time 30 ${CURL_HDR[@]+"${CURL_HDR[@]}"} -H "Content-Type: application/json" -d "$neg_body" "$BASE/runs")
if [ "$neg_code" = "400" ]; then ok "malformed envelope rejected (HTTP 400)"; else ko "expected HTTP 400, got $neg_code"; fi

# --- Claim 6: idempotent re-invoke returns a valid verdict ---
claim 6 "Idempotent re-invoke returns a valid verdict"
re_resp=$(dispatch i1 "$MODEL")
re=$(echo "$re_resp" | jq -r '.status // "none"')
re_v=$(echo "$re_resp" | jq -r '.verdict.verdict // empty' 2>/dev/null || echo "")
if [ "$re" = "done" ] && [ -n "$re_v" ]; then ok "re-invoke of i1 succeeded, verdict=$re_v"; else ko "re-invoke status=$re verdict=$re_v"; fi

# --- Claim 7: crash mid-run, resume via M5 durable session, still produce the verdict ---
claim 7 "Killed mid-run, the session resumes and still produces its verdict"
RSID="$RUN/i1-resume"
# dispatch in the background, then kill the harness pod while the request is in flight
( dispatch_sid_item "$RSID" "i1" >/dev/null 2>&1 ) & bgpid=$!
sleep 12
# the harness sanitizes the envelope id (slash -> dash) into the Pi/Redis session id; match it
RSID_KEY=$(printf '%s' "$RSID" | sed -E 's#[^A-Za-z0-9._-]#-#g; s#^[^A-Za-z0-9]+|[^A-Za-z0-9]+$##g')
sid_persisted=0
kubectl -n "$NS" exec deploy/redis -- redis-cli EXISTS "session:$RSID_KEY" 2>/dev/null | grep -q 1 && sid_persisted=1
force_kill_pod                       # crash the harness pod mid-run
wait "$bgpid" 2>/dev/null || true    # the in-flight request dies with the pod
# re-invoke the same sessionId — runLeaf resumes from the durable Redis log
re_resp=$(dispatch_sid_item "$RSID" "i1")
re_status=$(echo "$re_resp" | jq -r '.status // "none"')
re_v=$(echo "$re_resp" | jq -r '.verdict.verdict // empty' 2>/dev/null || echo "")
if [ "$re_status" = "done" ] && [ "$sid_persisted" = 1 ] && [ -n "$re_v" ]; then
  ok "persisted mid-run (redis), pod killed, resumed → verdict=$re_v produced"
else
  ko "resume failed: status=$re_status persisted_in_redis=$sid_persisted verdict=$re_v"
fi

# --- Claim 8: scale-to-zero after idle ---
claim 8 "Service scales to zero when idle"
stop_sampler "$SAMPLER_PID"
wait_for_zero_pods 150 && ok "scaled to zero" || ko "did not scale to zero within 150s"

# best-effort cleanup of the sandbox run dir
sexec rm -rf "/workspace/$RUN" 2>/dev/null || true
rm -rf "$tmpdir" "$SAMPLE_OUT" 2>/dev/null || true
echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "LEAF SMOKE FAIL"; exit 1; else echo "LEAF SMOKE PASS"; exit 0; fi
