# P0′ — OpenShift Deployment of the FS-Free Harness (P1 slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged FS-free two-tier harness (P1) deploy and pass its full leaf smoke on the live OpenShift 4.20.8 cluster, with a durable RWO sandbox — by reframing the never-applied, pre-P1 OCP overlay + `setup-ocp.sh` to the `Sandbox`-CR world.

**Architecture:** FS-free harness Knative Service (GHCR image, mounts only `/tmp`) resolves `sandbox-0` via `KAGENTI_SANDBOX_NAME` + the Sandbox CR's `.status.selector` and `kubectl exec`s tool ops into it. The sandbox pod is created by the agent-sandbox v0.5.0 controller from a `Sandbox` CR whose `volumeClaimTemplates` back `/workspace` with a durable RWO EBS PVC. OCP-specific divergences (non-root SCC, pre-baked tool image) live entirely in the `overlays/ocp` kustomize overlay + `setup-ocp.sh`; the shared base manifests are untouched.

**Tech Stack:** OpenShift 4.20.8 / Knative Serving v1.17 (OpenShift Serverless), agent-sandbox v0.5.0 (`sandboxes.agents.x-k8s.io`), AWS EBS `gp3-csi` (RWO), kustomize (JSON6902 patch), bash, Redis.

**Spec:** [`docs/specs/2026-07-02-p0prime-ocp-fs-free-deployment-design.md`](../../specs/2026-07-02-p0prime-ocp-fs-free-deployment-design.md)

## Global Constraints

- **Branch:** `docs/p0prime-ocp-fs-free-deployment` (already created off `main` @ `d199484`). Do all work here.
- **DCO on every commit:** `git commit -s -m "<subject>" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"`. Never `Co-authored-by`.
- **Never `git add -A`.** The tree is intentionally dirty (`experiments/RESULTS.md`, `.worktrees/`). `git add` **explicit paths only**.
- **Live cluster:** `export KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig` in every shell that touches the cluster. Namespace: **`default`**. Cluster is OCP 4.20.8; Serverless + KEDA already installed; agent-sandbox controller is **not** installed.
- **Context budget:** redirect any command with >5 lines of output to `/tmp/sh/p0prime/*.log` (`mkdir -p /tmp/sh/p0prime` first) and analyze logs via a subagent — never read a full build/smoke/kubectl dump into the main context.
- **Smoke model:** `SH_MODEL=claude-haiku-4-5` unless overridden.
- **Scope fence:** touch only these 5 files — `deploy/knative/sandbox.Dockerfile`, `deploy/knative/overlays/ocp/kustomization.yaml`, `deploy/knative/overlays/ocp/patch-sandbox.yaml`, `deploy/knative/setup-ocp.sh`, `deploy/knative/README-ocp.md`. Do **not** edit `leaf-orchestrator.yaml`, the gate/cron/async smokes, `lib.sh`, `setup-kind.sh`, `README-kind.md`, or `service.yaml` (the harness SA + exec RBAC ship in `service.yaml`, reused as-is from the working Kind path).

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `deploy/knative/sandbox.Dockerfile` | Pre-baked OCP sandbox tool image | Add `ripgrep` (leaf `find`/`grep` route to `rg`) |
| `deploy/knative/overlays/ocp/patch-sandbox.yaml` | OCP divergence for the sandbox pod | Rewrite as a **JSON6902 patch onto the `Sandbox` CR**: non-root `securityContext` + `fsGroup` + SA + `sleep infinity` + pre-baked image; **keep the durable PVC** (no `emptyDir`) |
| `deploy/knative/overlays/ocp/kustomization.yaml` | OCP overlay wiring | Drop deleted `leaf-pvc.yaml`; retarget patch to `Sandbox` CR; drop dead `alpine` image transform; fix header comments |
| `deploy/knative/setup-ocp.sh` | One-shot OCP bring-up | Create sandbox SA + grant `nonroot-v2`; install agent-sandbox v0.5.0 controller; poll Sandbox readiness; tolerate a pre-existing `llm-credentials` secret; retire `leaf-work` wording |
| `deploy/knative/README-ocp.md` | OCP operator docs | Replace `leaf-work` PVC references with durable-PVC-via-CR + controller-install step |

---

### Task 1: Add `ripgrep` to the pre-baked sandbox image

**Files:**
- Modify: `deploy/knative/sandbox.Dockerfile:16` (and the two stale comments)

**Interfaces:**
- Produces: the in-cluster-built `serverless-harness-sandbox` image now has `rg` on `PATH`, satisfying `packages/k8s-sandbox/src/operations.ts` (glob `rg --files`) and `grep-tool.ts` (`rg --line-number`).

- [ ] **Step 1: Add `ripgrep` to the `apk add` line**

Change line 16 from:
```dockerfile
RUN apk add --no-cache bash coreutils findutils grep
```
to:
```dockerfile
RUN apk add --no-cache bash coreutils findutils grep ripgrep
```

- [ ] **Step 2: Fix the two now-inaccurate comments**

In the top comment block, change the PATH line (≈line 13) to name ripgrep and why:
```dockerfile
# execution into this pod via `kubectl exec`, so it needs bash + GNU coreutils,
# findutils, grep and ripgrep (the agent's find/grep tools shell out to `rg`) on PATH.
```
In the `/workspace` comment block (≈lines 20-22), drop the stale "emptyDir over /workspace" clause — the OCP overlay now backs `/workspace` with the Sandbox CR's durable PVC (fsGroup-owned), not an emptyDir:
```dockerfile
# OpenShift assigns the pod a non-root UID; the OCP overlay pins runAsUser/fsGroup
# 65532 and backs /workspace with the Sandbox CR's durable PVC (fsGroup-owned, so
# writable). The chgrp/chmod below is belt-and-suspenders for GID-0 arbitrary-UID use.
```

- [ ] **Step 3: Verify the Dockerfile is well-formed and includes ripgrep**

Run:
```bash
grep -n 'ripgrep' deploy/knative/sandbox.Dockerfile; echo "EXIT:$?"
```
Expected: line 16 prints, `EXIT:0`.

Optional local build sanity check (only if a container runtime is present; the authoritative build is in-cluster in Task 6):
```bash
if command -v podman >/dev/null || command -v docker >/dev/null; then
  RT=$(command -v podman || command -v docker)
  "$RT" build -f deploy/knative/sandbox.Dockerfile -t sh-sandbox-test deploy/knative \
    >/tmp/sh/p0prime/sandbox-local-build.log 2>&1 && \
  "$RT" run --rm --entrypoint rg sh-sandbox-test --version | head -1 || \
  echo "local build unavailable/failed — verified in-cluster in Task 6 (see log)"
fi
```
Expected: `ripgrep 14.x` prints, or the "verified in-cluster" fallback line.

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/sandbox.Dockerfile
git commit -s -m "fix(ocp): add ripgrep to the pre-baked sandbox image" \
  -m "The agent's find/grep tools shell out to rg inside the sandbox; the OCP
image omitted ripgrep, so the full leaf smoke would crash on the first search." \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 2: Reframe the OCP overlay onto the `Sandbox` CR (durable PVC, non-root)

**Files:**
- Rewrite: `deploy/knative/overlays/ocp/patch-sandbox.yaml`
- Modify: `deploy/knative/overlays/ocp/kustomization.yaml`

**Interfaces:**
- Consumes: base `deploy/knative/sandbox.yaml` (`Sandbox` CR `sandbox-0`, container `sandbox` at `podTemplate.spec.containers[0]`, image `alpine:3.20`, `volumeClaimTemplates[workspace]` RWO 1Gi).
- Produces: a rendered `Sandbox` CR whose pod runs as UID 65532 (non-root, `nonroot-v2`), `fsGroup: 65532`, `serviceAccountName: serverless-harness-sandbox`, `command: [sleep infinity]`, image = the internal-registry pullspec, `/workspace` on the durable PVC (no emptyDir). Consumed by `setup-ocp.sh` render/apply (Task 3) and the live deploy (Tasks 5-6). The pullspec literal `image-registry.openshift-image-registry.svc:5000/default/serverless-harness-sandbox:latest` MUST match `setup-ocp.sh`'s `render_overlay` sed.

- [ ] **Step 1: Rewrite `patch-sandbox.yaml` as a JSON6902 patch onto the Sandbox CR**

Replace the entire file with (a JSON6902 op list — kustomize strategic-merge can't reliably merge a container inside a CRD `podTemplate`, so we use explicit paths):
```yaml
# OpenShift variant of the sandbox pod, applied as a JSON6902 patch onto the
# Sandbox CR (agents.x-k8s.io/v1beta1). The base (Kind) runs `apk add ...` as root
# at start-up — blocked by OCP SCCs. Here: tools are pre-baked into the image
# (sandbox.Dockerfile), so the command is just `sleep infinity`; the image is the
# in-cluster-built internal-registry pullspec; the pod runs non-root (UID 65532,
# admitted by nonroot-v2 on the serverless-harness-sandbox SA) with fsGroup 65532
# so the Sandbox CR's durable /workspace PVC (from volumeClaimTemplates) is writable.
# NOTE: we deliberately do NOT touch volumeClaimTemplates/volumeMounts — /workspace
# stays on the durable RWO PVC (the point of P0′), not an emptyDir.
- op: replace
  path: /spec/podTemplate/spec/containers/0/image
  value: image-registry.openshift-image-registry.svc:5000/default/serverless-harness-sandbox:latest
- op: replace
  path: /spec/podTemplate/spec/containers/0/command
  value: ["sleep", "infinity"]
- op: add
  path: /spec/podTemplate/spec/serviceAccountName
  value: serverless-harness-sandbox
- op: add
  path: /spec/podTemplate/spec/securityContext
  value:
    runAsUser: 65532
    runAsNonRoot: true
    fsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
- op: add
  path: /spec/podTemplate/spec/containers/0/securityContext
  value:
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
```

- [ ] **Step 2: Fix `kustomization.yaml` — resources, patch target, image transform, comments**

Edit `deploy/knative/overlays/ocp/kustomization.yaml`:

(a) Remove the deleted PVC from `resources` (lines 28-32 become):
```yaml
resources:
  - ../../redis.yaml
  - ../../sandbox.yaml
  - ../../service.yaml
```

(b) Drop the dead `alpine` image transform (the sandbox image is now set in the JSON6902 patch; the built-in `images` transformer cannot reach a CRD's `podTemplate` path anyway). The `images:` block becomes just the harness entry:
```yaml
images:
  - name: dev.local/serverless-harness
    newName: ghcr.io/kagenti/serverless-harness
    newTag: latest
```

(c) Retarget the patch from a non-existent `Pod` to the `Sandbox` CR (lines 42-47 become):
```yaml
patches:
  - path: patch-sandbox.yaml
    target:
      group: agents.x-k8s.io
      version: v1beta1
      kind: Sandbox
      name: sandbox-0
```

(d) Fix the header comment block (lines 9-24) to describe the real design — replace the "Sandbox image ... referenced by its internal-registry pullspec" / "writable /workspace emptyDir" / "pre-baked sandbox image ... sets USER 65532 itself, so its pod needs no SCC grant" / "leaf-work PVC" paragraphs with:
```yaml
#   - Sandbox image + pod: the pre-baked image (sandbox.Dockerfile) and the
#     non-root securityContext are set via a JSON6902 patch onto the Sandbox CR
#     (patch-sandbox.yaml): runAsUser/fsGroup 65532, seccomp RuntimeDefault,
#     drop ALL caps, and serviceAccountName serverless-harness-sandbox. The
#     command is `sleep infinity` (no root apk-add).
#
# Both tiers run non-root: setup-ocp.sh grants nonroot-v2 to the harness SA
# (serverless-harness) AND the sandbox SA (serverless-harness-sandbox), since the
# GHCR harness image declares no USER and the SCC does not reliably inject a UID.
#
# The sandbox's /workspace is backed by the Sandbox CR's durable RWO PVC
# (volumeClaimTemplates) — the only mode AWS EBS / gp3-csi offers. RWX is a P2
# concern on the sandbox tier, never the harness. There is no leaf-work PVC after P1.
```

- [ ] **Step 3: Render the overlay locally and verify it is correct**

Run (kustomize via `oc`/`kubectl`, or standalone `kustomize`):
```bash
mkdir -p /tmp/sh/p0prime
(oc kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp \
  || kubectl kustomize --load-restrictor LoadRestrictionsNone deploy/knative/overlays/ocp) \
  > /tmp/sh/p0prime/render.yaml 2> /tmp/sh/p0prime/render.err; echo "EXIT:$?"
```
Expected: `EXIT:0` (no "leaf-pvc.yaml" load error, no "no matches for target" patch error).

- [ ] **Step 4: Assert the rendered Sandbox CR is correct**

Run:
```bash
cd /tmp/sh/p0prime
echo "== leaf-work must be ABSENT =="; grep -c 'leaf-work\|leaf-pvc' render.yaml   # expect 0
echo "== emptyDir must be ABSENT =="; grep -c 'emptyDir' render.yaml               # expect 0
echo "== durable PVC template PRESENT =="; grep -c 'volumeClaimTemplates' render.yaml # expect 1
echo "== non-root + fsGroup + SA + image + sleep =="
grep -E 'runAsUser: 65532|fsGroup: 65532|serviceAccountName: serverless-harness-sandbox|serverless-harness-sandbox:latest|- sleep' render.yaml
```
Expected: first grep `0`, second `0`, third `≥1`, and all five patterns in the last grep print.

- [ ] **Step 5: Commit**

```bash
git add deploy/knative/overlays/ocp/kustomization.yaml deploy/knative/overlays/ocp/patch-sandbox.yaml
git commit -s -m "fix(ocp): reframe overlay onto the Sandbox CR with a durable PVC" \
  -m "P1 deleted leaf-pvc.yaml and moved the sandbox working set to the Sandbox
CR's volumeClaimTemplates. The pre-P1 overlay still referenced leaf-pvc.yaml
(kustomize build failed), patched a non-existent Pod, and overrode /workspace
to emptyDir (defeating durability). Patch the Sandbox CR podTemplate via JSON6902
instead: non-root 65532 + fsGroup + nonroot-v2 SA + pre-baked image, PVC intact." \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 3: Wire the missing pieces into `setup-ocp.sh`

**Files:**
- Modify: `deploy/knative/setup-ocp.sh`

**Interfaces:**
- Consumes: the corrected overlay (Task 2), the ripgrep image (Task 1), the `wait_for_crd` / `apply_stdin` / `run_cmd` / `log_*` helpers already in the script.
- Produces: an end-to-end bring-up that installs the agent-sandbox controller, creates + SCC-grants the sandbox SA, applies the overlay, waits for the Sandbox pod Ready via `.status.selector`, and tolerates a pre-provisioned `llm-credentials` secret.

- [ ] **Step 1: Tolerate a pre-existing `llm-credentials` secret (user provides it)**

Replace the hard-fail guard (lines 359-375, the `# 4. LLM credentials secret` block body) so that when neither env var is set it *uses an existing secret* instead of exiting:
```bash
create_secret() {
  local args=(--from-literal=api-key="${ANTHROPIC_API_KEY:-${ANTHROPIC_AUTH_TOKEN:-}}")
  [ -n "${ANTHROPIC_BASE_URL:-}" ]   && args+=(--from-literal=base-url="$ANTHROPIC_BASE_URL")
  [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && args+=(--from-literal=auth-token="$ANTHROPIC_AUTH_TOKEN")
  $KUBECTL create secret generic llm-credentials -n "$NAMESPACE" "${args[@]}" \
    --dry-run=client -o yaml | $KUBECTL apply -f -
}
if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  if $DRY_RUN; then
    log_info "[dry-run] would create/update secret llm-credentials in $NAMESPACE (values redacted)"
  else
    create_secret >/dev/null
    log_success "Secret llm-credentials ready (from environment)"
  fi
elif $KUBECTL get secret llm-credentials -n "$NAMESPACE" &>/dev/null; then
  log_success "Secret llm-credentials already present in $NAMESPACE — using it"
else
  log_error "No ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN in env and no llm-credentials secret in $NAMESPACE."
  log_error "Provide one, or pre-create: oc create secret generic llm-credentials -n $NAMESPACE --from-literal=api-key=..."
  $DRY_RUN || exit 1
fi
```

- [ ] **Step 2: Create the sandbox SA and grant it `nonroot-v2` (extend section 5)**

After the existing harness SCC grant (line 392, end of the `# 5.` block), append:
```bash
log_info "Ensuring sandbox ServiceAccount + nonroot-v2 SCC (serverless-harness-sandbox) in $NAMESPACE"
$KUBECTL create serviceaccount serverless-harness-sandbox -n "$NAMESPACE" \
  --dry-run=client -o yaml | apply_stdin >/dev/null
if [ "$KUBECTL" = "oc" ]; then
  run_cmd oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness-sandbox -n "$NAMESPACE"
else
  log_warn "kubectl in use — cannot grant SCC; run: oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness-sandbox -n $NAMESPACE"
fi
```

- [ ] **Step 3: Install the agent-sandbox controller before the overlay apply**

Insert a new section immediately **before** `# 6. Apply the data-plane overlay` (line 394), so the `sandboxes.agents.x-k8s.io` CRD exists when the overlay's Sandbox CR is applied:
```bash
# ============================================================================
# 5b. agent-sandbox controller (Sandbox CRD) — kubernetes-sigs v0.5.0
# ============================================================================
# The harness resolves + execs into the sandbox pod; the pod is created by this
# controller from the Sandbox CR (applied via the overlay below). Mirrors
# setup-kind.sh step 5.
echo
if $KUBECTL get crd sandboxes.agents.x-k8s.io &>/dev/null; then
  log_success "agent-sandbox CRD already present — skipping controller install"
else
  log_info "Installing agent-sandbox controller (kubernetes-sigs v0.5.0)"
  run_cmd $KUBECTL apply --server-side -f \
    "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.0/manifest.yaml"
  wait_for_crd sandboxes.agents.x-k8s.io 180
fi
if ! $DRY_RUN; then
  $KUBECTL -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s \
    >"$LOG_DIR/agent-sandbox-rollout.log" 2>&1 \
    && log_success "agent-sandbox controller ready" \
    || log_warn "agent-sandbox controller not ready yet (see $LOG_DIR/agent-sandbox-rollout.log)"
fi
```

- [ ] **Step 4: Poll the Sandbox pod Ready after the overlay apply**

Insert a new section immediately **after** the overlay-apply block (after line 420, before `# 7. Wait for the harness Knative Service`):
```bash
# ============================================================================
# 6b. Wait for the Sandbox pod (controller publishes .status.selector first)
# ============================================================================
echo
if ! $DRY_RUN; then
  log_info "Waiting for Sandbox sandbox-0 .status.selector, then pod Ready (up to ~2m)..."
  SEL=""
  for _ in $(seq 1 60); do
    SEL="$($KUBECTL -n "$NAMESPACE" get sandbox sandbox-0 -o jsonpath='{.status.selector}' 2>/dev/null || true)"
    [ -n "$SEL" ] && break
    sleep 2
  done
  if [ -n "$SEL" ]; then
    $KUBECTL -n "$NAMESPACE" wait --for=condition=Ready pod -l "$SEL" --timeout=180s \
      >"$LOG_DIR/sandbox-wait.log" 2>&1 \
      && log_success "Sandbox pod Ready" \
      || { log_error "Sandbox pod not Ready (see $LOG_DIR/sandbox-wait.log)"; \
           $KUBECTL -n "$NAMESPACE" get pod sandbox-0 -o wide 2>/dev/null || true; exit 1; }
  else
    log_error "Sandbox sandbox-0 never published .status.selector — is the controller running?"
    exit 1
  fi
fi
```

- [ ] **Step 5: Retire `leaf-work` wording (header, usage, StorageClass preflight)**

Make these text-only edits (behavior unchanged):
- Line 10 header comment: `#   - Redis, sandbox, LLM secret and the harness Knative Service` (drop "leaf-work PVC,").
- Line 66 usage text: `(Knative + Kourier), Redis, the sandbox pod, the LLM secret,` (drop "the leaf-work PVC,").
- Lines 152-161 StorageClass preflight — rephrase around the durable sandbox PVC:
```bash
# StorageClass preflight — the sandbox's durable /workspace PVC (Sandbox CR
# volumeClaimTemplates, ReadWriteOnce) needs a (default) StorageClass to bind.
DEFAULT_SC="$($KUBECTL get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{end}' 2>/dev/null || echo "")"
if [ -n "$DEFAULT_SC" ]; then
  log_success "Default StorageClass: $DEFAULT_SC (sandbox /workspace PVC is ReadWriteOnce)"
elif [ "$($KUBECTL get storageclass --no-headers 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
  log_warn "No default StorageClass; the sandbox /workspace PVC may stay Pending unless one is set."
else
  log_error "No StorageClass found — the sandbox /workspace PVC cannot bind. Install a storage provisioner first."
  $DRY_RUN || exit 1
fi
```

- [ ] **Step 6: Syntax-check and dry-run render**

Run:
```bash
bash -n deploy/knative/setup-ocp.sh; echo "SYNTAX_EXIT:$?"
export KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig
./deploy/knative/setup-ocp.sh --dry-run > /tmp/sh/p0prime/setup-dryrun.log 2>&1; echo "DRYRUN_EXIT:$?"
grep -nE 'agent-sandbox|serverless-harness-sandbox|sandbox-0|leaf-work' /tmp/sh/p0prime/setup-dryrun.log | head -30
```
Expected: `SYNTAX_EXIT:0`; the dry-run shows the controller install, the sandbox SA + SCC grant, the Sandbox `.status.selector` poll, and **no** `leaf-work` mentions. (A subagent should confirm the dry-run manifest preview renders the corrected Sandbox CR.)

- [ ] **Step 7: Commit**

```bash
git add deploy/knative/setup-ocp.sh
git commit -s -m "feat(ocp): install agent-sandbox controller + await Sandbox in setup-ocp.sh" \
  -m "Adds the missing agent-sandbox v0.5.0 controller install, the sandbox SA +
nonroot-v2 grant, and the Sandbox .status.selector -> pod-Ready poll (mirrors
setup-kind.sh). Tolerates a pre-provisioned llm-credentials secret. Retires the
post-P1 leaf-work PVC wording." \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 4: Refresh `README-ocp.md`

**Files:**
- Modify: `deploy/knative/README-ocp.md` (lines 6, 15, 66, 147, 177, 186; add a controller-install bullet)

**Interfaces:**
- Consumes: nothing at runtime — operator-facing docs must match Tasks 1-3.

- [ ] **Step 1: Replace every `leaf-work` PVC reference with the durable-sandbox-PVC reality**

Concretely:
- Line 6: `` `leaf-work` PVC, `` → drop it (the intro sentence lists what the script deploys; the durable sandbox PVC is provisioned by the controller from the CR, not a standalone PVC).
- Line 15 (prereq bullet): change to `- A default **StorageClass** for the sandbox's durable `/workspace` PVC (the script fails fast if none).`
- Line 66 (components table row): change `` | `leaf-work` PVC | `ReadWriteOnce`, cluster-default StorageClass. | `` → `` | Sandbox `/workspace` PVC | `ReadWriteOnce` (Sandbox CR `volumeClaimTemplates`), cluster-default StorageClass. | ``
- Line 147 (storage/RWX note): change `` `leaf-work` is `ReadWriteOnce`. `` → `The sandbox's `/workspace` PVC is `ReadWriteOnce`.` and keep the EBS/RWX caveat, adding: "RWX, if ever needed for a shared sandbox pool, lives on the sandbox tier (P2) — never the harness."
- Line 177 (troubleshooting row): change `` | `leaf-work` PVC stuck `Pending` | `` → `` | Sandbox `/workspace` PVC stuck `Pending` | ``
- Line 186 (teardown command): change `pvc/leaf-work` → `sandbox/sandbox-0` (deleting the Sandbox CR reclaims its PVC), i.e. `oc delete sandbox sandbox-0 deployment/redis svc/redis secret/llm-credentials -n default`.

- [ ] **Step 2: Add a controller-install note**

Add a bullet near the components/prereqs describing the new step:
```markdown
- **agent-sandbox controller** (kubernetes-sigs v0.5.0) is installed by the script
  (`sandboxes.agents.x-k8s.io`); it creates the `sandbox-0` pod from the Sandbox CR
  and provisions its durable `/workspace` PVC. The harness resolves the pod via the
  CR's `.status.selector` and `kubectl exec`s tool calls into it.
```

- [ ] **Step 3: Verify no stale references remain**

Run:
```bash
grep -nE 'leaf-work|leaf-pvc' deploy/knative/README-ocp.md; echo "EXIT:$?"
```
Expected: no matches, `EXIT:1`.

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/README-ocp.md
git commit -s -m "docs(ocp): update README-ocp for the FS-free Sandbox-CR deploy" \
  -m "Replace the removed leaf-work PVC with the durable sandbox /workspace PVC
(Sandbox CR volumeClaimTemplates) and document the agent-sandbox controller step." \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 5: Stage-1 walking skeleton — verify controller propagation on the live cluster

Purpose: prove the agent-sandbox **v0.5.0 controller propagates** `podTemplate` `securityContext`/`fsGroup`/`serviceAccountName` **and** `volumeClaimTemplates` on OCP, and that the EBS PVC is writable by the pinned non-root UID — **before** wiring the harness. Uses stock `alpine:3.20` (no ripgrep needed; the skeleton doesn't run a leaf), so it doesn't depend on the in-cluster image build. **No code commit** — this is a live go/no-go gate.

**Files:** none (live cluster only).

- [ ] **Step 1: Set kubeconfig and prep log dir**

```bash
export KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig
mkdir -p /tmp/sh/p0prime
oc get clusterversion -o jsonpath='{.items[0].status.desired.version}{"\n"}'   # expect 4.20.8
```

- [ ] **Step 2: Install the agent-sandbox controller**

```bash
oc apply --server-side -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.0/manifest.yaml" \
  > /tmp/sh/p0prime/skel-controller.log 2>&1; echo "EXIT:$?"
oc wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=120s; echo "CRD:$?"
oc -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s \
  > /tmp/sh/p0prime/skel-rollout.log 2>&1; echo "ROLLOUT:$?"
```
Expected: `EXIT:0`, `CRD:0`, `ROLLOUT:0`.

- [ ] **Step 3: Create the sandbox SA + grant nonroot-v2**

```bash
oc create serviceaccount serverless-harness-sandbox -n default --dry-run=client -o yaml | oc apply -f -
oc adm policy add-scc-to-user nonroot-v2 -z serverless-harness-sandbox -n default
```

- [ ] **Step 4: Apply a minimal walking-skeleton Sandbox CR (stock alpine, non-root, durable PVC)**

```bash
oc apply -f - <<'EOF'
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: sandbox-0
  namespace: default
  labels: { app: sandbox }
spec:
  volumeClaimTemplates:
    - metadata: { name: workspace }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: 1Gi } }
  podTemplate:
    spec:
      serviceAccountName: serverless-harness-sandbox
      securityContext:
        runAsUser: 65532
        runAsNonRoot: true
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: sandbox
          image: alpine:3.20
          command: ["sleep", "infinity"]
          workingDir: /workspace
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: workspace, mountPath: /workspace }
EOF
echo "APPLY:$?"
```
Expected: `APPLY:0`.

- [ ] **Step 5: Wait for the pod, then verify propagation + writability**

```bash
SEL=""
for _ in $(seq 1 60); do
  SEL="$(oc -n default get sandbox sandbox-0 -o jsonpath='{.status.selector}' 2>/dev/null || true)"
  [ -n "$SEL" ] && break; sleep 2
done
echo "SELECTOR=[$SEL]"
oc -n default wait --for=condition=Ready pod -l "$SEL" --timeout=180s; echo "READY:$?"
echo "== runs as 65532? =="; oc -n default get pod sandbox-0 -o jsonpath='{.spec.securityContext.runAsUser}{"\n"}'
echo "== PVC bound? =="; oc -n default get pvc -l app=sandbox -o wide 2>/dev/null || oc -n default get pvc
echo "== /workspace writable? =="; oc -n default exec sandbox-0 -- sh -c 'id; touch /workspace/.probe && echo WRITE_OK && rm /workspace/.probe'
```
Expected: non-empty `SELECTOR`; `READY:0`; `runAsUser` = `65532`; a `Bound` PVC on `gp3-csi`; `id` shows `uid=65532`; `WRITE_OK` prints.

- [ ] **Step 6: Analyze + decide (subagent)**

Dispatch a subagent to read `/tmp/sh/p0prime/skel-*.log` and the step-5 output and confirm: controller Ready, selector published, pod non-root 65532, PVC Bound, `/workspace` writable. **Decision gate:** if propagation failed (e.g. the controller dropped `fsGroup`/`runAsUser`/`serviceAccountName`), STOP and apply the spec §7 mitigation (patch the generated pod directly, or move the field to one the controller honors) — revise Task 2's patch and re-run this task before Task 6.

- [ ] **Step 7: Tear down the skeleton (so Task 6's overlay applies clean)**

```bash
oc -n default delete sandbox sandbox-0
oc -n default delete pvc -l app=sandbox --ignore-not-found
oc -n default get pvc | grep -i workspace || echo "pvc cleaned"
```

---

### Task 6: Full deploy + leaf smoke on the live cluster (definition of done)

Purpose: run the corrected `setup-ocp.sh` end-to-end and pass `leaf-smoke.sh` through the Route. **No code commit** unless the run surfaces a fix (then a small follow-up commit on the same branch).

**Files:** none (live cluster), unless a fix is needed.

- [ ] **Step 1: Preconditions — kubeconfig + llm-credentials present**

```bash
export KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig
oc get secret llm-credentials -n default >/dev/null 2>&1 && echo "SECRET_OK" || \
  echo "MISSING — ask the user to create llm-credentials in ns default before proceeding"
```
Expected: `SECRET_OK` (the user provisions it). If missing, pause and request it.

- [ ] **Step 2: Run the full OCP setup**

```bash
export LOG_DIR=/tmp/sh/p0prime
./deploy/knative/setup-ocp.sh > /tmp/sh/p0prime/setup-run.log 2>&1; echo "SETUP_EXIT:$?"
tail -20 /tmp/sh/p0prime/setup-run.log
```
Expected: `SETUP_EXIT:0`; tail shows `ksvc/serverless-harness Ready` and a printed Route URL. (Subagent analyzes `setup-run.log` + `$LOG_DIR/*.log` — controller install, sandbox build with ripgrep, overlay apply, Sandbox pod Ready, ksvc Ready. Never read the full build log inline.)

- [ ] **Step 3: Capture the Route URL**

```bash
KSVC_URL="$(oc get ksvc serverless-harness -n default -o jsonpath='{.status.url}')"; echo "KSVC_URL=$KSVC_URL"
```
Expected: an `https://serverless-harness-default.apps.rosso1.kubestellar.org` URL.

- [ ] **Step 4: Run the full leaf smoke via the Route**

```bash
cd deploy/knative
export KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig
KSVC_URL="$KSVC_URL" SH_MODEL=claude-haiku-4-5 ./leaf-smoke.sh \
  > /tmp/sh/p0prime/leaf-smoke.log 2>&1; echo "SMOKE_EXIT:$?"
tail -30 /tmp/sh/p0prime/leaf-smoke.log
```
Expected: `SMOKE_EXIT:0`; tail shows all claims passing.

- [ ] **Step 5: Verify the smoke result (subagent)**

Dispatch a subagent to grep `/tmp/sh/p0prime/leaf-smoke.log` for `ok/ko`/`WRONG`/`FAIL` and confirm the definition-of-done claims: FS-free envelope (claim 0), workspace isolation (1), parallel fan-out with verdicts **i1→FLAGGED, i2→CLEAR, i3→CLEAR** (2-3), per-call model routing (4), malformed→HTTP 400 (5), idempotent re-invoke (6), crash/resume from Redis (7 — now genuinely exercising durable-PVC survival), scale-to-zero (8). Return the pass/fail line for each claim, not the whole log.

- [ ] **Step 6: If green — record the result**

Append a short entry to the plan's status (or note for the PR body) that the full leaf smoke passed on OCP 4.20.8 with the corrected overlay + controller install. If any claim failed, capture the specific failure via subagent, apply the minimal fix on this branch (DCO-signed commit touching only the in-scope files), and re-run from the failing step.

---

## Self-Review

**Spec coverage** (spec §5.3 changeset + §5.4 sequence + §6 verification):
- §5.3 `sandbox.Dockerfile` ripgrep → Task 1. ✅
- §5.3 `kustomization.yaml` (drop leaf-pvc, retarget patch, image transform) → Task 2 Step 2. ✅
- §5.3 `patch-sandbox.yaml` (Sandbox CR, securityContext, SA, sleep, no emptyDir) → Task 2 Step 1. ✅
- §5.3 `setup-ocp.sh` (controller install, Sandbox poll, sandbox SA+SCC, llm-credentials presence) → Task 3. ✅
- §5.3 `README-ocp.md` → Task 4. ✅
- §5.2 non-root + fsGroup + nonroot-v2 SA → Task 2 (patch) + Task 3 Step 2 (SA/SCC). ✅
- §5.4 deploy sequence (controller before overlay; Sandbox poll after) → Task 3 Steps 3-4. ✅
- §6 Stage-1 walking skeleton → Task 5. §6 Stage-2 full deploy + leaf smoke → Task 6. ✅
- §7 controller-propagation risk → Task 5 Step 6 decision gate. §7 kustomize-CRD gotcha → JSON6902 in Task 2. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows the actual content. The one JSON6902-vs-strategic-merge choice from the spec is resolved to JSON6902 in Task 2. ✅

**Type/naming consistency:** SA name `serverless-harness-sandbox`, Sandbox name `sandbox-0`, CRD `sandboxes.agents.x-k8s.io` (group `agents.x-k8s.io`, version `v1beta1`), image pullspec literal, `.status.selector`, UID/fsGroup `65532`, namespace `default` — used identically across Tasks 2, 3, 5, 6 and matched to the base `sandbox.yaml` and `setup-ocp.sh` `render_overlay` sed. ✅

**Out of scope (unchanged):** `leaf-orchestrator.yaml`, gate/cron/async smokes, `lib.sh`, `setup-kind.sh`, `README-kind.md`, `service.yaml` (harness SA + exec RBAC reused from the working Kind path); GHCR-pull of the sandbox image (post-merge follow-up); P2 RWX/pool; P3 Kata.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
