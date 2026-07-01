# Deploying on OpenShift

`deploy/knative/setup-ocp.sh` stands up the serverless-harness stack on
**OpenShift 4.20+** — the OpenShift-native sibling of [`setup-kind.sh`](setup-kind.sh).
It installs OpenShift Serverless (Knative + Kourier), Redis, the sandbox pod, the
`leaf-work` PVC, the LLM-credentials secret, and the harness Knative Service,
reachable over its **auto-created OpenShift Route**.

Base bring-up only — see [Scope](#scope) for what is deferred.

## Prerequisites

- **`oc`**, logged in to an OpenShift **4.20+** cluster as **cluster-admin**
  (operator installs + SCC assignment require it).
- A default **StorageClass** for the `leaf-work` PVC (the script fails fast if
  none exists). See the [storage caveat](#storage--scc).
- A model credential:
  - `ANTHROPIC_API_KEY` (direct), **or**
  - `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (Bearer-token gateway, e.g. LiteLLM).
- The harness image. By default the script pulls the published
  `ghcr.io/kagenti/serverless-harness:latest`; override with `--image`.

## Quick start

```bash
# 1. Clone (the Pi agent is a submodule)
git clone --recurse-submodules https://github.com/kagenti/serverless-harness.git
cd serverless-harness

# 2. Log in to your OpenShift 4.20+ cluster as cluster-admin
oc login --token=... --server=https://api.<cluster>:6443

# 3. Provide a model credential — direct key...
export ANTHROPIC_API_KEY=sk-...
#    ...or a Bearer-token gateway:
# export ANTHROPIC_BASE_URL=https://your-gateway
# export ANTHROPIC_AUTH_TOKEN=...

# 4. Preview without touching the cluster (optional)
./deploy/knative/setup-ocp.sh --dry-run

# 5. Install
./deploy/knative/setup-ocp.sh
```

When it finishes, the script prints the Route URL and a ready-to-run `curl`:

```bash
curl -sk -H 'Content-Type: application/json' \
     -d '{"prompt": "Remember the secret word: pineapple. Reply only with OK."}' \
     https://serverless-harness-default.apps.<cluster-domain>/turn | jq .
# => { "sessionId": "019...", "response": "OK" }
```

No Kourier port-forward and no `Host` header are needed — OpenShift Serverless
creates a real Route per Knative Service (`oc get ksvc serverless-harness -o jsonpath='{.status.url}'`).

## What it installs

| Component | How |
|-----------|-----|
| Knative Serving (+ Kourier) | **Red Hat OpenShift Serverless Operator** (OLM Subscription in `openshift-serverless`) + a `KnativeServing` CR in `knative-serving`. Kourier is bundled. |
| Knative config | Autoscaler tuning + the `podspec-persistent-volume-claim`/`-write`/`-securitycontext` feature flags are set in the **`KnativeServing` CR spec** (the operator reverts direct `config-*` ConfigMap patches). |
| Redis | Lightweight in-repo Deployment (`redis:7-alpine`), runs under `restricted-v2`. |
| Sandbox | Pre-baked image ([`sandbox.Dockerfile`](sandbox.Dockerfile), `USER 65532`), built in-cluster against the internal registry (or supplied via `--sandbox-image`). |
| `leaf-work` PVC | `ReadWriteOnce`, cluster-default StorageClass. |
| Harness | Knative Service applied via the [`overlays/ocp`](overlays/ocp) kustomize overlay; SA granted the `nonroot-v2` SCC. |
| Ingress | Auto-created OpenShift Route. |

Manifests are shared with Kind via the `overlays/ocp` overlay — OpenShift tweaks
are kustomize patches, not forked YAMLs.

## Options

```
--namespace <ns>         Target namespace (default: default)
--image <ref>            Harness image (default: ghcr.io/kagenti/serverless-harness:latest)
--sandbox-image <ref>    Use an existing sandbox image (implies --skip-sandbox-build)
--skip-sandbox-build     Do not build the sandbox image in-cluster
--serverless-channel <c> OpenShift Serverless subscription channel (default: stable)
--with-keda              Install KEDA (Custom Metrics Autoscaler Operator) for async leaf
--keda-channel <c>       Custom Metrics Autoscaler channel (default: stable)
--skip-keda              Skip KEDA (default)
--dry-run                Print the commands without executing
-h, --help               Show help
```

The script is **idempotent** — safe to re-run; it skips operators/CRs that already exist.

## Smoke test

Run the repo's smoke suite against the Route by exporting `KSVC_URL`:

```bash
KSVC_URL=$(oc get ksvc serverless-harness -n default -o jsonpath='{.status.url}') \
  ./deploy/knative/smoke.sh
```

See [`SMOKE.md`](SMOKE.md#smoke-test-on-openshift) for details. Claims that assert
on the **LLM `/turn` response** require the harness to reach its configured
Anthropic endpoint *from the cluster*; health, scale-to-zero/-up, Redis session
recall, and the 404 path do not.

## Enabling KEDA (async leaf)

Base bring-up skips KEDA. To install the Red Hat **Custom Metrics Autoscaler
Operator** (needed by the async-leaf `ScaledJob`, [`leaf-scaledjob.yaml`](leaf-scaledjob.yaml)):

```bash
./deploy/knative/setup-ocp.sh --with-keda
```

This creates a Subscription in `openshift-keda` and a `KedaController` CR. Wiring
and verifying the async-leaf path itself on OpenShift is a further step.

## Storage & SCC

- **Storage / RWX.** `leaf-work` is `ReadWriteOnce`. On block storage (e.g. AWS EBS
  `gp3-csi`) it binds to a single node — fine for a single harness consumer.
  Concurrent multi-node scale-out, or co-mounting with the leaf-orchestrator, needs
  a **RWX** StorageClass (a filesystem provisioner). The base bring-up does not deploy
  the orchestrator. Set a specific class by making it the cluster default before install.
- **SCC.** The published harness image declares no `USER` (defaults to root), so it
  runs as an explicit non-root UID (65532) and the script grants the harness
  ServiceAccount the `nonroot-v2` SCC (`oc adm policy add-scc-to-user nonroot-v2 -z
  serverless-harness`). The sandbox image sets `USER 65532` itself and needs no grant.

## Image delivery

- **Default:** pull the published `ghcr.io/kagenti/serverless-harness` image; pin a
  tag with `--image ghcr.io/kagenti/serverless-harness:<tag>`.
- **Build from source in-cluster** (no external registry) against the OpenShift
  internal registry:
  ```bash
  oc new-build --name serverless-harness --binary --strategy=docker -n default
  oc start-build serverless-harness --from-dir=. --follow -n default
  ./deploy/knative/setup-ocp.sh \
    --image image-registry.openshift-image-registry.svc:5000/default/serverless-harness:latest
  ```
  (Requires the pi-fork submodule to be checked out: `git submodule update --init pi-fork`.)

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `ksvc` never Ready, pod `CreateContainerConfigError: container has runAsNonRoot and image will run as root` | The `nonroot-v2` SCC grant didn't apply. Re-run the script, or `oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness -n <ns>`. |
| `ksvc` never Ready, pod `CrashLoopBackOff` with `ERR_MODULE_NOT_FOUND` | The harness image is broken/stale. Use a newer `--image` (the fix shipped in the image build; see the repo history). |
| `leaf-work` PVC stuck `Pending` | No (default) StorageClass. Set one, or ensure a provisioner is installed. |
| `oc apply -k overlays/ocp` fails with a load-restrictor / "not in or below" error | The overlay references shared base YAMLs one level up. Render with `oc kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp \| oc apply -f -` — `setup-ocp.sh` does this for you. |
| `/turn` returns `"Connection error"` | The harness can't reach its configured Anthropic endpoint from the cluster (egress/gateway reachability). `/health` and session creation still work. |

## Cleanup

```bash
oc delete ksvc serverless-harness -n default
oc delete -k <(oc kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp) 2>/dev/null || true
oc delete pod sandbox-0 deployment/redis svc/redis pvc/leaf-work secret/llm-credentials -n default
# Operators (optional): oc delete knativeserving knative-serving -n knative-serving; oc delete subscription serverless-operator -n openshift-serverless
```

## Scope

Base bring-up. **Deferred** (see issue #41): KEDA-driven async-leaf verification on
OpenShift, the E1–E5 experiment drivers, the optional certified Redis Enterprise
Operator, and folding this into the main Kagenti installer.
