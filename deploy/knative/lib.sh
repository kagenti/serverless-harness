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
