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
KNATIVE_VERSION="v1.14.1"

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
kubectl apply -f "https://github.com/knative/net-kourier/releases/download/knative-${KNATIVE_VERSION}/kourier.yaml"

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Wait for Knative components
echo "--- Waiting for Knative Serving to be ready ---"
kubectl wait --for=condition=Available deployment --all -n knative-serving --timeout=120s

# 4. Deploy Redis
echo "--- Deploying Redis ---"
kubectl apply -f "$SCRIPT_DIR/redis.yaml"
kubectl wait --for=condition=Available deployment/redis -n default --timeout=60s

# 5. Deploy sandbox pod
echo "--- Deploying sandbox pod ---"
kubectl apply -f "$SCRIPT_DIR/sandbox.yaml"
kubectl wait --for=condition=Ready pod/sandbox-0 -n default --timeout=60s

# 6. Build and load harness image
if [ "$SKIP_BUILD" != "true" ]; then
  echo "--- Building serverless-harness image ---"
  docker build -t serverless-harness:local "$REPO_ROOT"
  echo "--- Loading image into kind ---"
  kind load docker-image serverless-harness:local --name "$CLUSTER_NAME"
fi

# 7. Create LLM credentials secret
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY must be set"
  exit 1
fi
kubectl create secret generic llm-credentials \
  --from-literal=api-key="$ANTHROPIC_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# 8. Deploy Knative Service
echo "--- Deploying serverless-harness Knative Service ---"
kubectl apply -f "$SCRIPT_DIR/service.yaml"

# 9. Wait for service to become ready
echo "--- Waiting for Knative Service to be ready ---"
kubectl wait ksvc/serverless-harness --for=condition=Ready --timeout=120s

# 10. Print access info
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
