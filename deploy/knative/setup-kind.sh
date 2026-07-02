#!/usr/bin/env bash
# deploy/knative/setup-kind.sh
# One-shot setup: installs Knative Serving on Kind, deploys Redis + sandbox + harness.
#
# Prerequisites:
#   - kind cluster running (e.g., `kind create cluster --name sh-knative`)
#   - kubectl configured to the kind cluster
#   - docker available (for image build + kind load)
#   - ANTHROPIC_API_KEY env var set
#
# Usage:
#   ./deploy/knative/setup-kind.sh [--skip-build] [--cluster-name <name>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-sh-knative}"
SKIP_BUILD="${SKIP_BUILD:-false}"
KNATIVE_VERSION="${KNATIVE_VERSION:-v1.14.0}"

# Parse args
for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --cluster-name) shift; CLUSTER_NAME="$1" ;;
    --cluster-name=*) CLUSTER_NAME="${arg#*=}" ;;
  esac
  shift 2>/dev/null || true
done

echo "=== M4 Knative Setup (cluster: $CLUSTER_NAME) ==="

# 1. Create kind cluster if it doesn't exist
if ! kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "--- Creating kind cluster: $CLUSTER_NAME ---"
  kind create cluster --name "$CLUSTER_NAME"
fi
kubectl config use-context "kind-${CLUSTER_NAME}"

# 2. Install Knative Serving
echo "--- Installing Knative Serving $KNATIVE_VERSION ---"
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-crds.yaml"
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-core.yaml"

# 3. Install Kourier (networking layer)
echo "--- Installing Kourier ---"
kubectl apply -f "https://github.com/knative-extensions/net-kourier/releases/download/knative-${KNATIVE_VERSION}/kourier.yaml"

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Configure external domain
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"example.com":""}}'

# Tune autoscaler for faster scale-to-zero and single-pod-per-request (dev/testing)
kubectl patch configmap/config-autoscaler \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"stable-window":"20s","scale-to-zero-grace-period":"10s","container-concurrency-target-percentage":"100"}}'

# Skip tag resolution for local images
kubectl patch configmap/config-deployment \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"registries-skipping-tag-resolving":"kind.local,ko.local,dev.local"}}'

# Enable persistent-volume-claim support (read + write) so the leaf-session contract can
# mount the shared leaf-work PVC into the harness service (deploy/knative/leaf-pvc.yaml).
# The validating webhook rejects a writable PVC mount unless both flags are enabled.
# Also enable kubernetes.podspec-securitycontext so the harness pods can use pod-level
# and container-level securityContext fields (runAsNonRoot, fsGroup, etc.).
kubectl patch configmap/config-features \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"kubernetes.podspec-persistent-volume-claim":"enabled","kubernetes.podspec-persistent-volume-write":"enabled","kubernetes.podspec-securitycontext":"enabled"}}'

# Install KEDA (event-driven autoscaling) — async leaf completion uses a KEDA ScaledJob.
KEDA_VERSION="${KEDA_VERSION:-v2.14.0}"
if ! kubectl get crd scaledjobs.keda.sh >/dev/null 2>&1; then
  echo "--- Installing KEDA $KEDA_VERSION ---"
  # The release asset filename drops the leading "v" (tag v2.14.0 → asset keda-2.14.0.yaml).
  kubectl apply --server-side -f "https://github.com/kedacore/keda/releases/download/${KEDA_VERSION}/keda-${KEDA_VERSION#v}.yaml"
fi
kubectl wait --for=condition=Available deployment --all -n keda --timeout=180s || true

# Wait for Knative components
echo "--- Waiting for Knative Serving to be ready ---"
kubectl wait --for=condition=Available deployment --all -n knative-serving --timeout=120s

# 4. Deploy Redis
echo "--- Deploying Redis ---"
kubectl apply -f "$SCRIPT_DIR/redis.yaml"
kubectl wait --for=condition=Available deployment/redis -n default --timeout=60s

# 5. Install agent-sandbox controller + CRDs (kubernetes-sigs/agent-sandbox v0.5.0)
echo "--- Installing agent-sandbox controller ---"
kubectl apply --server-side -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.0/manifest.yaml"
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s
kubectl wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=120s

# 6. Deploy durable Sandbox CR
echo "--- Deploying Sandbox CR ---"
kubectl apply -f "$SCRIPT_DIR/sandbox.yaml"
# Wait for the Sandbox controller to publish .status.selector, then wait for the pod
SEL=""
for i in $(seq 1 60); do
  SEL=$(kubectl -n default get sandbox sandbox-0 -o jsonpath='{.status.selector}' 2>/dev/null || true)
  [ -n "$SEL" ] && break
  sleep 2
done
[ -n "$SEL" ] && kubectl -n default wait --for=condition=Ready pod -l "$SEL" --timeout=180s || {
  echo "sandbox pod not ready (selector='$SEL')"
  kubectl -n default get sandbox sandbox-0 -o yaml | head -40
  exit 1
}

# 7. Build and load harness image
if [ "$SKIP_BUILD" != "true" ]; then
  echo "--- Building serverless-harness image ---"
  docker build --load -t dev.local/serverless-harness:local "$REPO_ROOT"
  echo "--- Loading image into kind ---"
  kind load docker-image dev.local/serverless-harness:local --name "$CLUSTER_NAME"
fi

# 8. Create LLM credentials secret (supports direct API key or gateway bridge)
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "ERROR: Set ANTHROPIC_API_KEY (direct) or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL (gateway)"
  exit 1
fi
SECRET_ARGS=(--from-literal=api-key="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN}}")
[ -n "${ANTHROPIC_BASE_URL:-}" ] && SECRET_ARGS+=(--from-literal=base-url="$ANTHROPIC_BASE_URL")
[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && SECRET_ARGS+=(--from-literal=auth-token="$ANTHROPIC_AUTH_TOKEN")
kubectl create secret generic llm-credentials "${SECRET_ARGS[@]}" \
  --dry-run=client -o yaml | kubectl apply -f -

# 9. Deploy Knative Service
echo "--- Deploying serverless-harness Knative Service ---"
kubectl apply -f "$SCRIPT_DIR/service.yaml"

# The image tag (dev.local/serverless-harness:local) is mutable, so re-applying an unchanged
# service spec does NOT roll a new Revision — Knative would keep serving the previous Revision
# (pinned to the OLD image digest) and a freshly built image would never be deployed. Force a new
# Revision by stamping a build marker into the template so the rebuilt image is always picked up.
if [ "$SKIP_BUILD" != "true" ]; then
  kubectl -n default patch ksvc serverless-harness --type merge \
    -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"deploy.sh/build-ts\":\"$(date +%s)\"}}}}}"
fi

# 10. Wait for service to become ready
echo "--- Waiting for Knative Service to be ready ---"
kubectl wait ksvc/serverless-harness --for=condition=Ready --timeout=120s

# 11. Print access info
KOURIER_IP=$(kubectl get svc kourier -n kourier-system -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "pending")
echo ""
echo "=== Setup complete ==="
echo ""
echo "Knative Service URL (in-cluster):"
echo "  http://serverless-harness.default.svc.cluster.local"
echo ""
echo "Kourier ClusterIP: $KOURIER_IP"
echo ""
echo "To access from host, run in a separate terminal:"
echo "  kubectl port-forward -n kourier-system svc/kourier 8080:80"
echo ""
echo "Then send requests with the Host header:"
echo "  curl -H 'Host: serverless-harness.default.example.com' \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"prompt\": \"Hello\"}' \\"
echo "       http://localhost:8080/turn"
echo ""
