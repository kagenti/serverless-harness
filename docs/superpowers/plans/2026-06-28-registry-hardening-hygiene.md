# Registry + Hardening Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the built leaf-session backend track in the milestone registry, align `server.ts`'s entrypoint idiom, and bring the leaf-worker `ScaledJob` + Knative service up to the cron-dispatch securityContext baseline — all verified by the existing gate smoke.

**Architecture:** Three independent, additive changes. (1) docs-only registry table; (2) a 2-line `server.ts` change to the canonical `fileURLToPath` entrypoint idiom; (3) securityContext stanzas on two K8s manifests plus a Knative feature-flag enablement, with `readOnlyRootFilesystem` decided empirically by the live gate (set `HOME=/tmp` + a writable `/tmp` emptyDir so the Pi agent's config writes land in a writable mount; fall back to `false` per-pod if needed).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node 20, vitest, pnpm workspaces, Knative Serving + Kourier, KEDA, Kind. Spec: `docs/specs/2026-06-28-registry-hardening-hygiene-design.md`.

## Global Constraints

- **No behavioral change** to `runLeaf`, the gate state machine, the leaf-session contract, `leaf-queue`, KEDA scaling metadata, or `submit_verdict`. This bundle is registry docs + an entrypoint idiom + pod securityContext only.
- **Non-fs hardening is unconditional** on both pods: `runAsNonRoot: true`, `runAsUser: 65532`, `seccompProfile: { type: RuntimeDefault }` (pod), `allowPrivilegeEscalation: false`, `capabilities: { drop: ["ALL"] }` (container). Reason for `runAsUser: 65532`: the harness image has no `USER` (runs as root), so `runAsNonRoot` alone would refuse to start.
- **`readOnlyRootFilesystem` is empirical (Option 1):** attempt `true` with `HOME=/tmp` + a writable `/tmp` `emptyDir`; if the live gate shows a pod needs un-redirectable root-fs writes, set `readOnlyRootFilesystem: false` on that pod only (keep `true` on cron-dispatch) and add an inline comment explaining why.
- **`fsGroup: 65532`** on both pods so uid 65532 can write the `leaf-work` `/work` PVC.
- **Image build MUST use `docker buildx build --load` AND verify the image contains the change before `kind load`** (a prior session's active buildx builder used the `docker-container` driver, which never loaded the result into the local image store — `:local` silently stayed stale). Verify with: `docker run --rm --entrypoint sh dev.local/serverless-harness:local -c '<grep for the change>'`.
- **Live gate (`GATE_LIVE_SMOKE=1 deploy/knative/leaf-gate-smoke.sh`) must pass all 6 claims** with the hardened pods. The controller runs the live gate — never a subagent.
- **Deferred (NOT in this plan):** reclaimer-churn tuning.
- **DCO:** `git commit -s` on every commit. Conventional prefixes. Branch: `chore/registry-hardening` (already created; spec already committed there). Attribution `Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>` where needed.
- Unit test commands (from repo root): `pnpm --filter @sh/knative-server test`, `pnpm --filter @sh/harness test`.

---

## File Structure

**Modify:**
- `docs/specs/README.md` — add the "Leaf-Session Backend (BUILT)" section (Task 1).
- `packages/knative-server/src/server.ts` — `isMainModule` idiom (Task 2).
- `deploy/knative/leaf-scaledjob.yaml` — leaf-worker securityContext + HOME + /tmp emptyDir (Task 3).
- `deploy/knative/service.yaml` — ksvc securityContext + HOME + /tmp emptyDir (Task 3).
- `deploy/knative/setup-kind.sh` — enable `kubernetes.podspec-securitycontext` feature flag (Task 3).

No new files. No test files (Task 1 is docs; Task 2 is covered by the existing server suite; Task 3 is verified by the live gate).

---

## Task 1: Register the built leaf-session backend track

**Files:**
- Modify: `docs/specs/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Read the current registry to find the insertion point**

Run: `grep -n "^## Phase" docs/specs/README.md`
Expected: lines for `## Phase 1 — …` and `## Phase 2 — …`. Insert the new section **between** the end of the Phase-1 section and the `## Phase 2` heading (after the Phase-1 collision note, before `---` + `## Phase 2`).

- [ ] **Step 2: Insert the new section**

Insert this block immediately before the `## Phase 2 — Zero-Trust Credential Plane` section's preceding `---` separator:

```markdown
---

## Leaf-Session Backend (BUILT)

The MVP leaf-session contract and the three pipeline archetypes it was tested against
([Pipeline Archetypes](2026-06-26-pipeline-archetypes-requirements.md)) — all shipped. These realize
the [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) §5 MVP core and §8
promote-post-MVP (human-gate, cron trigger). They are the **MVP/charter track**, distinct from the
`M`-numbered built harness (Phase 1) and the `Z`-numbered credential plane (Phase 2).

| Slice | Spec | PR(s) |
|----|-------|-------|
| MVP leaf-session invocation contract (run-to-completion, structured output, volume envelope) + gate-7 durable resume | [`2026-06-26-mvp-leaf-session-contract-design.md`](2026-06-26-mvp-leaf-session-contract-design.md) | #10, #11 |
| Async leaf completion (KEDA `ScaledJob` + Redis Streams queue, done-marker) | [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md) | #12 |
| Scheduled leaf dispatch (cron trigger on-ramp, Archetype C) | [`2026-06-28-scheduled-leaf-dispatch-design.md`](2026-06-28-scheduled-leaf-dispatch-design.md) | #13 |
| Human-gate (gate-while-idle, Archetype B) | [`2026-06-28-human-gate-design.md`](2026-06-28-human-gate-design.md) | #14 |

All three archetypes (A parallel-fan-out, B human-gate, C scheduled) from the evidence base are now
built. Hardening hygiene across these is tracked in
[`2026-06-28-registry-hardening-hygiene-design.md`](2026-06-28-registry-hardening-hygiene-design.md).
```

- [ ] **Step 3: Verify the doc renders and links resolve**

Run: `grep -n "Leaf-Session Backend (BUILT)" docs/specs/README.md && for f in 2026-06-26-mvp-leaf-session-contract-design 2026-06-27-async-leaf-completion-design 2026-06-28-scheduled-leaf-dispatch-design 2026-06-28-human-gate-design 2026-06-28-registry-hardening-hygiene-design; do test -f "docs/specs/$f.md" && echo "OK $f" || echo "MISSING $f"; done`
Expected: the heading line + five `OK` lines (every linked spec exists).

- [ ] **Step 4: Commit**

```bash
git add docs/specs/README.md
git commit -s -m "docs(registry): Register the built leaf-session backend track (MVP + archetypes A/B/C)"
```

---

## Task 2: Align `server.ts` entrypoint idiom

**Files:**
- Modify: `packages/knative-server/src/server.ts`

**Interfaces:**
- Consumes: `import.meta.url`, `process.argv[1]`.
- Produces: no exported API change; `isMainModule` now uses the exact `fileURLToPath` comparison (matches `cron-dispatch.ts:75`).

- [ ] **Step 1: Confirm the existing test asserts no auto-start on import (the invariant)**

Run: `pnpm --filter @sh/knative-server test`
Expected: PASS (29 tests). The suite imports `startServer` from `server.ts`; it passes today because the guard is false under vitest. This run is the RED-equivalent baseline — after the change it must still pass (no port-bind on import).

- [ ] **Step 2: Add the `fileURLToPath` import**

In `packages/knative-server/src/server.ts`, add to the imports at the top (after line 2, `import { resolve as resolvePath } from "node:path";`):

```ts
import { fileURLToPath } from "node:url";
```

- [ ] **Step 3: Replace the `isMainModule` guard**

Replace lines 184-186:

```ts
const isMainModule =
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("knative-server");
```

with:

```ts
// Exact entrypoint match (matches cron-dispatch.ts / leaf-job.ts) — avoids a fragile substring
// match that would misfire for any argv path containing "knative-server".
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
```

- [ ] **Step 4: Verify the suite still passes (no auto-start on import)**

Run: `pnpm --filter @sh/knative-server test`
Expected: PASS (29 tests). If a test hangs or reports a port-in-use, the guard is wrong — revert and reconsider.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @sh/knative-server build` (or `pnpm --filter @sh/knative-server exec tsc --noEmit` if no build script)
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/knative-server/src/server.ts
git commit -s -m "refactor(server): Use exact fileURLToPath entrypoint idiom (matches cron-dispatch)"
```

---

## Task 3: securityContext hardening on leaf-worker + Knative service

**Files:**
- Modify: `deploy/knative/leaf-scaledjob.yaml`, `deploy/knative/service.yaml`, `deploy/knative/setup-kind.sh`

**Interfaces:** Kubernetes pod/container `securityContext`; Knative `config-features` flag `kubernetes.podspec-securitycontext`.

> **This task's deliverable (the manifest + flag edits) is reviewable statically; correctness is verified by the controller-run live gate in Step 6.** There is no unit test.

- [ ] **Step 1: Harden the leaf-worker `ScaledJob`**

In `deploy/knative/leaf-scaledjob.yaml`, under `spec.jobTargetRef.template.spec` add a pod-level `securityContext` (sibling of `restartPolicy`/`serviceAccountName`/`containers`):

```yaml
        restartPolicy: Never
        serviceAccountName: serverless-harness
        securityContext:
          runAsNonRoot: true
          runAsUser: 65532          # image has no USER (runs as root); runAsNonRoot alone would refuse to start
          fsGroup: 65532            # so uid 65532 can write the leaf-work /work PVC
          seccompProfile: { type: RuntimeDefault }
        containers:
          - name: leaf-job
```

Add a container-level `securityContext` to the `leaf-job` container (sibling of `command`/`resources`/`env`):

```yaml
            command: ["node", "--import", "tsx", "src/leaf-job.ts"]
            securityContext:
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true   # tsx/node + the Pi agent config write to /tmp (HOME below); fall back to false if a pod needs more
              capabilities: { drop: ["ALL"] }
```

Add `HOME=/tmp` to the container `env` (so the Pi agent's `getAgentDir()`/config writes land in the writable `/tmp` emptyDir, not the read-only root fs). Insert as the first env entry:

```yaml
            env:
              - name: HOME
                value: /tmp
              - name: REDIS_URL
```

Add a `/tmp` writable mount to `volumeMounts` and a `tmp` `emptyDir` to `volumes`:

```yaml
            volumeMounts:
              - name: work
                mountPath: /work
              - name: tmp
                mountPath: /tmp
        volumes:
          - name: work
            persistentVolumeClaim:
              claimName: leaf-work
          - name: tmp
            emptyDir: {}
```

- [ ] **Step 2: Harden the Knative service**

In `deploy/knative/service.yaml`, under `spec.template.spec` add a pod-level `securityContext` (sibling of `containerConcurrency`/`serviceAccountName`/`containers`):

```yaml
      containerConcurrency: 1
      timeoutSeconds: 300
      serviceAccountName: serverless-harness
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        fsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - image: dev.local/serverless-harness:local
```

Add the container-level `securityContext` (sibling of `ports`/`env`/`resources`):

```yaml
        - image: dev.local/serverless-harness:local
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          ports:
            - containerPort: 8080
```

Add `HOME=/tmp` as the first `env` entry:

```yaml
          env:
            - name: HOME
              value: /tmp
            - name: REDIS_URL
```

Add the `/tmp` mount + `tmp` emptyDir volume:

```yaml
          volumeMounts:
            - name: work
              mountPath: /work
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: work
          persistentVolumeClaim:
            claimName: leaf-work
            readOnly: false
        - name: tmp
          emptyDir: {}
```

- [ ] **Step 3: Enable the Knative securityContext feature flag in `setup-kind.sh`**

In `deploy/knative/setup-kind.sh`, extend the existing `config-features` patch (currently enabling the two PVC flags) to also enable `kubernetes.podspec-securitycontext`. Replace the patch's `--patch '{"data":{...}}'` value so it reads:

```bash
  --patch '{"data":{"kubernetes.podspec-persistent-volume-claim":"enabled","kubernetes.podspec-persistent-volume-write":"enabled","kubernetes.podspec-securitycontext":"enabled"}}'
```

(This stays a single idempotent `kubectl patch ... --type merge`.)

- [ ] **Step 4: Static validation (no cluster)**

Run: `for f in leaf-scaledjob service; do python3 -c "import yaml,sys; list(yaml.safe_load_all(open('deploy/knative/$f.yaml'))); print('YAML OK $f')"; done && bash -n deploy/knative/setup-kind.sh && echo "SH OK"`
Expected: `YAML OK leaf-scaledjob`, `YAML OK service`, `SH OK`. (If `python3`/`yaml` is unavailable, use `kubectl apply --dry-run=client -f` against each file once the cluster context is set in Step 6.)

- [ ] **Step 5: Commit the manifest changes**

```bash
git add deploy/knative/leaf-scaledjob.yaml deploy/knative/service.yaml deploy/knative/setup-kind.sh
git commit -s -m "chore(deploy): Harden leaf-worker + ksvc securityContext (non-root, drop caps, read-only rootfs)"
```

- [ ] **Step 6: (Controller-run) Live verification — rebuild, redeploy, gate**

> Run by the controller, NOT a subagent. Redirect verbose output to `/tmp/kagenti/registry-hardening/` and analyze in subagents per CLAUDE.md context budget.

```bash
export KUBECONFIG=~/.kube/config; kubectl config use-context kind-sh-knative
mkdir -p /tmp/kagenti/registry-hardening

# 1. Build WITH --load and VERIFY the image carries the server.ts change before loading:
docker buildx build --load -t dev.local/serverless-harness:local . > /tmp/kagenti/registry-hardening/build.log 2>&1; echo "build:$?"
docker run --rm --entrypoint sh dev.local/serverless-harness:local -c 'grep -c "fileURLToPath(import.meta.url)" /app/packages/knative-server/src/server.ts'
#   → must print 1 (NOT 0). If 0, the build did not load — do not proceed.
kind load docker-image dev.local/serverless-harness:local --name sh-knative > /tmp/kagenti/registry-hardening/load.log 2>&1; echo "load:$?"

# 2. Apply the feature flag + hardened manifests, recreate ksvc pods:
bash deploy/knative/setup-kind.sh > /tmp/kagenti/registry-hardening/setup.log 2>&1; echo "setup:$?"   # idempotent; applies the securitycontext flag
kubectl apply -f deploy/knative/service.yaml > /tmp/kagenti/registry-hardening/svc.log 2>&1; echo "svc:$?"
kubectl apply -f deploy/knative/leaf-scaledjob.yaml > /tmp/kagenti/registry-hardening/sj.log 2>&1; echo "sj:$?"
kubectl delete pod -n default -l serving.knative.dev/service=serverless-harness --ignore-not-found

# 3. Run the gate (all 6 claims must pass under the hardened pods):
GATE_LIVE_SMOKE=1 SH_MODEL=claude-haiku-4-5 bash deploy/knative/leaf-gate-smoke.sh > /tmp/kagenti/registry-hardening/smoke.log 2>&1; echo "SMOKE:$?"
grep -E "OK |FAIL|TIMEOUT|ALL GATE SMOKE" /tmp/kagenti/registry-hardening/smoke.log
```

Expected: `ALL GATE SMOKE CLAIMS PASSED`, `SMOKE:0`.

**If a pod CrashLoops or the gate fails on a securityContext cause** (read the pod's events/logs: `kubectl describe pod` / `kubectl logs`): diagnose which constraint broke it.
- Knative rejects the service securityContext field → confirm the flag patch applied (`kubectl get cm config-features -n knative-serving -o yaml | grep securitycontext`); if a specific field is still gated, enable the matching flag in `setup-kind.sh` and re-apply.
- `/work` write denied for uid 65532 → confirm `fsGroup: 65532` is present on the failing pod.
- Read-only rootfs error from the agent writing outside `/tmp` → set `readOnlyRootFilesystem: false` on **that pod only** (keep `true` on the other if it passed), add an inline comment `# agent writes to <path> on rootfs; read-only rootfs deferred for this pod`, re-commit (amend Step 5's commit or a new fixup commit), rebuild only if a manifest-only change (no rebuild needed for YAML), re-apply, and re-run the gate until green.

- [ ] **Step 7: Record the live result**

Append the gate outcome (and any `readOnlyRootFilesystem` fallback decision) to `.superpowers/sdd/progress.md`.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Registry update (Leaf-Session Backend BUILT table) | T1 |
| §2 `isMainModule` exact idiom + no-auto-start invariant | T2 |
| §3 securityContext: non-fs hardening (both pods), fsGroup, HOME=/tmp + /tmp emptyDir, readOnlyRootFilesystem empirical, Knative feature flag | T3 (Steps 1-3) |
| §4 Verification: buildx --load + verify-before-load, live gate 6/6, fallback on read-only-rootfs | T3 Step 6; T2 unit (no auto-start) |
| §5 Out of scope (no reclaimer tuning, no behavior change, only the two pods) | honored — no task touches runLeaf/queue/KEDA metadata/cron-dispatch/sandbox-0 |

No gaps.

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to". Every step shows the exact markdown/TS/YAML/commands. The one empirical branch (`readOnlyRootFilesystem` fallback) is a concrete, conditional instruction with the exact field + comment to write, not a placeholder.

**3. Consistency:** `runAsUser`/`fsGroup` `65532`, `seccompProfile: RuntimeDefault`, `capabilities: drop ["ALL"]`, `HOME=/tmp` + `tmp` emptyDir, and the `kubernetes.podspec-securitycontext` flag are identical across both pods and match the cron-dispatch baseline (`leaf-cron.yaml`). The `fileURLToPath(import.meta.url)` idiom matches `cron-dispatch.ts:75`. The build/verify command greps for the exact string introduced in T2.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
