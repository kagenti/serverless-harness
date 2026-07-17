#!/usr/bin/env bash
# Build the remote-worker container image.
#
# Default: cross-compile a linux/amd64 static binary locally, then package it into
# the OpenShift INTERNAL registry via a binary build — no external registry creds,
# no in-cluster Go/module fetch, and it targets the cluster's architecture.
#
#   ./build-image.sh                                   # -> internal registry (ns=default)
#   NS=default ./build-image.sh
#   ./build-image.sh --push quay.io/aslomnet/remote-worker:dev   # docker build+push instead
#
# Requires: Go 1.23+, and (default path) `oc` logged in to the cluster.
set -euo pipefail
cd "$(dirname "$0")"

NS="${NS:-default}"
NAME="remote-worker"
PUSH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ns) NS="$2"; shift 2 ;;
    --push) PUSH="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "==> cross-compiling linux/amd64 static binary (dist/remote-worker)"
mkdir -p dist
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o dist/remote-worker .
cp Dockerfile.runtime dist/Dockerfile

if [ -n "$PUSH" ]; then
  echo "==> docker build + push $PUSH (linux/amd64)"
  docker build --platform linux/amd64 -t "$PUSH" dist
  docker push "$PUSH"
  echo "IMAGE=$PUSH"
else
  echo "==> OpenShift binary build into the internal registry (ns=$NS)"
  oc get bc "$NAME" -n "$NS" >/dev/null 2>&1 \
    || oc new-build --name "$NAME" --binary --strategy=docker -n "$NS" >/dev/null
  oc start-build "$NAME" --from-dir=dist --follow -n "$NS"
  echo "IMAGE=image-registry.openshift-image-registry.svc:5000/$NS/$NAME:latest"
fi
