#!/usr/bin/env bash
# deploy/knative/setup-k8s.sh
# One-shot setup for a generic (vanilla) Kubernetes cluster — the sibling of
# setup-kind.sh (Kind) and setup-ocp.sh (OpenShift). Installs Knative Serving +
# Kourier, the agent-sandbox controller, Redis, the sandbox pool, the LLM secret,
# and the harness Knative Service, using the SHARED base manifests (deploy/knative/*.yaml)
# with cluster-specifics injected via flags/env — no per-cluster forked YAMLs.
#
# Unlike setup-kind.sh (which builds + `kind load`s a local image) this takes PREBUILT
# image refs via --image/--sandbox-image (like setup-ocp.sh). Any registry works, including
# an in-cluster registry reachable by the node runtime (pass its address as the image ref).
#
# Prerequisites:
#   - kubectl configured to the target cluster (--context or current-context)
#   - A default StorageClass, or pass --storage-class (e.g. ibm-scale-csi for GPFS)
#   - A model credential (see Environment)
#
# Usage: ./deploy/knative/setup-k8s.sh [OPTIONS]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------------------------------------------------------
# Defaults (all overridable via flags/env)
# ----------------------------------------------------------------------------
DRY_RUN=false
NAMESPACE="default"
HARNESS_IMAGE="ghcr.io/kagenti/serverless-harness:latest"
SANDBOX_IMAGE="ghcr.io/kagenti/serverless-harness-sandbox:latest"
STORAGE_CLASS=""                       # empty => use the cluster's default StorageClass
SKIP_KEDA=true                         # async-leaf / KEDA is opt-in (--with-keda)
INGRESS="none"                         # none | nodeport
KUBECTL_CONTEXT=""
KNATIVE_VERSION="${KNATIVE_VERSION:-v1.14.0}"
KEDA_VERSION="${KEDA_VERSION:-v2.14.0}"

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------
# Logs go to stderr so `--dry-run` stdout is clean, pipeable YAML.
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}→${NC} $1" >&2; }
log_success() { echo -e "${GREEN}✓${NC} $1" >&2; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1" >&2; }
log_error()   { echo -e "${RED}✗${NC} $1" >&2; }

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Stand up the serverless-harness stack on a generic Kubernetes cluster:
Knative Serving + Kourier, agent-sandbox controller, Redis, the sandbox pool,
the LLM secret, and the harness Knative Service (reachable in-cluster; see --ingress).

Options:
  --namespace <ns>       Target namespace (default: ${NAMESPACE})
  --image <ref>          Harness image, prebuilt (default: ${HARNESS_IMAGE})
  --sandbox-image <ref>  Sandbox image, prebuilt (default: ${SANDBOX_IMAGE})
  --storage-class <sc>   StorageClass for the sandbox /workspace PVCs
                         (default: the cluster's default StorageClass).
                         E.g. --storage-class ibm-scale-csi for IBM Storage Scale (GPFS).
  --ingress <mode>       External reach: none (in-cluster + port-forward) or
                         nodeport (expose Kourier via NodePort). (default: ${INGRESS})
  --with-keda            Install KEDA for the async-leaf ScaledJob path (default: off)
  --skip-keda            Skip KEDA (default)
  --context <ctx>        kubectl context to target (default: current-context)
  --dry-run              Print rendered manifests / commands without applying
  -h, --help             Show this help

Environment:
  ANTHROPIC_API_KEY      Direct Anthropic key, OR
  ANTHROPIC_AUTH_TOKEN   Gateway/self-hosted token (+ ANTHROPIC_BASE_URL for the endpoint)
  SH_MODEL               Model id (default: the harness default)
  SH_MODEL_CUSTOM        1 to target a self-hosted Anthropic-compatible endpoint whose
                         model id is not a built-in Anthropic id (needs ANTHROPIC_BASE_URL)
  KNATIVE_VERSION        Knative Serving/Kourier version (default: ${KNATIVE_VERSION})
  KEDA_VERSION           KEDA version when --with-keda (default: ${KEDA_VERSION})

Building images: this script does not build. Build + push the harness and sandbox
images yourself (see README-k8s.md) and pass them via --image/--sandbox-image. Any
registry the cluster can pull works, including an in-cluster registry.

Examples:
  $0                                              # default ns, GHCR images, cluster-default storage
  $0 --namespace serverless-harness --with-keda   # dedicated ns + async-leaf support
  $0 --storage-class ibm-scale-csi                # GPFS-backed sandbox workspaces
  $0 --image my-registry.example.com/sh:dev --sandbox-image my-registry.example.com/sbx:dev
EOF
}

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)      NAMESPACE="$2"; shift 2 ;;
    --image)          HARNESS_IMAGE="$2"; shift 2 ;;
    --sandbox-image)  SANDBOX_IMAGE="$2"; shift 2 ;;
    --storage-class)  STORAGE_CLASS="$2"; shift 2 ;;
    --ingress)        INGRESS="$2"; shift 2 ;;
    --with-keda)      SKIP_KEDA=false; shift ;;
    --skip-keda)      SKIP_KEDA=true; shift ;;
    --context)        KUBECTL_CONTEXT="$2"; shift 2 ;;
    --context=*)      KUBECTL_CONTEXT="${1#*=}"; shift ;;
    --dry-run)        DRY_RUN=true; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) log_error "Unknown option: $1"; usage; exit 1 ;;
  esac
done

case "$INGRESS" in none|nodeport) ;; *) log_error "--ingress must be none|nodeport"; exit 1 ;; esac

KUBECTL=(kubectl)
[ -n "$KUBECTL_CONTEXT" ] && KUBECTL=(kubectl --context "$KUBECTL_CONTEXT")

log_info "serverless-harness setup on Kubernetes"
log_info "context=$(${KUBECTL[@]} config current-context) namespace=$NAMESPACE"
log_info "harness=$HARNESS_IMAGE sandbox=$SANDBOX_IMAGE storage=${STORAGE_CLASS:-<default>} ingress=$INGRESS keda=$([ "$SKIP_KEDA" = true ] && echo off || echo on)"

# ----------------------------------------------------------------------------
# render_base: emit the shared base manifests with cluster-specifics substituted.
# Mirrors setup-ocp.sh's render_overlay_dir(): the base YAMLs stay shared; per-cluster
# values are injected here rather than by forking files.
#   - image refs: Kind's dev.local tags / the pool's alpine placeholder -> $HARNESS_IMAGE / $SANDBOX_IMAGE
#   - namespace:  namespace: default + redis.default.svc -> $NAMESPACE
#   - storageClass: injected into the sandbox pool's volumeClaimTemplates only when set
# ----------------------------------------------------------------------------
render_base() {
  local file="$1"
  sed \
    -e "s#dev.local/serverless-harness:local#${HARNESS_IMAGE}#g" \
    -e "s#dev.local/serverless-harness-sandbox:local#${SANDBOX_IMAGE}#g" \
    -e "s#alpine:3.20#${SANDBOX_IMAGE}#g" \
    "$file" \
  | if [ "$NAMESPACE" != "default" ]; then
      sed -e "s#namespace: default#namespace: ${NAMESPACE}#g" \
          -e "s#redis.default.svc#redis.${NAMESPACE}.svc#g"
    else cat; fi \
  | if [ -n "$STORAGE_CLASS" ]; then
      # Insert storageClassName above accessModes in each volumeClaimTemplate PVC spec
      # (only the sandbox pool has these). Preserves the existing 8-space indent.
      sed -e "s#^\( *\)accessModes: \[\"ReadWriteOnce\"\]#\1storageClassName: ${STORAGE_CLASS}\n\1accessModes: [\"ReadWriteOnce\"]#g"
    else cat; fi
}

apply_base() {
  local file="$1"
  if $DRY_RUN; then echo "# ---- rendered: $file ----"; render_base "$file"; return; fi
  render_base "$file" | "${KUBECTL[@]}" apply -f -
}

# ----------------------------------------------------------------------------
# 0. Namespace
# ----------------------------------------------------------------------------
if [ "$NAMESPACE" != "default" ]; then
  log_info "Ensuring namespace: $NAMESPACE"
  $DRY_RUN || "${KUBECTL[@]}" create namespace "$NAMESPACE" --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -
fi

# ----------------------------------------------------------------------------
# 1. Knative Serving + Kourier (raw manifests — same as Kind; no OLM on vanilla k8s)
# ----------------------------------------------------------------------------
log_info "Installing Knative Serving $KNATIVE_VERSION + Kourier"
if ! $DRY_RUN; then
  "${KUBECTL[@]}" apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-crds.yaml"
  "${KUBECTL[@]}" apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-core.yaml"
  "${KUBECTL[@]}" apply -f "https://github.com/knative-extensions/net-kourier/releases/download/knative-${KNATIVE_VERSION}/kourier.yaml"
  "${KUBECTL[@]}" patch configmap/config-network -n knative-serving --type merge \
    --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
  "${KUBECTL[@]}" patch configmap/config-domain -n knative-serving --type merge \
    --patch '{"data":{"example.com":""}}'
  "${KUBECTL[@]}" patch configmap/config-autoscaler -n knative-serving --type merge \
    --patch '{"data":{"stable-window":"20s","scale-to-zero-grace-period":"10s","container-concurrency-target-percentage":"100"}}'
  # PVC read+write + securityContext feature flags (harness/sandbox mount PVCs, run non-root).
  "${KUBECTL[@]}" patch configmap/config-features -n knative-serving --type merge \
    --patch '{"data":{"kubernetes.podspec-persistent-volume-claim":"enabled","kubernetes.podspec-persistent-volume-write":"enabled","kubernetes.podspec-securitycontext":"enabled"}}'
  "${KUBECTL[@]}" wait --for=condition=Available deployment --all -n knative-serving --timeout=180s
fi

# ----------------------------------------------------------------------------
# 2. KEDA (opt-in, --with-keda) — async-leaf ScaledJob path
# ----------------------------------------------------------------------------
if [ "$SKIP_KEDA" != true ]; then
  log_info "Installing KEDA $KEDA_VERSION"
  if ! $DRY_RUN; then
    "${KUBECTL[@]}" apply --server-side -f "https://github.com/kedacore/keda/releases/download/${KEDA_VERSION}/keda-${KEDA_VERSION#v}.yaml"
    "${KUBECTL[@]}" wait --for=condition=Available deployment --all -n keda --timeout=180s || true
  fi
fi

# ----------------------------------------------------------------------------
# 3. agent-sandbox controller (kubernetes-sigs/agent-sandbox v0.5.0)
# ----------------------------------------------------------------------------
log_info "Installing agent-sandbox controller"
if ! $DRY_RUN; then
  "${KUBECTL[@]}" apply --server-side -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.0/manifest.yaml"
  "${KUBECTL[@]}" -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s
  "${KUBECTL[@]}" wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=120s
fi

# ----------------------------------------------------------------------------
# 4. Redis
# ----------------------------------------------------------------------------
log_info "Deploying Redis"
apply_base "$SCRIPT_DIR/redis.yaml"
$DRY_RUN || "${KUBECTL[@]}" wait --for=condition=Available deployment/redis -n "$NAMESPACE" --timeout=60s

# ----------------------------------------------------------------------------
# 5. Sandbox pool
# ----------------------------------------------------------------------------
log_info "Deploying sandbox pool"
apply_base "$SCRIPT_DIR/sandbox-pool.yaml"
POOL_SELECTOR="sh.kagenti.io/sandbox-pool=default"
if ! $DRY_RUN; then
  "${KUBECTL[@]}" -n "$NAMESPACE" wait --for=condition=Ready pod -l "$POOL_SELECTOR" --timeout=180s || {
    log_error "sandbox pool not all Ready (label='$POOL_SELECTOR')"
    "${KUBECTL[@]}" -n "$NAMESPACE" get pods -l "$POOL_SELECTOR" -o wide | head -40
    exit 1
  }
fi

# ----------------------------------------------------------------------------
# 6. LLM credentials secret (direct key or gateway/self-hosted token)
# ----------------------------------------------------------------------------
log_info "Creating llm-credentials secret"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  log_error "Set ANTHROPIC_API_KEY (direct) or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (gateway/self-hosted)"
  exit 1
fi
if ! $DRY_RUN; then
  SECRET_ARGS=(--from-literal=api-key="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN}}")
  [ -n "${ANTHROPIC_BASE_URL:-}" ]   && SECRET_ARGS+=(--from-literal=base-url="$ANTHROPIC_BASE_URL")
  [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && SECRET_ARGS+=(--from-literal=auth-token="$ANTHROPIC_AUTH_TOKEN")
  "${KUBECTL[@]}" create secret generic llm-credentials -n "$NAMESPACE" "${SECRET_ARGS[@]}" \
    --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -
fi

# ----------------------------------------------------------------------------
# 7. Harness Knative Service (+ SA/RBAC in service.yaml)
# ----------------------------------------------------------------------------
log_info "Deploying harness Knative Service"
apply_base "$SCRIPT_DIR/service.yaml"
# Optional self-hosted-model env (SH_MODEL / SH_MODEL_CUSTOM) — set on the ksvc if provided.
if ! $DRY_RUN; then
  ENV_SETS=()
  [ -n "${SH_MODEL:-}" ]        && ENV_SETS+=("SH_MODEL=${SH_MODEL}")
  [ -n "${SH_MODEL_CUSTOM:-}" ] && ENV_SETS+=("SH_MODEL_CUSTOM=${SH_MODEL_CUSTOM}")
  [ "${#ENV_SETS[@]}" -gt 0 ] && "${KUBECTL[@]}" -n "$NAMESPACE" set env ksvc/serverless-harness "${ENV_SETS[@]}"
  "${KUBECTL[@]}" -n "$NAMESPACE" wait ksvc/serverless-harness --for=condition=Ready --timeout=180s
fi

# ----------------------------------------------------------------------------
# 8. Ingress (optional)
# ----------------------------------------------------------------------------
if [ "$INGRESS" = "nodeport" ] && ! $DRY_RUN; then
  log_info "Exposing Kourier via NodePort"
  "${KUBECTL[@]}" -n kourier-system patch svc kourier --type merge -p '{"spec":{"type":"NodePort"}}'
fi

# ----------------------------------------------------------------------------
# Access info
# ----------------------------------------------------------------------------
$DRY_RUN && { log_success "dry-run complete (no changes applied)"; exit 0; }
log_success "Setup complete."
echo ""
echo "In-cluster URL: http://serverless-harness.${NAMESPACE}.svc.cluster.local"
if [ "$INGRESS" = "nodeport" ]; then
  NP=$("${KUBECTL[@]}" -n kourier-system get svc kourier -o jsonpath='{.spec.ports[?(@.port==80)].nodePort}' 2>/dev/null || echo "<pending>")
  echo "NodePort (HTTP): reach any node at :$NP with a Host header:"
  echo "  curl -H 'Host: serverless-harness.${NAMESPACE}.example.com' -H 'Content-Type: application/json' \\"
  echo "       -d '{\"prompt\":\"Hello\"}' http://<node-ip>:$NP/turn"
else
  echo "Reach it via a port-forward (no external ingress configured):"
  echo "  kubectl ${KUBECTL_CONTEXT:+--context $KUBECTL_CONTEXT} port-forward -n kourier-system svc/kourier 8080:80"
  echo "  curl -H 'Host: serverless-harness.${NAMESPACE}.example.com' -H 'Content-Type: application/json' \\"
  echo "       -d '{\"prompt\":\"Hello\"}' http://localhost:8080/turn"
fi
