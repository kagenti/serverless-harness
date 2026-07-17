# SWE-bench Sandbox-Sharing Experiment — Reproduction Runbook

A self-contained, step-by-step guide to reproduce the serverless-harness sandbox-sharing
performance study on a **new OpenShift cluster**, collect the data, and analyze it. Written for
contributors who have never run it before.

---

## 0. What this measures

Two experiments over [SWE-bench Verified](https://www.swebench.com/) solve tasks ("leaves"), each
of which leases an execution **sandbox** (a pod with the repo + tools) from a shared pool:

| Exp | Question | Output |
|-----|----------|--------|
| **E6** | How many leaves can one sandbox serve (sharing ratio **N = 1/duty**)? Where's the concurrency knee? | `RATIO_CURVE`, `E6_RESULT`, sweep points |
| **E1** | Dedicated (1 sandbox/leaf) vs a shared pool: reservation-seconds saved? | `E1B_RESULT` (benefit ratio) |
| **Plan D** | Are the produced patches *correct*? (offline, model-free) | resolved-rate |

**Platform constraint:** the SWE-bench sandbox image is **x86_64-only** (built from the official
per-instance eval images), so the *cluster* steps are **OpenShift/AMD64 only**. The *offline
evaluator* (§9) runs anywhere with Docker, including arm64 laptops under emulation.

---

## 1. Prerequisites

**Cluster**
- OpenShift **4.20+**, AMD64 worker nodes, `oc` logged in as **cluster-admin**.
- Reference run used 6× `m6i.xlarge` (4 vCPU / 16 GiB) on AWS. Sandbox pods request 512Mi/250m,
  limit 4Gi; each sandbox needs a **50Gi RWO PVC** (a default StorageClass must exist).
- Internal image registry enabled (`image-registry.openshift-image-registry.svc:5000`).

**Local tools**: `git`, `oc`/`kubectl`, `python3.11+`, `node 20+`, `npx`, `jq`, `docker`
(for §9 only).

**Credentials**: an Anthropic API key. Export **before** cluster setup:
```bash
export ANTHROPIC_API_KEY=sk-ant-...          # direct Anthropic (recommended)
# — or, for a gateway: export ANTHROPIC_AUTH_TOKEN=...  ANTHROPIC_BASE_URL=https://...
```

---

## 2. Get the repo

```bash
git clone https://github.com/kagenti/serverless-harness.git
cd serverless-harness
git submodule update --init --recursive        # pi-fork submodule
```
All paths below are relative to this repo root. Requires the SWE-bench experiment scripts on
`main` (Plan B/C + the Plan D evaluator, PR #140).

---

## 3. Cluster setup

One-shot bring-up (Serverless Operator + KnativeServing, Redis, agent-sandbox controller,
`llm-credentials` secret, `nonroot-v2` SCC, harness ksvc):

```bash
oc login <cluster-api> -u <admin>
./deploy/knative/setup-ocp.sh --namespace default --with-keda
# add --dry-run first to preview; --image <ref> to pin a specific harness image
```

**Then raise the Knative request-timeout ceiling** — real solve leaves run 5–15 min, far above the
300 s default, and the drivers set `timeoutSeconds=1800` which requires the cluster ceiling to be
≥ that (otherwise the patch is rejected):

```bash
oc patch knativeserving knative-serving -n knative-serving --type merge \
  -p '{"spec":{"config":{"defaults":{"max-revision-timeout-seconds":"1800"}}}}'
```

Sanity check:
```bash
oc get ksvc serverless-harness -n default          # Ready=True, URL present
oc get pods -n default -l app=redis                 # Running
oc get crd sandboxes.agents.x-k8s.io                # installed
```

Capture the route for the drivers:
```bash
export KSVC_URL="https://$(oc get route serverless-harness -n default -o jsonpath='{.spec.host}')"
export KUBECONFIG=<path-to-cluster-kubeconfig>
```

---

## 4. Build the baked SWE-bench sandbox image (x86_64)

This is the slow, one-time step (~100 min batched). It bakes 15 conda environments + 8 git repo
mirrors + `git`/`ripgrep`/`gcc` into one image. The 24-instance deck (`experiments/swebench/deck.json`)
and `bake-list.json` are already committed (`deckHash=ff962cb83fe5c624`) — regenerate only to change
the instance set:

```bash
# (optional) regenerate the deck — needs network + `pip install swebench datasets`
python3 scripts/gen_swebench_deck.py --slice all --out-dir experiments/swebench
```

Create the ImageStream/BuildConfig, then build in **iterative batches** (single-shot 15 evicts a
node on ephemeral storage). Each batch emits a Dockerfile and layers onto the previous image:

```bash
oc apply -f deploy/knative/swebench-sandbox-buildconfig.yaml

# batch 1 (envs 0-4, includes base tools + repo mirrors)
deploy/knative/build-swebench-sandbox.sh --emit --limit 5 --offset 0 > /tmp/Dockerfile.b1
TAG1=$(deploy/knative/build-swebench-sandbox.sh --print-tag --limit 5 --offset 0)   # …-5of15
oc start-build swebench-sandbox --from-file=/tmp/Dockerfile.b1 -F

# batch 2 (envs 5-9), FROM the batch-1 image
deploy/knative/build-swebench-sandbox.sh --emit --limit 5 --offset 5 \
  --base image-registry.openshift-image-registry.svc:5000/default/swebench-sandbox:$TAG1 --no-base-tools > /tmp/Dockerfile.b2
# … oc start-build with /tmp/Dockerfile.b2, tag …-10of15

# batch 3 (envs 10-14) → final …-15of15
```

Confirm the final `…ff962cb83fe5c624-15of15` tag exists:
```bash
oc get istag -n default | grep swebench-sandbox
```

> The build recipe is pure/offline (reads only `bake-list.json`); details in
> `docs/notes/swebench-image-facts.md`. It uses `conda create --clone testbed` per env (conda-pack
> was abandoned — it shipped corrupt numpy for mixed conda+pip envs).

**Harness image:** `setup-ocp.sh` points the ksvc at `ghcr.io/kagenti/serverless-harness:latest`,
which carries the solve-leaf code. For a reproducible run, pin a specific tag with
`setup-ocp.sh --image ghcr.io/kagenti/serverless-harness:main-<sha>` (the drivers only patch ksvc
env/timeout/scale, never the image).

---

## 5. (Optional) Re-weight the deck

Only needed if you regenerated the deck in §4 (fresh instances have `weight_bucket=null`). Measures
each instance's gold-test wall-clock on the live pool and assigns light/medium/heavy terciles:

```bash
MEASURE_LIVE=1 bash deploy/knative/measure-swebench-runtimes.sh   # OCP-only, sequential, slow
```

---

## 6. Deploy the sandbox pool

```bash
oc apply -f deploy/knative/swebench-sandbox-pool.yaml
oc get sandbox -n default -l app=sandbox                 # wait for swebench-sandbox-0/1/2
oc wait --for=condition=Ready pod -l sh.kagenti.io/sandbox-pool=swebench -n default --timeout=600s
```
3 Sandbox CRs, pool label `sh.kagenti.io/sandbox-pool=swebench`, image pinned to the
`…-15of15` internal-registry tag, 50Gi PVC each. First image pull takes several minutes.

---

## 7. Run the experiments

Set a per-run log dir and keep everything under it:
```bash
export LOG_DIR=/tmp/kagenti/run-$(date +%Y%m%d); mkdir -p "$LOG_DIR"
```

### 7a. E6 — sharing curve + concurrency sweep

```bash
E6_LIVE=1 WORKLOAD=swebench \
  E6_SAMPLES=3 E6_LADDER="1 2 4 8" \
  SWEBENCH_LEAF_TIMEOUT=1800 SH_MODEL=claude-haiku-4-5 \
  PREDICTIONS="$LOG_DIR/predictions.jsonl" USAGE="$LOG_DIR/usage.jsonl" \
  KSVC_URL="$KSVC_URL" KUBECONFIG="$KUBECONFIG" LOG_DIR="$LOG_DIR" \
  bash deploy/knative/e6-saturation.sh 2>&1 | tee "$LOG_DIR/e6.log"
```
Emits per-bucket duty, `RATIO_CURVE=…`, `sweep c=… p95Ms=…`, a final `E6_RESULT …`, and a
`COST_REPORT …`. Note the `knee=` value.

### 7b. E1 — dedicated vs shared benefit

Choose the shared-pool cap **from the duty-cycle N** in the E6 `RATIO_CURVE` (a mid value, ~3), **not**
the sweep `knee` (it is noisy at these long leaves — it was 1 in the reference run):

```bash
E1B_LIVE=1 \
  E1B_PER_BUCKET=5 E1B_CONCURRENCY=4 E1B_SHARED_CAP=3 \
  SWEBENCH_LEAF_TIMEOUT=1800 SH_MODEL=claude-haiku-4-5 \
  PREDICTIONS="$LOG_DIR/predictions-e1.jsonl" USAGE="$LOG_DIR/usage-e1.jsonl" \
  KSVC_URL="$KSVC_URL" KUBECONFIG="$KUBECONFIG" LOG_DIR="$LOG_DIR" \
  bash deploy/knative/e1-benefit.sh 2>&1 | tee "$LOG_DIR/e1.log"
```
Emits `dedicated:` / `shared@N:` lines, a final `E1B_RESULT benefit=…x …`, and a `COST_REPORT …`.

> **Long runs (~4–6 h):** run each driver under `nohup … </dev/null &` (or a detached wrapper that
> touches a `DONE` marker) so it survives a disconnected terminal; poll `$LOG_DIR/*.log` for the
> `E6_RESULT` / `E1B_RESULT` lines. Both drivers reset the ksvc via an `EXIT` trap
> (`restore_ksvc_env`) even on interruption.

---

## 8. Collect the data

```bash
echo "=== E6 ==="; grep -E 'RATIO_CURVE|E6_RESULT|COST_REPORT|sweep c=' "$LOG_DIR/e6.log"
echo "=== E1 ==="; grep -E 'E1B_RESULT|COST_REPORT|dedicated:|shared@' "$LOG_DIR/e1.log"

# non-empty patches captured (Plan D input)
for f in predictions.jsonl predictions-e1.jsonl; do
  ne=$(jq -c 'select((.model_patch // "")|length>0)' "$LOG_DIR/$f" 2>/dev/null | wc -l | tr -d ' ')
  echo "$f: $(wc -l < "$LOG_DIR/$f" | tr -d ' ') rows, $ne non-empty"
done

# total model cost (transport-loss-independent — summed from Redis session streams)
cat "$LOG_DIR"/*.cost 2>/dev/null | jq -s 'map(.costUsd)|add' 2>/dev/null
```

Key artifacts in `$LOG_DIR`: `e6.log`, `e1.log`, `predictions*.jsonl` (patches),
`usage*.jsonl.cost` (per-leaf tokens/cost). The drivers also append a run block to
`deploy/knative/EXPERIMENTS.md`.

> **Health tally** on `E6_RESULT`/`E1B_RESULT` (`health=solved/total … transport=N`): OpenShift
> ingress may drop long-lived HTTP responses; those leaves are *excluded from metrics but counted*.
> Their cost is still captured (Redis-side) and their patch is recoverable (`poll_leaf_result`), so
> the numbers stay trustworthy despite transport loss.

---

## 9. Analyze — offline correctness evaluator (Plan D)

**Model-free and cluster-free.** Applies each captured `model_patch` at its `base_commit` and runs
the gold tests in the official per-instance Docker image. Runs on **any Docker host**; on arm64 it
uses amd64 emulation (enable Rosetta in Docker Desktop). Needs the Docker daemon running.

```bash
PRED_A="$LOG_DIR/predictions.jsonl" PRED_B="$LOG_DIR/predictions-e1.jsonl" \
  RUN_ID=my-run MAX_WORKERS=2 LOG_DIR="$LOG_DIR/eval" \
  bash experiments/swebench/evaluate.sh
```
Prints `RESOLVED_RATE = <resolved>/<completed> (…%)` plus the resolved / unresolved / empty-patch /
errored instance lists. The script installs `swebench` in a venv, merges + dedups the two
prediction files (restoring trailing newlines), pulls prebuilt x86 eval images
(`--namespace swebench`), and summarizes the report.

Smoke one instance first (fast, proves the loop):
```bash
INSTANCE_IDS="django__django-11555" RUN_ID=smoke MAX_WORKERS=1 \
  PRED_A="$LOG_DIR/predictions.jsonl" PRED_B="$LOG_DIR/predictions-e1.jsonl" \
  bash experiments/swebench/evaluate.sh
```

> For a **headline fix-rate**, regenerate patches over the full deck with a capable model
> (`SH_MODEL=claude-opus-4-8` in §7) and score them through this same evaluator.

---

## 10. Restore the cluster

```bash
# ksvc env/timeout/scale reset automatically by each driver's EXIT trap; if interrupted, force it:
( cd deploy/knative && source ./lib.sh && restore_ksvc_env )

oc delete -f deploy/knative/swebench-sandbox-pool.yaml
oc delete pvc -n default -l sh.kagenti.io/sandbox-pool=swebench

# revert the Knative timeout ceiling
oc patch knativeserving knative-serving -n knative-serving --type=json \
  -p '[{"op":"remove","path":"/spec/config/defaults/max-revision-timeout-seconds"}]'

oc get sandbox -n default -l app=sandbox        # default pool back to 3/3
```

---

## 11. Interpreting the results

| Line | Meaning |
|------|---------|
| `RATIO_CURVE … n=5.7/7.3/3.1` | **N = 1/duty** per weight bucket = concurrent leaves one sandbox could serve. Reference: light 5.7 / medium 7.3 / heavy 3.1. |
| `sweep c=… p95Ms=…` | Concurrency sweep. If p95 climbs while throughput is flat and sandboxes stay lightly loaded → the **knee is upstream** (model/harness tier), not the sandbox pool. |
| `E1B_RESULT benefit=1.5x` | Dedicated ÷ shared reservation-seconds/leaf. >1 = pooling saves reserved sandbox-time; check `withinDegrade=true` (p95 within the 2× budget). |
| `COST_REPORT costUsd=…` | Model spend, summed from Redis session streams (dominated by cache-reads). Reference full run ≈ $25.90 on Haiku. |
| `RESOLVED_RATE` (§9) | Correctness: fraction of applied patches that pass the gold tests. |

**Sizing guidance from the reference run:** set the shared-pool cap from the **duty-cycle N (3–7)**,
and scale **harness pods + model quota** (not the sandbox pool) for more throughput.

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `set_ksvc_timeout` fails / revision not Ready | Cluster `max-revision-timeout-seconds` < 1800 — do the §3 patch. |
| Leaves killed mid-run, empty patches | Same timeout issue, or ingress dropped the response. Check the `transport=` tally; cost/patch are still recoverable from Redis. |
| `SandboxPoolSaturatedError` | Every pool pod at `KAGENTI_SANDBOX_CAP`. Raise the cap or add Sandbox CRs. |
| Evaluator: `patch unexpectedly ends in middle of line` | Missing trailing newline on captured patch. `merge_predictions.py` repairs it; the capture-side fix is PR #141. |
| Evaluator very slow / flaky on arm64 | x86 images under emulation. Lower `MAX_WORKERS`, or run on a native x86 host. Pure-python instances work; C-extension repos need native x86. |
| Sandbox pod `ImagePullBackOff` | The `…-15of15` istag isn't built/pushed (§4), or the pool YAML tag doesn't match. |

---

*Reference run: 2026-07-17, OpenShift 4.20.8, Claude Haiku 4.5. Assisted-By: Claude Code.*
