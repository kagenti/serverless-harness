# deploy/knative/sandbox.Dockerfile
# Pre-baked sandbox image for OpenShift.
#
# The Kind sandbox (sandbox.yaml) runs `apk add bash coreutils findutils grep`
# as root at container start-up. OpenShift's default `restricted-v2` SCC forbids
# running as root and writing to system dirs, so that start-up command is blocked.
# Bake the tools in at build time instead, then run the pod read-only(-ish) as an
# arbitrary, SCC-assigned UID.
#
# Built in-cluster against the OpenShift internal registry by setup-ocp.sh
# (oc new-build --binary --strategy=docker). The harness routes agent tool
# execution into this pod via `kubectl exec`, so it needs bash + GNU coreutils,
# findutils, grep and ripgrep (the agent's find/grep tools shell out to `rg`) on PATH.
FROM alpine:3.20

RUN apk add --no-cache bash coreutils findutils grep ripgrep

# OpenShift assigns the pod a non-root UID; the OCP overlay pins runAsUser/fsGroup
# 65532 and backs /workspace with the Sandbox CR's durable PVC (fsGroup-owned, so
# writable). The chgrp/chmod below is belt-and-suspenders for GID-0 arbitrary-UID use.
RUN mkdir -p /workspace \
    && chgrp -R 0 /workspace \
    && chmod -R g=u /workspace

WORKDIR /workspace

# A non-root default so the image is well-behaved even without an SCC override.
# restricted-v2 will replace this with a UID from the namespace's allocated range.
USER 65532

CMD ["sleep", "infinity"]
