# Deploying on Kind

`deploy/knative/setup-kind.sh` stands up the serverless-harness stack on a
**Kind** (Kubernetes-in-Docker) cluster — Knative Serving + Kourier, KEDA,
Redis, the sandbox pod, the `leaf-work` PVC, the LLM-credentials secret, and
the harness Knative Service.

## Prerequisites

- **Docker** running
- **kind** CLI installed
- **kubectl** configured to the Kind cluster (or the script creates one)
- A model credential:
  - `ANTHROPIC_API_KEY` (direct), **or**
  - `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (Bearer-token gateway, e.g. LiteLLM).

## Quick start

```bash
# 1. Clone (the Pi agent is a submodule)
git clone --recurse-submodules https://github.com/kagenti/serverless-harness.git
cd serverless-harness

# 2. Provide a model credential — direct key...
export ANTHROPIC_API_KEY=sk-...
#    ...or a Bearer-token gateway:
# export ANTHROPIC_BASE_URL=https://your-gateway
# export ANTHROPIC_AUTH_TOKEN=...

# 3. Install (creates cluster if needed, builds image, deploys everything)
./deploy/knative/setup-kind.sh
```

When it finishes, the script prints Kourier access instructions:

```bash
# In a separate terminal:
kubectl port-forward -n kourier-system svc/kourier 8080:80

# Send a request with the Host header:
curl -H 'Host: serverless-harness.default.example.com' \
     -H 'Content-Type: application/json' \
     -d '{"prompt": "Remember the secret word: pineapple. Reply only with OK."}' \
     http://localhost:8080/turn | jq .
# => { "sessionId": "019...", "response": "OK" }
```

## Options

```
--skip-build             Do not build/load the harness image (use existing)
--cluster-name <name>    Kind cluster name (default: sh-knative)
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLUSTER_NAME` | `sh-knative` | Kind cluster name |
| `KNATIVE_VERSION` | `v1.14.0` | Knative Serving version |
| `KEDA_VERSION` | `v2.14.0` | KEDA version |

## Choosing the model

The harness model is set via the `SH_MODEL` environment variable in
[`service.yaml`](service.yaml) (line 37). The default is `claude-haiku-4-5`.

To use a different model, edit `service.yaml` before running the setup script:

```yaml
- name: SH_MODEL
  value: "claude-sonnet-4-6"   # or claude-opus-4-6, claude-haiku-4-5, etc.
```

Or patch the running Knative Service after deployment:

```bash
kubectl set env ksvc/serverless-harness SH_MODEL=claude-sonnet-4-6
```

This triggers an automatic revision rollout. Available model IDs:

| Model | ID | Notes |
|-------|----|-------|
| Haiku 4.5 | `claude-haiku-4-5` | Default — fast, low cost |
| Sonnet 4.6 | `claude-sonnet-4-6` | Balanced |
| Opus 4.6 | `claude-opus-4-6` | Most capable |

When using a gateway (LiteLLM, etc.), the model ID must match what the gateway
accepts — consult your gateway's model routing configuration.

## What it installs

| Component | How |
|-----------|-----|
| Knative Serving + Kourier | Direct YAML apply from upstream releases |
| KEDA | Direct YAML apply (async leaf ScaledJob support) |
| Knative config | Autoscaler tuning (20s stable-window), PVC feature flags, security-context flag |
| Redis | Lightweight in-repo Deployment (`redis:7-alpine`) |
| Sandbox | Pre-baked image (`sandbox.yaml`, `USER 65532`) |
| `leaf-work` PVC | `ReadWriteOnce`, default StorageClass |
| Harness | Knative Service (`service.yaml`) |
| Ingress | Kourier + port-forward from host |

## Smoke test

Run the smoke suite (requires the Kourier port-forward to be active):

```bash
./deploy/knative/smoke.sh
```

See [`SMOKE.md`](SMOKE.md) for detailed results and what each claim proves.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `ksvc` never Ready, pod `CrashLoopBackOff` | Check `kubectl logs` — likely missing `llm-credentials` secret or broken image. |
| `/turn` returns `"Connection error"` | The harness can't reach its Anthropic endpoint from the cluster (gateway unreachable). `/health` still works. |
| Image not found after `--skip-build` | Load the image manually: `kind load docker-image dev.local/serverless-harness:local --name sh-knative` |
| Scale-to-zero doesn't happen | Verify `config-autoscaler` settings: `kubectl get cm config-autoscaler -n knative-serving -o yaml` |

## Cleanup

```bash
kind delete cluster --name sh-knative
```
