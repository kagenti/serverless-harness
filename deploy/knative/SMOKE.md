# M4 Smoke Test Results

**Date:** 2026-06-18
**Cluster:** Kind (`sh-knative`), Kubernetes v1.34.0
**Knative Serving:** v1.14.0 + Kourier v1.14.0
**Image:** `dev.local/serverless-harness:local` (667MB)
**Gateway:** LiteLLM at `https://ete-litellm.bx.cloud9.ibm.com`

## Results: 6/6 PASS

```
--- Claim 1: Health endpoint responds ---
  PASS

--- Claim 2: POST /turn creates a new session ---
  PASS
  sessionId=019ed8eb-4757-71a3-bc0a-468150f6120b

--- Claim 3: Pod scales to zero after idle ---
  Waiting for scale-to-zero (up to 90s)...
  Scaled to zero after ~90s
  PASS

--- Claim 4: Cold-start resume recalls session state from Redis ---
  PASS

--- Claim 5: Pod scaled up from zero for claim 4 ---
  PASS

--- Claim 6: 404 on unknown session ---
  PASS

=== Results: 6 passed, 0 failed ===
```

## What Was Proven

1. Knative Serving scales the harness pod to zero after idle (stable-window 20s + grace 10s)
2. Cold-start from zero: Knative spins up a fresh pod on inbound request
3. Redis-backed session storage survives pod termination — session state recalled across cold starts
4. `containerConcurrency: 1` ensures single-tenant pod execution
5. Gateway bridge pattern (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL) works inside the container

## Autoscaler Tuning (dev/testing)

```yaml
stable-window: "20s"        # default 60s
scale-to-zero-grace-period: "10s"  # default 30s
```

For production, use defaults or tune based on cold-start latency tolerance.

## Findings During Setup

1. **Kourier repo moved:** `knative/net-kourier` → `knative-extensions/net-kourier` (kubectl doesn't follow 301 redirects)
2. **Image tag resolution:** Local Kind images need `dev.local/` prefix + `config-deployment` skip-tag-resolving
3. **tsx resolution:** `node --import tsx` requires tsx in the CWD's node_modules — fixed by setting `WORKDIR /app/packages/knative-server`
4. **config-domain:** Must explicitly set `example.com` domain for Kourier routing to work with Host headers

---

# OpenShift (`setup-ocp.sh`)

`setup-ocp.sh` is the OpenShift-native sibling of `setup-kind.sh`. It targets
**OpenShift 4.20+** and stands up the same stack, but the OpenShift way (issue #41):

| Concern | Kind (`setup-kind.sh`) | OpenShift (`setup-ocp.sh`) |
|---------|------------------------|-----------------------------|
| Knative | raw upstream YAML + Kourier | **Red Hat OpenShift Serverless Operator** (OLM Subscription) + `KnativeServing` CR (Kourier bundled) |
| Config  | `kubectl patch configmap config-*` | feature flags + autoscaler tuning in the `KnativeServing` **CR spec** (the operator reverts ConfigMap patches) |
| Ingress | Kourier port-forward + Host header | auto-created **OpenShift Route** (`ksvc` `status.url`) |
| Harness UID | hard-coded `runAsUser/fsGroup: 65532` | kept at 65532; the SA is granted the `nonroot-v2` SCC so that explicit non-root UID is admitted (the GHCR image declares no `USER`, so a UID must be set) |
| Sandbox | `alpine` + `apk add` as root | **pre-baked** image (`sandbox.Dockerfile`, sets `USER 65532`) built in-cluster, restricted-v2 compatible |
| Image   | `docker build` + `kind load` | published GHCR image (`--image`); sandbox built to the internal registry |

Manifests are shared with Kind via the `deploy/knative/overlays/ocp` kustomize
overlay (OCP tweaks are patches, not forked YAMLs).

## Prerequisites

- `oc login` to an OpenShift 4.20+ cluster as **cluster-admin** (operator installs
  + SCC assignment need it).
- A default **StorageClass** for the `leaf-work` PVC (the script fails fast if none).
- `ANTHROPIC_API_KEY` (direct) **or** `ANTHROPIC_AUTH_TOKEN` [+ `ANTHROPIC_BASE_URL`] (gateway).

## Usage

```bash
# Preview everything without touching the cluster
./deploy/knative/setup-ocp.sh --dry-run

# Base bring-up (default namespace, GHCR image, sandbox built in-cluster)
export ANTHROPIC_API_KEY=sk-...        # or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
./deploy/knative/setup-ocp.sh

# Dedicated namespace + a pinned image
./deploy/knative/setup-ocp.sh --namespace serverless-harness \
  --image ghcr.io/kagenti/serverless-harness:v1.2.3
```

The script prints the Route URL and a ready-to-run `curl` when it finishes, e.g.:

```bash
curl -sk -H 'Content-Type: application/json' \
     -d '{"prompt": "Hello"}' \
     https://serverless-harness-default.apps.<cluster-domain>/turn
```

## Smoke test on OpenShift

The Kind smoke/experiment drivers run against the Route — export `KSVC_URL`
(instead of starting a Kourier port-forward):

```bash
KSVC_URL=$(oc get ksvc serverless-harness -n default -o jsonpath='{.status.url}') \
  ./deploy/knative/smoke.sh
```

`lib.sh` then targets the Route directly (no port-forward, no `Host` header, `-k`
for the router cert). Claims that assert on the **LLM `/turn` response** require the
harness to reach its configured Anthropic endpoint *from the cluster*; health,
scale-to-zero/-up, Redis session recall, and the 404 path do not.

## Notes & caveats

- **Storage / RWX.** `leaf-work` is `ReadWriteOnce`. On block storage (e.g. AWS
  EBS `gp3-csi`) that binds to a single node — fine for a single harness consumer.
  Concurrent multi-node harness scale-out, or co-mounting with the leaf-orchestrator
  (async leaf), needs a **RWX** StorageClass (e.g. a filesystem provisioner). The
  base bring-up does not deploy the orchestrator.
- **KEDA / async leaf is opt-in.** Base bring-up skips it (`--skip-keda`, the
  default). Pass `--with-keda` to install the Red Hat **Custom Metrics Autoscaler
  Operator** (`openshift-keda` namespace + `KedaController` CR) that the async-leaf
  ScaledJob (`leaf-scaledjob.yaml`) depends on. Wiring and verifying the async-leaf
  path itself on OpenShift is a further step.
- **Redis** is the lightweight in-repo Deployment (`redis:7-alpine`, runs fine under
  `restricted-v2`). The certified Redis Enterprise Operator is an out-of-scope opt-in.
- **Kustomize load restrictor.** The overlay references the shared base YAMLs one
  directory up, so render it with:
  ```bash
  oc kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp
  ```
  (`setup-ocp.sh` does this for you; plain `oc apply -k` will not work.)
