#!/usr/bin/env bash
# deploy/knative/setup-ocp.sh
# One-shot setup of the serverless-harness stack on OpenShift (4.20+).
#
# Sibling of setup-kind.sh, but OpenShift-native (see issue #41):
#   - Knative Serving (+ Kourier) via the Red Hat OpenShift Serverless Operator
#     (OLM Subscription + KnativeServing CR) — not raw upstream manifests.
#   - Autoscaler tuning + PVC/securityContext feature flags set in the
#     KnativeServing CR spec (the operator reverts direct ConfigMap patches).
#   - Redis, sandbox, leaf-work PVC, LLM secret and the harness Knative Service
#     via the deploy/knative/overlays/ocp kustomize overlay.
#   - Sandbox image pre-baked in-cluster against the internal registry (the Kind
#     `apk add`-as-root pod is blocked by the restricted-v2 SCC).
#   - Ingress via the auto-created OpenShift Route (no Kourier port-forward).
#
# Base bring-up: KEDA (async leaf) is opt-in via --with-keda; the optional Redis
# Enterprise Operator is a follow-up — see --help and issue #41.
#
# Prerequisites:
#   - `oc login` to an OpenShift 4.20+ cluster as cluster-admin.
#   - ANTHROPIC_API_KEY (direct) or ANTHROPIC_AUTH_TOKEN [+ ANTHROPIC_BASE_URL] (gateway).
#
# Usage: ./deploy/knative/setup-ocp.sh [OPTIONS]   (see --help)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY_DIR="$SCRIPT_DIR/overlays/ocp"

# ----------------------------------------------------------------------------
# Defaults (all overridable via flags)
# ----------------------------------------------------------------------------
DRY_RUN=false
NAMESPACE="default"
HARNESS_IMAGE="ghcr.io/kagenti/serverless-harness:latest"
SANDBOX_IMAGE=""            # computed from namespace unless overridden
SKIP_SANDBOX_BUILD=false
SKIP_KEDA=true             # base bring-up: async leaf / KEDA is opt-in (--with-keda)
SERVERLESS_CHANNEL="stable"
KEDA_CHANNEL="stable"
LOG_DIR="${LOG_DIR:-/tmp/serverless-harness-ocp}"

# ----------------------------------------------------------------------------
# Logging + command helpers
# ----------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}→${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1"; }

# run_cmd: execute (or, under --dry-run, echo) a command. Do NOT pass secrets.
run_cmd() {
  if $DRY_RUN; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Stand up the serverless-harness stack on OpenShift (4.20+): OpenShift Serverless
(Knative + Kourier), Redis, the sandbox pod, the leaf-work PVC, the LLM secret,
and the harness Knative Service — reachable over its auto-created Route.

Options:
  --namespace <ns>        Target namespace (default: ${NAMESPACE})
  --image <ref>           Harness image (default: ${HARNESS_IMAGE})
  --sandbox-image <ref>   Use an existing sandbox image instead of building one
                          in-cluster (implies --skip-sandbox-build)
  --skip-sandbox-build    Do not build the sandbox image (image must already exist)
  --serverless-channel <c> OpenShift Serverless subscription channel (default: ${SERVERLESS_CHANNEL})
  --with-keda             Install KEDA (Red Hat Custom Metrics Autoscaler Operator)
                          for the async-leaf ScaledJob path (default: off)
  --keda-channel <c>      Custom Metrics Autoscaler channel (default: ${KEDA_CHANNEL})
  --skip-keda             Skip KEDA (default; accepted for forward-compatibility)
  --dry-run               Print the commands that would run, without executing
  -h, --help              Show this help

Environment:
  ANTHROPIC_API_KEY       Direct Anthropic key, OR
  ANTHROPIC_AUTH_TOKEN    Gateway token (+ ANTHROPIC_BASE_URL for the gateway URL)
  LOG_DIR                 Where build logs are written (default: ${LOG_DIR})

Examples:
  $0                                   # default namespace, GHCR image, build sandbox
  $0 --namespace serverless-harness    # dedicated namespace
  $0 --image ghcr.io/kagenti/serverless-harness:v1.2.3 --dry-run
EOF
}

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)         NAMESPACE="$2"; shift 2 ;;
    --image)             HARNESS_IMAGE="$2"; shift 2 ;;
    --sandbox-image)     SANDBOX_IMAGE="$2"; SKIP_SANDBOX_BUILD=true; shift 2 ;;
    --skip-sandbox-build) SKIP_SANDBOX_BUILD=true; shift ;;
    --serverless-channel) SERVERLESS_CHANNEL="$2"; shift 2 ;;
    --with-keda)         SKIP_KEDA=false; shift ;;
    --keda-channel)      KEDA_CHANNEL="$2"; shift 2 ;;
    --skip-keda)         SKIP_KEDA=true; shift ;;
    --dry-run)           DRY_RUN=true; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) log_error "Unknown option: $1"; echo; usage; exit 1 ;;
  esac
done

# Default sandbox image = the in-cluster internal-registry pullspec for this namespace.
if [ -z "$SANDBOX_IMAGE" ]; then
  SANDBOX_IMAGE="image-registry.openshift-image-registry.svc:5000/${NAMESPACE}/serverless-harness-sandbox:latest"
fi

mkdir -p "$LOG_DIR"

# ----------------------------------------------------------------------------
# Tool detection + cluster preflight
# ----------------------------------------------------------------------------
if command -v oc &>/dev/null; then
  KUBECTL=oc
elif command -v kubectl &>/dev/null; then
  KUBECTL=kubectl
  log_warn "oc not found; falling back to kubectl (operator installs + Routes work best with oc)"
else
  log_error "Neither oc nor kubectl found in PATH"; exit 1
fi

if ! $KUBECTL cluster-info &>/dev/null; then
  log_error "Cannot reach a cluster. Run 'oc login' first."; exit 1
fi
log_success "Connected to cluster ($KUBECTL)"

if ! $KUBECTL auth can-i create subscriptions.operators.coreos.com -A &>/dev/null; then
  log_warn "You may not be cluster-admin — operator installs and SCC assignment need it."
fi

# Cluster (apps) domain — used to construct/report the Route URL.
BASE_DOMAIN="$($KUBECTL get dns cluster -o jsonpath='{.spec.baseDomain}' 2>/dev/null || echo "")"
if [ -n "$BASE_DOMAIN" ]; then
  DOMAIN="apps.${BASE_DOMAIN}"
  log_success "Cluster apps domain: $DOMAIN"
else
  log_warn "Could not auto-detect cluster domain (dns/cluster). Route URL will be read from status."
  DOMAIN=""
fi

# StorageClass preflight — the leaf-work PVC needs a (default) StorageClass to bind.
DEFAULT_SC="$($KUBECTL get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{end}' 2>/dev/null || echo "")"
if [ -n "$DEFAULT_SC" ]; then
  log_success "Default StorageClass: $DEFAULT_SC (leaf-work PVC uses ReadWriteOnce; see SMOKE.md for the RWX caveat)"
elif [ "$($KUBECTL get storageclass --no-headers 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
  log_warn "No default StorageClass; leaf-work PVC may stay Pending unless one is set."
else
  log_error "No StorageClass found — the leaf-work PVC cannot bind. Install a storage provisioner first."
  $DRY_RUN || exit 1
fi

echo
log_info "Target: namespace=$NAMESPACE  harness=$HARNESS_IMAGE"
log_info "        sandbox=$SANDBOX_IMAGE  build-sandbox=$([ "$SKIP_SANDBOX_BUILD" = true ] && echo no || echo yes)"

# ----------------------------------------------------------------------------
# Namespace
# ----------------------------------------------------------------------------
if [ "$NAMESPACE" != "default" ] && ! $KUBECTL get namespace "$NAMESPACE" &>/dev/null; then
  log_info "Creating namespace $NAMESPACE"
  run_cmd $KUBECTL create namespace "$NAMESPACE"
fi

# ----------------------------------------------------------------------------
# Helper: wait for a CRD to appear (operator readiness signal)
# ----------------------------------------------------------------------------
wait_for_crd() {
  local crd="$1" timeout="${2:-300}" waited=0
  if $DRY_RUN; then echo "  [dry-run] wait for CRD $crd"; return 0; fi
  log_info "Waiting for CRD $crd ..."
  while ! $KUBECTL get crd "$crd" &>/dev/null; do
    waited=$((waited + 5))
    [ "$waited" -ge "$timeout" ] && { log_error "CRD $crd not found after ${timeout}s"; return 1; }
    sleep 5
  done
  $KUBECTL wait --for=condition=Established "crd/$crd" --timeout=60s >/dev/null 2>&1 || true
  log_success "CRD $crd available"
}

# apply_stdin: pipe a manifest (stdin) to apply, or echo it under --dry-run.
apply_stdin() {
  if $DRY_RUN; then
    echo "  [dry-run] $KUBECTL apply -f - <<'EOF'"; sed 's/^/    /'; echo "  EOF"
  else
    $KUBECTL apply -f -
  fi
}

# ============================================================================
# 1. OpenShift Serverless Operator (Knative Serving + Kourier)
# ============================================================================
echo
if $KUBECTL get knativeserving knative-serving -n knative-serving &>/dev/null; then
  log_success "KnativeServing already present — skipping operator install"
else
  log_info "Installing OpenShift Serverless Operator (channel: $SERVERLESS_CHANNEL)"
  apply_stdin <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: openshift-serverless
EOF
  apply_stdin <<EOF
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: serverless-operators
  namespace: openshift-serverless
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: serverless-operator
  namespace: openshift-serverless
spec:
  channel: ${SERVERLESS_CHANNEL}
  name: serverless-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
  installPlanApproval: Automatic
EOF
  wait_for_crd knativeservings.operator.knative.dev 300
fi

# KnativeServing CR — feature flags + autoscaler tuning live here (the operator
# reverts direct config-* ConfigMap patches).
log_info "Applying KnativeServing CR (feature flags + autoscaler tuning)"
apply_stdin <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: knative-serving
EOF
apply_stdin <<'EOF'
apiVersion: operator.knative.dev/v1beta1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: knative-serving
spec:
  config:
    features:
      kubernetes.podspec-persistent-volume-claim: enabled
      kubernetes.podspec-persistent-volume-write: enabled
      kubernetes.podspec-securitycontext: enabled
    autoscaler:
      stable-window: "20s"
      scale-to-zero-grace-period: "10s"
      container-concurrency-target-percentage: "100"
EOF
if ! $DRY_RUN; then
  log_info "Waiting for KnativeServing to be Ready (up to 5m)..."
  $KUBECTL wait --for=condition=Ready knativeserving/knative-serving -n knative-serving --timeout=300s \
    >"$LOG_DIR/knativeserving-wait.log" 2>&1 \
    && log_success "KnativeServing Ready" \
    || { log_error "KnativeServing not Ready (see $LOG_DIR/knativeserving-wait.log)"; exit 1; }
fi

# ============================================================================
# 2. KEDA — Red Hat Custom Metrics Autoscaler Operator (opt-in, async-leaf path)
# ============================================================================
echo
if [ "$SKIP_KEDA" = true ]; then
  log_info "Skipping KEDA (enable the async-leaf ScaledJob path with --with-keda)"
else
  if $KUBECTL get kedacontroller keda -n openshift-keda &>/dev/null; then
    log_success "KedaController already present — skipping CMA operator install"
  else
    log_info "Installing Custom Metrics Autoscaler Operator / KEDA (channel: $KEDA_CHANNEL)"
    apply_stdin <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: openshift-keda
EOF
    apply_stdin <<EOF
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: openshift-keda
  namespace: openshift-keda
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: openshift-custom-metrics-autoscaler-operator
  namespace: openshift-keda
spec:
  channel: ${KEDA_CHANNEL}
  name: openshift-custom-metrics-autoscaler-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
  installPlanApproval: Automatic
EOF
    wait_for_crd kedacontrollers.keda.sh 300
  fi
  # KedaController CR activates the KEDA operands (operator/metrics-server).
  log_info "Applying KedaController CR"
  apply_stdin <<'EOF'
apiVersion: keda.sh/v1alpha1
kind: KedaController
metadata:
  name: keda
  namespace: openshift-keda
spec:
  watchNamespace: ''
EOF
  wait_for_crd scaledjobs.keda.sh 300
  if ! $DRY_RUN; then
    $KUBECTL wait --for=condition=Available deployment --all -n openshift-keda --timeout=180s \
      >"$LOG_DIR/keda-wait.log" 2>&1 \
      && log_success "KEDA ready" \
      || log_warn "KEDA deployments not all Available yet (see $LOG_DIR/keda-wait.log)"
  fi
fi

# ============================================================================
# 3. Sandbox image — pre-baked, built in-cluster against the internal registry
# ============================================================================
echo
if [ "$SKIP_SANDBOX_BUILD" = true ]; then
  log_info "Skipping sandbox build; using $SANDBOX_IMAGE"
else
  log_info "Building sandbox image in-cluster → $SANDBOX_IMAGE"
  if ! $KUBECTL get buildconfig serverless-harness-sandbox -n "$NAMESPACE" &>/dev/null; then
    run_cmd $KUBECTL -n "$NAMESPACE" new-build --name serverless-harness-sandbox \
      --binary --strategy=docker
  fi
  if $DRY_RUN; then
    echo "  [dry-run] oc start-build serverless-harness-sandbox --from-dir <staged Dockerfile> --follow"
  else
    BUILD_CTX="$(mktemp -d)"
    cp "$SCRIPT_DIR/sandbox.Dockerfile" "$BUILD_CTX/Dockerfile"
    if $KUBECTL -n "$NAMESPACE" start-build serverless-harness-sandbox \
         --from-dir="$BUILD_CTX" --follow >"$LOG_DIR/sandbox-build.log" 2>&1; then
      log_success "Sandbox image built (log: $LOG_DIR/sandbox-build.log)"
    else
      log_error "Sandbox build failed — see $LOG_DIR/sandbox-build.log"; rm -rf "$BUILD_CTX"; exit 1
    fi
    rm -rf "$BUILD_CTX"
  fi
fi

# ============================================================================
# 4. LLM credentials secret
# ============================================================================
echo
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  log_error "Set ANTHROPIC_API_KEY (direct) or ANTHROPIC_AUTH_TOKEN [+ ANTHROPIC_BASE_URL] (gateway)"
  exit 1
fi
create_secret() {
  local args=(--from-literal=api-key="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}")
  [ -n "${ANTHROPIC_BASE_URL:-}" ]   && args+=(--from-literal=base-url="$ANTHROPIC_BASE_URL")
  [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && args+=(--from-literal=auth-token="$ANTHROPIC_AUTH_TOKEN")
  $KUBECTL create secret generic llm-credentials -n "$NAMESPACE" "${args[@]}" \
    --dry-run=client -o yaml | $KUBECTL apply -f -
}
if $DRY_RUN; then
  log_info "[dry-run] would create/update secret llm-credentials in $NAMESPACE (values redacted)"
else
  create_secret >/dev/null
  log_success "Secret llm-credentials ready"
fi

# ============================================================================
# 5. Grant the harness ServiceAccount an SCC that permits its non-root UID.
# ============================================================================
# The published harness image declares no USER, so it defaults to root. We run it
# as an explicit non-root UID (65532, from the base manifest) rather than relying
# on the SCC to inject one — restricted-v2 does not reliably do so here. `nonroot-v2`
# (like restricted-v2, but RunAsUser=MustRunAsNonRoot) admits that explicit non-root
# UID. Granting by SA name is idempotent and works before the SA exists.
# (issue #41 item #4, approach b.)
echo
log_info "Granting nonroot-v2 SCC to serviceaccount/serverless-harness in $NAMESPACE"
if [ "$KUBECTL" = "oc" ]; then
  run_cmd oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness -n "$NAMESPACE"
else
  log_warn "kubectl in use — cannot grant SCC; run: oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness -n $NAMESPACE"
fi

# ============================================================================
# 6. Apply the data-plane overlay (Redis, sandbox, PVC, harness Service, RBAC)
# ============================================================================
echo
log_info "Rendering + applying OCP overlay"
# oc apply -k cannot relax the kustomize load-restrictor, and the overlay
# references the shared base YAMLs one level up, so render with `oc kustomize`
# (--load-restrictor LoadRestrictionsNone) and post-process image/namespace
# overrides before applying.
render_overlay() {
  $KUBECTL kustomize --load-restrictor LoadRestrictionsNone "$OVERLAY_DIR" \
    | sed \
        -e "s#ghcr.io/kagenti/serverless-harness:latest#${HARNESS_IMAGE}#g" \
        -e "s#image-registry.openshift-image-registry.svc:5000/default/serverless-harness-sandbox:latest#${SANDBOX_IMAGE}#g" \
    | if [ "$NAMESPACE" != "default" ]; then
        sed -e "s#namespace: default#namespace: ${NAMESPACE}#g" \
            -e "s#redis.default.svc#redis.${NAMESPACE}.svc#g"
      else cat; fi
}
if $DRY_RUN; then
  echo "  [dry-run] render_overlay | $KUBECTL apply -f -   (manifest preview:)"
  render_overlay | sed 's/^/    /'
else
  render_overlay | $KUBECTL apply -f - >"$LOG_DIR/overlay-apply.log" 2>&1 \
    && log_success "Overlay applied (log: $LOG_DIR/overlay-apply.log)" \
    || { log_error "Overlay apply failed — see $LOG_DIR/overlay-apply.log"; cat "$LOG_DIR/overlay-apply.log"; exit 1; }
fi

# ============================================================================
# 7. Wait for the harness Knative Service + report the Route URL
# ============================================================================
echo
if ! $DRY_RUN; then
  log_info "Waiting for ksvc/serverless-harness to be Ready (up to 5m)..."
  $KUBECTL wait ksvc/serverless-harness -n "$NAMESPACE" --for=condition=Ready --timeout=300s \
    >"$LOG_DIR/ksvc-wait.log" 2>&1 \
    && log_success "ksvc/serverless-harness Ready" \
    || { log_error "ksvc not Ready (see $LOG_DIR/ksvc-wait.log)"; exit 1; }
fi

URL="$($KUBECTL get ksvc serverless-harness -n "$NAMESPACE" -o jsonpath='{.status.url}' 2>/dev/null || echo "")"
if [ -z "$URL" ] && [ -n "$DOMAIN" ]; then
  URL="https://serverless-harness-${NAMESPACE}.${DOMAIN}"
fi

echo
echo "=== Setup complete ==="
echo
if [ -n "$URL" ]; then
  echo "Harness Route URL:"
  echo "  $URL"
  echo
  echo "Smoke test:"
  echo "  curl -sk -H 'Content-Type: application/json' \\"
  echo "       -d '{\"prompt\": \"Hello\"}' \\"
  echo "       $URL/turn"
  echo
  echo "  curl -sk -X POST $URL/runs -H 'Content-Type: application/json' -d '{...leaf config...}'"
else
  echo "Route URL not yet available; check: $KUBECTL get ksvc serverless-harness -n $NAMESPACE"
fi
echo
