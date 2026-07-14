#!/usr/bin/env bash
# deploy/knative/setup-ocp.sh
# One-shot setup of the serverless-harness stack on OpenShift (4.20+).
#
# Sibling of setup-kind.sh, but OpenShift-native (see issue #41):
#   - Knative Serving (+ Kourier) via the Red Hat OpenShift Serverless Operator
#     (OLM Subscription + KnativeServing CR) — not raw upstream manifests.
#   - Autoscaler tuning + PVC/securityContext feature flags set in the
#     KnativeServing CR spec (the operator reverts direct ConfigMap patches).
#   - Redis, sandbox, LLM secret and the harness Knative Service
#     via the deploy/knative/overlays/ocp kustomize overlay.
#   - Sandbox image pulled pre-baked from GHCR (built by build.yaml, symmetric with
#     the harness image; the Kind `apk add`-as-root pod is blocked by the
#     restricted-v2 SCC, so tools are baked in at build time — see sandbox.Dockerfile).
#   - Ingress via the auto-created OpenShift Route (no Kourier port-forward).
#
# Base bring-up: KEDA (async leaf) is opt-in via --with-keda; the optional Redis
# Enterprise Operator is a follow-up — see --help and issue #41.
#
# Prerequisites:
#   - `oc login` to an OpenShift 4.20+ cluster as cluster-admin.
#   - ANTHROPIC_API_KEY (direct) or ANTHROPIC_AUTH_TOKEN [+ ANTHROPIC_BASE_URL] (gateway).
#
# SH_AUTHBRIDGE=1 (env, off by default): deploys the RC1 AuthBridge two-hop egress-control
# path (AB1 LLM gateway + AB2 sandbox forward-proxy) via the ocp-authbridge overlay.
#
# Usage: ./deploy/knative/setup-ocp.sh [OPTIONS]   (see --help)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLAY_DIR="$SCRIPT_DIR/overlays/ocp"
AB_OVERLAY_DIR="$SCRIPT_DIR/overlays/ocp-authbridge"  # only rendered/applied when SH_AUTHBRIDGE=1

# ----------------------------------------------------------------------------
# Defaults (all overridable via flags)
# ----------------------------------------------------------------------------
DRY_RUN=false
NAMESPACE="default"
HARNESS_IMAGE="ghcr.io/kagenti/serverless-harness:latest"
SANDBOX_IMAGE="ghcr.io/kagenti/serverless-harness-sandbox:latest"  # pre-baked, pulled from GHCR
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
(Knative + Kourier), Redis, the sandbox pod, the LLM secret,
and the harness Knative Service — reachable over its auto-created Route.

Options:
  --namespace <ns>        Target namespace (default: ${NAMESPACE})
  --image <ref>           Harness image (default: ${HARNESS_IMAGE})
  --sandbox-image <ref>   Sandbox image to pull (default: ${SANDBOX_IMAGE})
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
  SH_AUTHBRIDGE           1 to deploy the RC1 AuthBridge two-hop path (default: off)

Examples:
  $0                                   # default namespace, GHCR harness + sandbox images
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
    --sandbox-image)     SANDBOX_IMAGE="$2"; shift 2 ;;
    --serverless-channel) SERVERLESS_CHANNEL="$2"; shift 2 ;;
    --with-keda)         SKIP_KEDA=false; shift ;;
    --keda-channel)      KEDA_CHANNEL="$2"; shift 2 ;;
    --skip-keda)         SKIP_KEDA=true; shift ;;
    --dry-run)           DRY_RUN=true; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) log_error "Unknown option: $1"; echo; usage; exit 1 ;;
  esac
done

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

# StorageClass preflight — the sandbox's durable /workspace PVC (Sandbox CR
# volumeClaimTemplates, ReadWriteOnce) needs a (default) StorageClass to bind.
DEFAULT_SC="$($KUBECTL get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{end}' 2>/dev/null || echo "")"
if [ -n "$DEFAULT_SC" ]; then
  log_success "Default StorageClass: $DEFAULT_SC (sandbox /workspace PVC is ReadWriteOnce)"
elif [ "$($KUBECTL get storageclass --no-headers 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
  log_warn "No default StorageClass; the sandbox /workspace PVC may stay Pending unless one is set."
else
  log_error "No StorageClass found — the sandbox /workspace PVC cannot bind. Install a storage provisioner first."
  $DRY_RUN || exit 1
fi

echo
log_info "Target: namespace=$NAMESPACE  harness=$HARNESS_IMAGE"
log_info "        sandbox=$SANDBOX_IMAGE"

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
# 3. LLM credentials secret
# ============================================================================
echo
if [ "${SH_AUTHBRIDGE:-0}" = "1" ]; then
  # RC1 Hop 1 (mirrors setup-kind.sh): the harness never holds the real key. AB1 (the
  # reverse-proxy gateway applied in Section 6c below) holds it and injects it per-request;
  # the harness gets only the placeholder + AB1's in-cluster base URL.
  REAL_KEY="${ANTHROPIC_API_KEY:?SH_AUTHBRIDGE=1 requires ANTHROPIC_API_KEY (the real key AB1 injects)}"
  if $DRY_RUN; then
    log_info "[dry-run] would create/update secret ab1-llm-cred in $NAMESPACE (value redacted)"
    log_info "[dry-run] would repoint secret llm-credentials in $NAMESPACE to AB1 placeholders"
  else
    $KUBECTL create secret generic ab1-llm-cred -n "$NAMESPACE" \
      --from-literal=api.anthropic.com="$REAL_KEY" \
      --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
    $KUBECTL create secret generic llm-credentials -n "$NAMESPACE" \
      --from-literal=api-key=AB1-PLACEHOLDER \
      --from-literal=auth-token=AB1-PLACEHOLDER \
      --from-literal=base-url=http://authbridge-ab1:8080 \
      --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
    log_success "Secrets ab1-llm-cred + llm-credentials (AB1 placeholders) ready in $NAMESPACE"
  fi
else
  create_secret() {
    local args=(--from-literal=api-key="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}")
    [ -n "${ANTHROPIC_BASE_URL:-}" ]   && args+=(--from-literal=base-url="$ANTHROPIC_BASE_URL")
    [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && args+=(--from-literal=auth-token="$ANTHROPIC_AUTH_TOKEN")
    $KUBECTL create secret generic llm-credentials -n "$NAMESPACE" "${args[@]}" \
      --dry-run=client -o yaml | $KUBECTL apply -f -
  }
  if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    if $DRY_RUN; then
      log_info "[dry-run] would create/update secret llm-credentials in $NAMESPACE (values redacted)"
    else
      create_secret >/dev/null
      log_success "Secret llm-credentials ready (from environment)"
    fi
  elif $KUBECTL get secret llm-credentials -n "$NAMESPACE" &>/dev/null; then
    log_success "Secret llm-credentials already present in $NAMESPACE — using it"
  else
    log_error "No ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in env and no llm-credentials secret in $NAMESPACE."
    log_error "Provide one, or pre-create: oc create secret generic llm-credentials -n $NAMESPACE --from-literal=api-key=..."
    $DRY_RUN || exit 1
  fi
fi

# ============================================================================
# 4. Grant the harness ServiceAccount an SCC that permits its non-root UID.
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
log_info "Ensuring sandbox ServiceAccount + nonroot-v2 SCC (serverless-harness-sandbox) in $NAMESPACE"
$KUBECTL create serviceaccount serverless-harness-sandbox -n "$NAMESPACE" \
  --dry-run=client -o yaml | apply_stdin >/dev/null
if [ "$KUBECTL" = "oc" ]; then
  run_cmd oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness-sandbox -n "$NAMESPACE"
else
  log_warn "kubectl in use — cannot grant SCC; run: oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness-sandbox -n $NAMESPACE"
fi

# ============================================================================
# 5. agent-sandbox controller (Sandbox CRD) — kubernetes-sigs v0.5.0
# ============================================================================
# The harness resolves + execs into the sandbox pod; the pod is created by this
# controller from the Sandbox CR (applied via the overlay below). Mirrors
# setup-kind.sh step 5.
echo
if $KUBECTL get crd sandboxes.agents.x-k8s.io &>/dev/null; then
  log_success "agent-sandbox CRD already present — skipping controller install"
else
  log_info "Installing agent-sandbox controller (kubernetes-sigs v0.5.0)"
  run_cmd $KUBECTL apply --server-side -f \
    "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.0/manifest.yaml"
  wait_for_crd sandboxes.agents.x-k8s.io 180
fi
if ! $DRY_RUN; then
  $KUBECTL -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s \
    >"$LOG_DIR/agent-sandbox-rollout.log" 2>&1 \
    && log_success "agent-sandbox controller ready" \
    || log_warn "agent-sandbox controller not ready yet (see $LOG_DIR/agent-sandbox-rollout.log)"
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
# render_overlay_dir <dir>: kustomize-render an overlay dir with the same image/namespace
# post-processing used for the base overlay. Parameterized so the AB overlay (Section 6c)
# can reuse it without duplicating the sed pipeline.
render_overlay_dir() {
  local dir="$1"
  $KUBECTL kustomize --load-restrictor LoadRestrictionsNone "$dir" \
    | sed \
        -e "s#ghcr.io/kagenti/serverless-harness:latest#${HARNESS_IMAGE}#g" \
        -e "s#ghcr.io/kagenti/serverless-harness-sandbox:latest#${SANDBOX_IMAGE}#g" \
    | if [ "$NAMESPACE" != "default" ]; then
        sed -e "s#namespace: default#namespace: ${NAMESPACE}#g" \
            -e "s#redis.default.svc#redis.${NAMESPACE}.svc#g"
      else cat; fi
}
render_overlay() { render_overlay_dir "$OVERLAY_DIR"; }
if $DRY_RUN; then
  echo "  [dry-run] render_overlay | $KUBECTL apply -f -   (manifest preview:)"
  render_overlay | sed 's/^/    /'
else
  render_overlay | $KUBECTL apply -f - >"$LOG_DIR/overlay-apply.log" 2>&1 \
    && log_success "Overlay applied (log: $LOG_DIR/overlay-apply.log)" \
    || { log_error "Overlay apply failed — see $LOG_DIR/overlay-apply.log"; cat "$LOG_DIR/overlay-apply.log"; exit 1; }
fi

# ============================================================================
# 6b. Wait for the Sandbox pod (controller publishes .status.selector first)
# ============================================================================
echo
if ! $DRY_RUN; then
  log_info "Waiting for Sandbox sandbox-0 .status.selector, then pod Ready (up to ~2m)..."
  SEL=""
  for _ in $(seq 1 60); do
    SEL="$($KUBECTL -n "$NAMESPACE" get sandbox sandbox-0 -o jsonpath='{.status.selector}' 2>/dev/null || true)"
    [ -n "$SEL" ] && break
    sleep 2
  done
  if [ -n "$SEL" ]; then
    $KUBECTL -n "$NAMESPACE" wait --for=condition=Ready pod -l "$SEL" --timeout=180s \
      >"$LOG_DIR/sandbox-wait.log" 2>&1 \
      && log_success "Sandbox pod Ready" \
      || { log_error "Sandbox pod not Ready (see $LOG_DIR/sandbox-wait.log)"; \
           $KUBECTL -n "$NAMESPACE" get pod sandbox-0 -o wide 2>/dev/null || true; exit 1; }
  else
    log_error "Sandbox sandbox-0 never published .status.selector — is the controller running?"
    exit 1
  fi
fi

# ============================================================================
# 6c. SH_AUTHBRIDGE=1: deploy the RC1 AuthBridge two-hop stack (AB1 gateway + AB2 egress)
# ============================================================================
# Mirrors setup-kind.sh steps 8b/8c, adapted for OCP: no docker build / kind load — the
# ocp-authbridge overlay (Task A) is already image-remapped to the published GHCR images
# and carries the SCC/nonroot patches the ibac-stub/AB1/echo-target/AB2-sandbox workloads
# need under restricted-v2. Off ⇒ none of this runs; the base overlay + pool from
# Sections 6/6b are left as-is.
if [ "${SH_AUTHBRIDGE:-0}" = "1" ]; then
  echo
  log_info "Deploying RC1 AuthBridge stack (ocp-authbridge overlay)"

  # Real egress credential: seeded ONLY into this Secret; the sandbox container only ever
  # holds the placeholder (ECHO_CRED=PLACEHOLDER-TOKEN in sandbox-pool-ab2.yaml). AB2's
  # static-inject plugin resolves the real value by destination host. Synthetic demo value —
  # echo doesn't authenticate.
  RC1_ECHO_REAL_CRED="${RC1_ECHO_REAL_CRED:-REAL-ECHO-EGRESS-CRED-rc1demo}"
  if $DRY_RUN; then
    log_info "[dry-run] would create/update secret ab2-egress-cred in $NAMESPACE (value redacted)"
  else
    $KUBECTL create secret generic ab2-egress-cred -n "$NAMESPACE" \
      --from-literal=echo-target="$RC1_ECHO_REAL_CRED" \
      --dry-run=client -o yaml | $KUBECTL apply -f - >/dev/null
    log_success "Secret ab2-egress-cred ready in $NAMESPACE"
  fi

  log_info "Rendering + applying ocp-authbridge overlay"
  if $DRY_RUN; then
    echo "  [dry-run] render_overlay_dir \"$AB_OVERLAY_DIR\" | $KUBECTL apply -f -   (manifest preview:)"
    render_overlay_dir "$AB_OVERLAY_DIR" | sed 's/^/    /'
  else
    render_overlay_dir "$AB_OVERLAY_DIR" | $KUBECTL apply -f - >"$LOG_DIR/authbridge-overlay-apply.log" 2>&1 \
      && log_success "AuthBridge overlay applied (log: $LOG_DIR/authbridge-overlay-apply.log)" \
      || { log_error "AuthBridge overlay apply failed — see $LOG_DIR/authbridge-overlay-apply.log"; \
           cat "$LOG_DIR/authbridge-overlay-apply.log"; exit 1; }
  fi

  if ! $DRY_RUN; then
    log_info "Waiting for authbridge-ab1 / ibac-stub / echo-target rollouts..."
    $KUBECTL -n "$NAMESPACE" rollout status deploy/authbridge-ab1 --timeout=180s \
      >"$LOG_DIR/authbridge-ab1-rollout.log" 2>&1 \
      && log_success "authbridge-ab1 ready" \
      || { log_error "authbridge-ab1 not ready (see $LOG_DIR/authbridge-ab1-rollout.log)"; exit 1; }
    $KUBECTL -n "$NAMESPACE" rollout status deploy/ibac-stub --timeout=180s \
      >"$LOG_DIR/ibac-stub-rollout.log" 2>&1 \
      && log_success "ibac-stub ready" \
      || { log_error "ibac-stub not ready (see $LOG_DIR/ibac-stub-rollout.log)"; exit 1; }
    $KUBECTL -n "$NAMESPACE" rollout status deploy/echo-target --timeout=180s \
      >"$LOG_DIR/echo-target-rollout.log" 2>&1 \
      && log_success "echo-target ready" \
      || { log_error "echo-target not ready (see $LOG_DIR/echo-target-rollout.log)"; exit 1; }

    # The agent-sandbox controller does NOT roll existing pods when a Sandbox CR's spec
    # changes — a pre-existing pod (e.g. sandbox-0 created by the base pool apply in
    # Section 6) would otherwise keep its OLD 1-container spec (no authbridge-ab2 sidecar)
    # forever. Force-delete the pool pods so the controller recreates them from the
    # just-applied AB2 spec.
    AB_POOL_SELECTOR="sh.kagenti.io/sandbox-pool=default"
    log_info "Force-rolling the sandbox pool onto the AB2-sidecar variant..."
    $KUBECTL -n "$NAMESPACE" delete pod -l "$AB_POOL_SELECTOR" --ignore-not-found \
      >"$LOG_DIR/ab2-pool-delete.log" 2>&1 || true
    # Wait for the OLD pods to be fully gone before readiness-checking the new ones.
    $KUBECTL -n "$NAMESPACE" wait --for=delete pod -l "$AB_POOL_SELECTOR" --timeout=180s \
      >>"$LOG_DIR/ab2-pool-delete.log" 2>&1 || true

    # Poll per-container readiness (2 containers/pod: sandbox + authbridge-ab2) before the
    # authoritative wait, since the old pods must terminate and the new sandbox containers
    # have to pull + start.
    for _ in $(seq 1 150); do
      # `|| true`: under `set -euo pipefail`, `grep -c` exits 1 when the count is 0, and
      # there IS a guaranteed zero-ready window during the rollover.
      ab2_ready=$($KUBECTL -n "$NAMESPACE" get pods -l "$AB_POOL_SELECTOR" \
        -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.ready}{"\n"}{end}{end}' \
        2>/dev/null | grep -c '^true$' || true)
      ab2_want=$(( $($KUBECTL -n "$NAMESPACE" get sandbox -l "$AB_POOL_SELECTOR" --no-headers 2>/dev/null | wc -l | tr -d ' ') * 2 ))
      [ "$ab2_want" -gt 0 ] && [ "$ab2_ready" -ge "$ab2_want" ] && break
      sleep 2
    done
    $KUBECTL -n "$NAMESPACE" wait --for=condition=Ready pod -l "$AB_POOL_SELECTOR" --timeout=300s \
      >"$LOG_DIR/ab2-pool-wait.log" 2>&1 \
      && log_success "AB2 sandbox pool Ready" \
      || { log_error "AB2 sandbox pool not all Ready (see $LOG_DIR/ab2-pool-wait.log)"; \
           $KUBECTL -n "$NAMESPACE" get pods -l "$AB_POOL_SELECTOR" -o wide 2>/dev/null || true; exit 1; }
  fi

  # Roll the harness ksvc so it starts a fresh Revision that picks up the repointed
  # llm-credentials (placeholder + ANTHROPIC_BASE_URL=http://authbridge-ab1:8080, an
  # in-cluster Service that resolves in-cluster — no Route needed for this hop). Mirrors
  # setup-kind.sh's build-ts annotation patch (step 9).
  run_cmd $KUBECTL -n "$NAMESPACE" patch ksvc serverless-harness --type merge \
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"deploy.sh/build-ts\":\"$(date +%s)\"}}}}}"
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
