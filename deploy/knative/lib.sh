#!/usr/bin/env bash
# deploy/knative/lib.sh
# Shared helpers for the Knative smoke + experiment drivers.
# Source this; do not execute. Targets ksvc serverless-harness in namespace default.
#
# Kind (default): Kourier port-forward on localhost + a Host header.
# OpenShift: export KSVC_URL=<https route> (see setup-ocp.sh output) to target the
#   auto-created Route directly — no port-forward, no Host header, TLS-skip (-k).

NS="${NS:-default}"
KSVC="${KSVC:-serverless-harness}"
PORT="${PORT:-8080}"
HOST_HEADER="${HOST_HEADER:-Host: ${KSVC}.${NS}.example.com}"
BASE="${BASE:-http://localhost:${PORT}}"
SELECTOR="serving.knative.dev/service=${KSVC}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-5}"

# OpenShift/Route mode: target the Route URL directly.
KSVC_URL="${KSVC_URL:-}"
CURL_OPTS="${CURL_OPTS:-}"
if [ -n "$KSVC_URL" ]; then
  BASE="$KSVC_URL"
  HOST_HEADER=""                       # the Route matches on its own host
  CURL_OPTS="-k${CURL_OPTS:+ $CURL_OPTS}"  # router serves a self-signed/ingress cert
fi
# Optional Host-header curl args (empty in Route mode). Expand guarded for set -u.
CURL_HDR=()
[ -n "$HOST_HEADER" ] && CURL_HDR=(-H "$HOST_HEADER")

PASS=0
FAIL=0
ok()  { echo "  PASS${1:+: $1}"; PASS=$((PASS + 1)); }
ko()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Count Running harness pods.
harness_running_pods() {
  kubectl get pods -n "$NS" -l "$SELECTOR" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '
}

# Wait until no harness pods are Running (scale-to-zero). Arg: timeout seconds (default 90).
wait_for_zero_pods() {
  local timeout="${1:-90}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    [ "$(harness_running_pods)" = "0" ] && return 0
    sleep "$SAMPLE_INTERVAL"; waited=$((waited + SAMPLE_INTERVAL))
  done
  return 1
}

# POST /turn. Usage: turn "prompt" [sessionId]. Echoes raw JSON response.
turn() {
  local prompt="$1" sid="${2:-}"
  local body
  if [ -n "$sid" ]; then
    body=$(jq -nc --arg s "$sid" --arg p "$prompt" '{sessionId:$s, prompt:$p}')
  else
    body=$(jq -nc --arg p "$prompt" '{prompt:$p}')
  fi
  # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
  curl -s $CURL_OPTS --max-time 120 ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
    -H "Content-Type: application/json" -d "$body" "$BASE/turn"
}

# Set the ksvc min-scale annotation (creates a new revision) and wait for Ready.
set_min_scale() {
  kubectl patch ksvc "$KSVC" -n "$NS" --type=merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/min-scale\":\"$1\"}}}}}" >/dev/null
  wait_ksvc_ready
}

wait_ksvc_ready() {
  kubectl wait --for=condition=Ready "ksvc/$KSVC" -n "$NS" --timeout=120s >/dev/null 2>&1 || true
}

# Force-delete all harness pods (crash simulation).
force_kill_pod() {
  kubectl delete pod -n "$NS" -l "$SELECTOR" --force --grace-period=0 >/dev/null 2>&1 || true
}

# LEGACY HELPER — retained for leaf-gate-smoke.sh and leaf-cron-smoke.sh (the /work-based
# gate/cron smokes). The P1 FS-free harness path (leaf-smoke.sh, leaf-async-smoke.sh) no
# longer calls this; the inline-item envelope needs no /work PVC.
# Create run dirs on the shared leaf-work PVC via the orchestrator pod, world-writable.
# The orchestrator runs as root, so a plain `mkdir -p` leaves these 0755 root:root; the
# non-root harness (uid 65532, readOnlyRootFilesystem) then cannot create result subdirs
# or write result_ref and hits EACCES (issue #39). `chmod 777` lets the harness UID write.
# On Kind the ksvc's fsGroup:65532 is NOT applied to these orchestrator-created dirs
# (local-path/hostPath PVC), so an explicit chmod — not fsGroup — is the reliable fix.
# Usage: seed_work_dirs <dir> [dir...]   (uses $ORCH, default leaf-orchestrator, and $NS)
seed_work_dirs() {
  kubectl -n "$NS" exec "${ORCH:-leaf-orchestrator}" -- \
    sh -c 'mkdir -p "$@" && chmod 777 "$@"' _ "$@"
}

# Create the llm-credentials secret from the operator's env if absent. Fails if env unset.
ensure_secret() {
  if kubectl get secret llm-credentials -n "$NS" >/dev/null 2>&1; then return 0; fi
  : "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN must be set to create llm-credentials}"
  kubectl create secret generic llm-credentials -n "$NS" \
    --from-literal=api-key="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN}}" \
    --from-literal=auth-token="${ANTHROPIC_AUTH_TOKEN}" \
    --from-literal=base-url="${ANTHROPIC_BASE_URL:-}" >/dev/null
}

# Start a kourier port-forward if nothing is listening on $PORT. Echoes the bg pid (or empty).
# OpenShift/Route mode (KSVC_URL set): target the Route directly, no port-forward.
ensure_port_forward() {
  [ -n "${KSVC_URL:-}" ] && return 0
  # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
  if curl -s $CURL_OPTS -o /dev/null --max-time 2 "$BASE/" 2>/dev/null; then return 0; fi
  kubectl port-forward -n kourier-system svc/kourier "${PORT}:80" >/dev/null 2>&1 &
  local pid=$!
  sleep 3
  echo "$pid"
}

# Background pod sampler. start_sampler <outfile> echoes pid; sum with pod_seconds_from.
start_sampler() {
  local out="$1"
  { while :; do harness_running_pods >> "$out"; sleep "$SAMPLE_INTERVAL"; done; } >/dev/null 2>&1 &
  echo $!
}
stop_sampler() { kill "$1" 2>/dev/null || true; }
pod_seconds_from() { awk -v iv="$SAMPLE_INTERVAL" '{s+=$1} END{printf "%d", s*iv}' "$1"; }

# --- P3 sharing-ratio experiment helpers ---------------------------------------------------

# Milliseconds since the epoch, portable across GNU date (%s%3N) and BSD/macOS date (no %N,
# which would leave a literal "N" and break arithmetic). Falls back to python3, then to
# second-precision as a last resort.
now_ms() {
  local ms; ms=$(date +%s%3N 2>/dev/null)
  case "$ms" in *[!0-9]*|"") ms=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null) ;; esac
  case "$ms" in *[!0-9]*|"") ms=$(( $(date +%s) * 1000 )) ;; esac
  printf '%s' "$ms"
}

# The hermetic git-daemon repo URL (see deploy/knative/gitd.yaml).
gitd_repo_url() { echo "git://gitd.${NS}.svc:9418/repo.git"; }

# Wait until the gitd Deployment is Available. Arg: timeout seconds (default 120).
wait_gitd() {
  kubectl -n "$NS" rollout status deploy/gitd --timeout="${1:-120}s" >/dev/null 2>&1
}

# POST /runs with a P2 converge-path envelope (repoUrl+ref => sandbox converges + worktrees).
# Usage: dispatch_converge <sessionId> <item_id> <file> <pattern> <ref> [model]
dispatch_converge() {
  local sid="$1" id="$2" file="$3" pat="$4" ref="$5" model="${6:-${SH_MODEL:-claude-haiku-4-5}}"
  local body
  body=$(jq -nc --arg s "$sid" --arg id "$id" --arg f "$file" --arg p "$pat" \
    --arg u "$(gitd_repo_url)" --arg r "$ref" --arg m "$model" \
    '{sessionId:$s, item:{item_id:$id, file:$f, pattern:$p}, repoUrl:$u, ref:$r, model:$m}')
  # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
  curl -s $CURL_OPTS --max-time 240 ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
    -H "Content-Type: application/json" -d "$body" "$BASE/runs"
}

# Recover a completed leaf's result (incl. the solve `patch`) by polling GET /runs/status until a
# terminal status. The harness persists leaf:result:<sid> to Redis BEFORE it writes the POST /runs
# HTTP body (packages/knative-server/src/server.ts writeResult, awaited pre-response), so a lost 200
# body does NOT lose the result — this reads it back without re-running the (expensive) solve.
# Echoes the terminal record JSON; empty on timeout. Usage: poll_leaf_result <sessionId> [timeoutSec]
# NOTE: default timeout is 900s to match dispatch_solve's sync --max-time, since real SWE-bench solve
# leaves run for minutes (T6 follow-up measured ~8 min for a light instance). For the authoritative
# run the harness ksvc timeoutSeconds must also exceed the max leaf runtime, else the handler is
# killed before it persists leaf:result and no polling can recover it.
poll_leaf_result() {
  local sid="$1" timeout="${2:-900}" waited=0 resp st enc
  enc=$(jq -rn --arg s "$sid" '$s|@uri')
  while [ "$waited" -lt "$timeout" ]; do
    # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
    resp=$(curl -s $CURL_OPTS --max-time 15 ${CURL_HDR[@]+"${CURL_HDR[@]}"} "$BASE/runs/status?sessionId=$enc" || true)
    st=$(jq -r '.status // empty' <<<"$resp" 2>/dev/null || true)
    case "$st" in solved|failed|done|aborted) echo "$resp"; return 0 ;; esac
    sleep 3; waited=$((waited + 3))
  done
  echo "$resp"; return 1
}

# POST /runs with a provider-emitted solve `post` body (Plan C). Merges sessionId + model.
# Echoes the raw JSON response; on transient transport loss of the sync body (empty/non-JSON, no
# .status) it falls back to poll_leaf_result so the result is recovered from Redis, NOT re-run.
# Usage: dispatch_solve <sessionId> <postJson> [model]
dispatch_solve() {
  local sid="$1" post="$2" model="${3:-${SH_MODEL:-claude-haiku-4-5}}" body resp st
  body=$(jq -c --arg s "$sid" --arg m "$model" '. + {sessionId:$s, model:$m}' <<<"$post")
  # shellcheck disable=SC2086  # CURL_OPTS is intentionally word-split
  resp=$(curl -s $CURL_OPTS --max-time 900 ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
    -H "Content-Type: application/json" -d "$body" "$BASE/runs" || true)
  st=$(jq -r '.status // empty' <<<"$resp" 2>/dev/null || true)
  # A saturated verdict is HTTP 503 with a body ({status:failed,reason:saturated}) → .status present →
  # fast path (it is intentionally not persisted, so must not be treated as recoverable). Only an
  # empty/garbled body (transport loss) has no .status → recover the persisted result.
  if [ -n "$st" ]; then echo "$resp"; return 0; fi
  poll_leaf_result "$sid"
}

# Append one official-shape SWE-bench prediction line to a per-run predictions.jsonl.
# Usage: append_prediction <file> <instance_id> <model> <runs_response_json>
append_prediction() {
  local file="$1" id="$2" model="$3" resp="$4" patch
  patch=$(jq -r '.patch // ""' <<<"$resp" 2>/dev/null || echo "")
  jq -nc --arg i "$id" --arg m "$model" --arg p "$patch" \
    '{instance_id:$i, model_name_or_path:$m, model_patch:$p}' >>"$file"
}

# Classify a dispatch response into one health bucket for the experiment health tally (spec §8):
#   solved     — completed leaf (include in duty/throughput/reservation metrics + predictions)
#   saturated  — sandbox-cap rejection (HTTP 503 {status:failed,reason:saturated}); exclude + count
#   failed     — any other failure verdict (setup_failed/no_verdict/error); exclude + count
#   transport  — empty/garbled body with no .status (transient transport loss); exclude + count
# Usage: leaf_health_class <runs_response_json>
leaf_health_class() {
  local resp="$1" st rs
  st=$(jq -r '.status // empty' <<<"$resp" 2>/dev/null || true)
  case "$st" in
    solved|done) echo solved ;;
    failed) rs=$(jq -r '.reason // "error"' <<<"$resp" 2>/dev/null || true)
            [ "$rs" = saturated ] && echo saturated || echo failed ;;
    *)      echo transport ;;
  esac
}

# Sum ms= from [exec-timing] lines in a harness pod's log (needs KAGENTI_EXEC_TIMING=1).
# Usage: sum_exec_ms <harness_pod>
sum_exec_ms() {
  kubectl -n "$NS" logs "$1" 2>/dev/null \
    | awk -F'ms=' '/\[exec-timing\]/ {split($2,a," "); s+=a[1]} END{printf "%d", s+0}'
}

# Count [exec-timing] lines in a harness pod log (needs KAGENTI_EXEC_TIMING=1). Usage: count_exec_lines <pod>
count_exec_lines() {
  kubectl -n "$NS" logs "$1" 2>/dev/null | grep -c '\[exec-timing\]' || true
}

# List Running pod names for the harness Knative service (one per line). Knative keeps multiple
# revision pods Running during a config transition, and a leaf may be served by ANY of them, so the
# exec-timing delta must aggregate over all of them rather than a single (possibly non-serving) pod.
harness_pods_all() {
  kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | awk '{print $1}'
}

# Sum sum_exec_ms across ALL Running harness pods (robust to revision churn). Usage: sum_exec_ms_all
sum_exec_ms_all() {
  local total=0 p
  # shellcheck disable=SC2013  # pod names are single tokens; word-splitting the list is intended
  for p in $(harness_pods_all); do total=$(( total + $(sum_exec_ms "$p") )); done
  echo "$total"
}

# Count [exec-timing] lines across ALL Running harness pods (robust to revision churn). Usage: count_exec_lines_all
count_exec_lines_all() {
  local total=0 p
  # shellcheck disable=SC2013
  for p in $(harness_pods_all); do total=$(( total + $(count_exec_lines "$p") )); done
  echo "$total"
}

# Sum setupMs= from [swebench-phase] lines across ALL Running harness pods (Plan C setup-duty).
sum_setup_ms_all() {
  local total=0 p n
  # shellcheck disable=SC2013
  for p in $(harness_pods_all); do
    n=$(kubectl -n "$NS" logs "$p" 2>/dev/null \
      | awk -F'setupMs=' '/\[swebench-phase\]/ {split($2,a," "); s+=a[1]} END{printf "%d", s+0}')
    total=$(( total + n ))
  done
  echo "$total"
}

# Median of integers read one-per-line on stdin (integer result). Usage: printf '%s\n' 3 1 2 | median
median() {
  sort -n | awk '{a[NR]=$1} END{ if(NR==0){print 0} else if(NR%2){print a[(NR+1)/2]} else {printf "%d", int((a[NR/2]+a[NR/2+1])/2)} }'
}

# Patch the ksvc min/max-scale annotations (a merge patch is safe for the annotations map) and wait
# Ready. Usage: set_scale <min> <max>
set_scale() {
  kubectl patch ksvc "$KSVC" -n "$NS" --type=merge -p \
    "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"autoscaling.knative.dev/min-scale\":\"$1\",\"autoscaling.knative.dev/max-scale\":\"$2\"}}}}}" >/dev/null
  wait_ksvc_ready
}

# List Running pool pod names (one per line). Pool selector defaults to the P2 label.
pool_pod_counts() {
  kubectl get pods -n "$NS" -l "${KAGENTI_SANDBOX_POOL_SELECTOR:-sh.kagenti.io/sandbox-pool=default}" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | awk '{print $1}'
}

# Max active leases observed on any single pool pod, read from Redis in the redis pod.
# Usage: max_leases_across_pool   (needs a redis pod reachable as deploy/pod "redis")
max_leases_across_pool() {
  local now; now=$(now_ms)
  local max=0
  for pod in $(pool_pod_counts); do
    local n
    n=$(kubectl -n "$NS" exec deploy/redis -- \
      redis-cli ZCOUNT "sh:sandbox:${pod}:leases" "$now" "+inf" 2>/dev/null | tr -d '[:space:]')
    n="${n:-0}"; [ "$n" -gt "$max" ] && max="$n"
  done
  echo "$max"
}

# Upsert (NAME=value) or remove (NAME-) env vars on the harness ksvc's container[0], then force a
# new Revision. `kubectl set env` does NOT support the Knative Service CRD, and a JSON merge-patch
# would replace the whole env list (dropping the ANTHROPIC_* secretKeyRefs). So read the current
# env, mutate it by name with jq (preserving valueFrom entries), and replace the array via a
# JSON-patch op — a spec.template change makes Knative mint a fresh revision.
set_ksvc_env() {
  local cur jqp='.' i=0 args=() kv name val newenv
  cur=$(kubectl get ksvc "$KSVC" -n "$NS" -o json | jq -c '.spec.template.spec.containers[0].env // []')
  for kv in "$@"; do
    if [ "${kv#*=}" = "$kv" ]; then            # no '=' → removal, arg is "NAME-"
      name="${kv%-}"
      jqp="$jqp | map(select(.name != \$k$i))"
      args+=(--arg "k$i" "$name")
    else                                        # "NAME=value" → upsert (replace any existing)
      name="${kv%%=*}"; val="${kv#*=}"
      jqp="$jqp | (map(select(.name != \$k$i)) + [{name:\$k$i, value:\$v$i}])"
      args+=(--arg "k$i" "$name" --arg "v$i" "$val")
    fi
    i=$((i + 1))
  done
  newenv=$(printf '%s' "$cur" | jq -c ${args[@]+"${args[@]}"} "$jqp")
  kubectl patch ksvc "$KSVC" -n "$NS" --type=json \
    -p "[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/env\",\"value\":$newenv}]" >/dev/null
  wait_ksvc_ready
}

# Sample, per interval, the number of pool pods holding >=1 active lease (reservation footprint).
# reservation-seconds = (sum of samples) * SAMPLE_INTERVAL. start echoes pid; sum with pool_lease_seconds_from.
start_pool_lease_sampler() {
  local out="$1"
  { while :; do
      local now busy=0 n
      now=$(now_ms)
      for pod in $(pool_pod_counts); do
        n=$(kubectl -n "$NS" exec deploy/redis -- \
          redis-cli ZCOUNT "sh:sandbox:${pod}:leases" "$now" "+inf" 2>/dev/null | tr -d '[:space:]')
        [ "${n:-0}" -gt 0 ] && busy=$(( busy + 1 ))
      done
      echo "$busy"; sleep "$SAMPLE_INTERVAL"
    done; } >>"$out" 2>/dev/null &
  echo $!
}
pool_lease_seconds_from() { awk -v iv="$SAMPLE_INTERVAL" '{s+=$1} END{printf "%d", s*iv}' "$1"; }

# Reset the harness ksvc env to the committed service.yaml defaults (pool mode, no timing/cap
# override, no single-pod pin). Used by experiment drivers via `trap ... EXIT` so a run — even
# one that exits mid-way — never leaves the ksvc mutated for the next smoke.
restore_ksvc_env() {
  set_ksvc_env KAGENTI_SANDBOX_POD- KAGENTI_EXEC_TIMING- KAGENTI_SANDBOX_CAP- \
    KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=default >/dev/null 2>&1 || true
  # Reset the autoscaling annotations to the committed service.yaml defaults (min 0 / max 5).
  kubectl patch ksvc "$KSVC" -n "$NS" --type=merge -p \
    '{"spec":{"template":{"metadata":{"annotations":{"autoscaling.knative.dev/min-scale":"0","autoscaling.knative.dev/max-scale":"5"}}}}}' \
    >/dev/null 2>&1 || true
}
