#!/usr/bin/env bash
# Deploy the remote-worker as an in-cluster pod and verify it registers with the
# relay. This closes the port-forward latency gap: relay->worker execs stay in the
# cluster, so harness leaf execs reach the worker within their deadline.
#
#   ./build-image.sh && ./deploy-incluster.sh
#   NS=default SANDBOX_ID=sbx-worker-1 ./deploy-incluster.sh
#   IMAGE=quay.io/aslomnet/remote-worker:dev ./deploy-incluster.sh   # external image
set -euo pipefail
cd "$(dirname "$0")"

NS="${NS:-default}"
SANDBOX_ID="${SANDBOX_ID:-sbx-worker-1}"
TOKEN="${SANDBOX_TOKEN:-dev-token}"
IMAGE="${IMAGE:-image-registry.openshift-image-registry.svc:5000/$NS/remote-worker:latest}"

echo "==> ensure relay token (fail-closed auth)"
oc set env deploy/sandbox-relay "SH_RELAY_TOKEN=$TOKEN" -n "$NS" >/dev/null

echo "==> ServiceAccount + nonroot-v2 SCC (image declares no USER; runs as UID 65532)"
oc create serviceaccount remote-worker -n "$NS" --dry-run=client -o yaml | oc apply -f - >/dev/null
oc adm policy add-scc-to-user nonroot-v2 -z remote-worker -n "$NS" >/dev/null

echo "==> apply Deployment (image=$IMAGE sandbox_id=$SANDBOX_ID)"
sed -e "s#__IMAGE__#${IMAGE}#g" -e "s#__SANDBOX_ID__#${SANDBOX_ID}#g" \
    -e "s#__TOKEN__#${TOKEN}#g" -e "s#__NS__#${NS}#g" \
    worker-deployment.yaml | oc apply -f - >/dev/null

oc rollout status deploy/remote-worker -n "$NS" --timeout=120s

echo "==> presence in Redis (worker registered via its live Attach stream)"
for i in $(seq 1 20); do
  rec="$(oc exec deploy/redis -n "$NS" -- redis-cli HGET sh:sandbox:records "$SANDBOX_ID" 2>/dev/null || true)"
  [ -n "$rec" ] && { echo "$rec"; break; }
  sleep 1
done
[ -n "${rec:-}" ] || { echo "NOT registered — check: oc logs deploy/remote-worker -n $NS"; exit 1; }
echo "==> worker log:"; oc logs deploy/remote-worker -n "$NS" --tail=5 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g'
echo "OK. Drive a leaf: POST a LeafEnvelope to the harness /runs (see DESIGN.md)."
