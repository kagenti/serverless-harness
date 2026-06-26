#!/usr/bin/env bash
# deploy/knative/run-experiments.sh
# Setup/harden + run E1/E3/E4 and record results to EXPERIMENTS.md.
# Prereq: Kind cluster with the Knative deploy; gateway creds in env.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

echo "=== M7 setup/harden ==="
ensure_secret
kubectl apply -f service.yaml >/dev/null
wait_ksvc_ready
PF_PID=$(ensure_port_forward || true)
trap '[ -n "${PF_PID:-}" ] && kill "$PF_PID" 2>/dev/null || true' EXIT
# Fail fast if the deploy is unhealthy.
if ! echo "$(turn 'Say exactly: PONG')" | jq -r '.response' | grep -qi pong; then
  echo "SETUP-FAIL: deploy did not answer a real turn"; exit 1
fi
echo "setup OK"

set +e   # run all three even if one fails; capture each exit code, then re-enable -e
E1_OUT=$(bash ./e1-economics.sh 2>&1); E1_RC=$?; echo "$E1_OUT"
E3_OUT=$(bash ./e3-mobility.sh 2>&1); E3_RC=$?; echo "$E3_OUT"
E4_OUT=$(bash ./e4-recovery.sh 2>&1); E4_RC=$?; echo "$E4_OUT"
set -e

E1_LINE=$(echo "$E1_OUT" | grep '^E1_RESULT' || echo "E1_RESULT (missing)")
verdict() { [ "$1" = 0 ] && echo PASS || echo FAIL; }

cat > EXPERIMENTS.md <<EOF
# M7 Cluster Experiment Results

Cluster: Kind \`sh-knative\`, ksvc \`serverless-harness\` (ns \`default\`), model \`claude-haiku-4-5\`.
Spec: docs/specs/2026-06-25-m7-cluster-experiments-design.md

## E1 — scale-to-zero economics
\`$E1_LINE\`
Verdict: $(verdict "$E1_RC") (PASS = serverless pod-seconds <= 0.6 x persistent)

## E3 — session mobility
A fresh instance recalled the planted token from the Redis log after scale-to-zero.
Verdict: $(verdict "$E3_RC")

## E4 — crash recovery
After a mid-session pod force-kill, the next turn recalled all completed turns.
Verdict: $(verdict "$E4_RC")

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
EOF

echo "=== wrote EXPERIMENTS.md ==="
[ "$E1_RC" = 0 ] && [ "$E3_RC" = 0 ] && [ "$E4_RC" = 0 ] || { echo "one or more experiments FAILED"; exit 1; }
