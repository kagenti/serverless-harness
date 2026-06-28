# Scheduled Leaf Dispatch (Archetype C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Kubernetes `CronJob` "start signal" that, on each fire, dispatches a static, config-defined list of leaf sessions onto the **unchanged** async path (`POST /run-leaf {async:true}`), keyed by a fire identity so retries resume and each fire is a fresh run.

**Architecture:** A thin `cron-dispatch` entrypoint (same harness image) reads an item list from a mounted ConfigMap and its own Kubernetes Job name (the *fire id*, via the downward API), substitutes the fire id into each envelope's `sessionId`/`resultRef`, and POSTs each as `{async:true}` to the in-cluster Knative service. Everything downstream (the `leaf-queue`, KEDA `ScaledJob`, `runLeaf`, done-marker) is reused unchanged. A native `CronJob` is the discrete scheduler (KEDA's cron scaler is window-based and the wrong primitive).

**Tech Stack:** TypeScript (ESM, `tsx`, `noEmit`), pnpm workspaces, Node global `fetch`, vitest, Knative Serving + KEDA on Kind, Kubernetes `CronJob`/`ConfigMap`.

## Global Constraints

- **No change to the async contract, `leaf-queue`, KEDA `ScaledJob`, or `runLeaf`.** This slice is purely a new client of `POST /run-leaf {async:true}`. (spec §1, §2)
- **The harness makes no work-selection decisions.** The dispatched list is operator-supplied config; no dynamic ingestion / scanning. (spec §1 charter fit, §8)
- **Fire identity = the dispatcher pod's Kubernetes Job name**, read via the downward API label `metadata.labels['job-name']` (confirmed present on k8s v1.34). Stable across a Job's pod retries; unique per scheduled fire. (spec §3.2)
- **`__FIRE__`** is the only template token; the dispatcher replaces **every** occurrence in **every** string field of each envelope with the fire id; non-string / non-matching fields pass through verbatim. (spec §3.1)
- **Idempotency:** each fire = a fresh run (new Job name → new `sessionId`s, fire-stamped `resultRef`); a retried dispatcher re-POSTs identical `sessionId`s → idempotent resume/overwrite. (spec §3.3)
- **Dispatch success = HTTP `202` with body `status:"accepted"`.** On any non-`202`/error, log and continue the remaining items, then exit non-zero so the CronJob records a failed fire. All accepted → exit 0. No new envelope validation (the server returns `400` for malformed). (spec §3.4)
- **Reuse the harness image** (`dev.local/serverless-harness:local`); no new container image. The dispatcher reuses the existing `serverless-harness` ServiceAccount (no new RBAC). (spec §2, §8)
- **In-cluster invocation:** POST to the Knative service's cluster-local address `http://serverless-harness.default.svc.cluster.local` (no manual `Host` header needed — Knative routes the cluster-local host). This pins the address the spec §5 deferred to the plan and supersedes its tentative kourier-internal+Host suggestion.
- **DCO:** every commit uses `git commit -s`; no `Co-Authored-By`. Conventional-commit prefixes.
- Tests are vitest under `packages/knative-server/test/**/*.test.ts`. The dispatch logic is pure (injected `post`), so unit tests need no cluster and no Redis.

---

## File Structure

- `packages/knative-server/src/cron-dispatch.ts` — NEW. Exports the pure dispatch logic (`applyFire`, `dispatchAll`, `loadConfig`, `exitCodeFor`) + a guarded `main()` entrypoint (`buildPost` + env wiring).
- `packages/knative-server/test/cron-dispatch.test.ts` — NEW. Unit tests for the pure logic (injected `post`, temp-file config).
- `deploy/knative/leaf-cron.yaml` — NEW. Two `---`-separated docs: the `leaf-cron-config` ConfigMap (item list) and the `leaf-cron` CronJob (schedule + dispatcher pod).
- `deploy/knative/leaf-cron-smoke.sh` — NEW. Gated (`CRON_LIVE_SMOKE=1`) live gate.

---

### Task 1: `cron-dispatch` core logic (pure, unit-tested)

**Files:**
- Create: `packages/knative-server/src/cron-dispatch.ts`
- Test: `packages/knative-server/test/cron-dispatch.test.ts`

**Interfaces:**
- Produces:
  - `function applyFire(envelope: Record<string, unknown>, fireId: string): Record<string, unknown>` — returns a copy with every string value's `__FIRE__` occurrences replaced by `fireId`; non-string values pass through.
  - `function dispatchAll(items: Record<string, unknown>[], fireId: string, post: (env: Record<string, unknown>) => Promise<boolean>): Promise<{ total: number; accepted: number; failed: number }>` — for each item, `post({ ...applyFire(item, fireId), async: true })`; `true` → accepted, `false`/throw → failed; **always attempts every item**; returns the tally.
  - `function loadConfig(path: string): Record<string, unknown>[]` — `JSON.parse(readFileSync(path,"utf8")).items`; throws if the file is missing or `items` is not an array.
  - `function exitCodeFor(result: { failed: number }): number` — `result.failed > 0 ? 1 : 0`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/knative-server/test/cron-dispatch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyFire, dispatchAll, loadConfig, exitCodeFor } from "../src/cron-dispatch";

describe("applyFire", () => {
  it("substitutes every __FIRE__ occurrence in string fields and passes others through", () => {
    const out = applyFire(
      { sessionId: "nightly/__FIRE__/i1", resultRef: "/work/nightly/__FIRE__/results/i1.json", inputsRef: "/work/nightly/inputs/i1.json", model: "claude-haiku-4-5" },
      "fire-42",
    );
    expect(out).toEqual({
      sessionId: "nightly/fire-42/i1",
      resultRef: "/work/nightly/fire-42/results/i1.json",
      inputsRef: "/work/nightly/inputs/i1.json",
      model: "claude-haiku-4-5",
    });
  });
  it("does not mutate the input object", () => {
    const input = { sessionId: "s/__FIRE__" };
    applyFire(input, "f1");
    expect(input.sessionId).toBe("s/__FIRE__");
  });
});

describe("dispatchAll", () => {
  const ITEMS = [
    { sessionId: "n/__FIRE__/i1", resultRef: "/work/n/__FIRE__/i1.json" },
    { sessionId: "n/__FIRE__/i2", resultRef: "/work/n/__FIRE__/i2.json" },
  ];

  it("posts every item once with async:true and __FIRE__ substituted; all accepted", async () => {
    const seen: Record<string, unknown>[] = [];
    const post = vi.fn(async (env: Record<string, unknown>) => { seen.push(env); return true; });
    const r = await dispatchAll(ITEMS, "fire-1", post);
    expect(r).toEqual({ total: 2, accepted: 2, failed: 0 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatchObject({ sessionId: "n/fire-1/i1", resultRef: "/work/n/fire-1/i1.json", async: true });
    expect(seen[1]).toMatchObject({ sessionId: "n/fire-1/i2", async: true });
  });

  it("counts a rejected post as failed but still attempts the rest", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const r = await dispatchAll(ITEMS, "fire-1", post as any);
    expect(r).toEqual({ total: 2, accepted: 1, failed: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("counts a thrown post as failed and continues", async () => {
    const post = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(true);
    const r = await dispatchAll(ITEMS, "fire-1", post as any);
    expect(r).toEqual({ total: 2, accepted: 1, failed: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("posts nothing for an empty list", async () => {
    const post = vi.fn(async () => true);
    const r = await dispatchAll([], "fire-1", post);
    expect(r).toEqual({ total: 0, accepted: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("exitCodeFor", () => {
  it("returns 0 when nothing failed", () => { expect(exitCodeFor({ failed: 0 })).toBe(0); });
  it("returns 1 when any item failed", () => { expect(exitCodeFor({ failed: 1 })).toBe(1); });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cron-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it("reads the items array", () => {
    const p = join(dir, "schedule.json");
    writeFileSync(p, JSON.stringify({ items: [{ sessionId: "a" }, { sessionId: "b" }] }));
    expect(loadConfig(p)).toEqual([{ sessionId: "a" }, { sessionId: "b" }]);
  });
  it("throws when items is missing or not an array", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ nope: true }));
    expect(() => loadConfig(p)).toThrow();
  });
  it("throws when the file is missing", () => {
    expect(() => loadConfig(join(dir, "absent.json"))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knative-server exec vitest run test/cron-dispatch.test.ts`
Expected: FAIL — cannot find module `../src/cron-dispatch`.

- [ ] **Step 3: Write the implementation (pure logic + exports only — no `main()` yet)**

```typescript
// packages/knative-server/src/cron-dispatch.ts
import { readFileSync } from "node:fs";

/** Replace every __FIRE__ in each string field with fireId; non-strings pass through. Pure, non-mutating. */
export function applyFire(envelope: Record<string, unknown>, fireId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    out[k] = typeof v === "string" ? v.split("__FIRE__").join(fireId) : v;
  }
  return out;
}

/**
 * Dispatch every config item as an async leaf. Each item is fire-substituted and POSTed with
 * async:true via the injected `post` (returns true iff the dispatch was accepted). Every item is
 * attempted even if earlier ones fail; a thrown post counts as a failure.
 */
export async function dispatchAll(
  items: Record<string, unknown>[],
  fireId: string,
  post: (env: Record<string, unknown>) => Promise<boolean>,
): Promise<{ total: number; accepted: number; failed: number }> {
  let accepted = 0;
  let failed = 0;
  for (const item of items) {
    const env = { ...applyFire(item, fireId), async: true };
    try {
      (await post(env)) ? accepted++ : failed++;
    } catch {
      failed++;
    }
  }
  return { total: items.length, accepted, failed };
}

export function exitCodeFor(result: { failed: number }): number {
  return result.failed > 0 ? 1 : 0;
}

export function loadConfig(path: string): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed?.items)) throw new Error("cron config: 'items' must be an array");
  return parsed.items as Record<string, unknown>[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knative-server exec vitest run test/cron-dispatch.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the full knative-server suite to confirm no regression**

Run: `pnpm -C packages/knative-server exec vitest run`
Expected: PASS (existing 15 + 10 new = 25).

- [ ] **Step 6: Commit**

```bash
git add packages/knative-server/src/cron-dispatch.ts packages/knative-server/test/cron-dispatch.test.ts
git commit -s -m "feat(knative-server): cron-dispatch core (applyFire/dispatchAll/loadConfig)"
```

---

### Task 2: `cron-dispatch` entrypoint (`buildPost` + guarded `main`)

**Files:**
- Modify: `packages/knative-server/src/cron-dispatch.ts` (append `buildPost` + `main` + main-module guard)

**Interfaces:**
- Consumes: `applyFire`/`dispatchAll`/`loadConfig`/`exitCodeFor` (Task 1).
- Produces: a runnable entrypoint `node --import tsx src/cron-dispatch.ts` that reads `JOB_NAME` (fire id), `CRON_CONFIG` (config path), `SH_SERVICE_URL`, POSTs each item, logs a summary, and `process.exit(exitCodeFor(result))`. Not unit-tested (real `fetch`/env) — verified by the existing suite still importing cleanly + the Task 4 live gate, mirroring `leaf-job.ts`.

- [ ] **Step 1: Append the entrypoint to `cron-dispatch.ts`**

Append to `packages/knative-server/src/cron-dispatch.ts`:

```typescript
import { fileURLToPath } from "node:url";

/** Build the real POST function: fetch the in-cluster Knative service; accepted == 202 + {status:"accepted"}. */
function buildPost(): (env: Record<string, unknown>) => Promise<boolean> {
  const base = process.env.SH_SERVICE_URL ?? "http://serverless-harness.default.svc.cluster.local";
  return async (env) => {
    const res = await fetch(`${base}/run-leaf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    if (res.status !== 202) {
      console.error(`dispatch rejected: HTTP ${res.status}`);
      return false;
    }
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    return (body as Record<string, unknown>).status === "accepted";
  };
}

async function main(): Promise<void> {
  const fireId = process.env.JOB_NAME ?? `manual-${process.pid}`;
  const configPath = process.env.CRON_CONFIG ?? "/config/schedule.json";
  const items = loadConfig(configPath);
  const result = await dispatchAll(items, fireId, buildPost());
  console.log(`cron-dispatch: ${result.accepted}/${result.total} accepted, ${result.failed} failed (fire=${fireId})`);
  process.exit(exitCodeFor(result));
}

// Only run when invoked as the entrypoint (so tests can import the pure helpers above).
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error("cron-dispatch error:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify the suite still passes (no auto-run on import, no breakage)**

Run: `pnpm -C packages/knative-server exec vitest run`
Expected: PASS (25). The `isMainModule` guard means importing `cron-dispatch` in the test does NOT execute `main()` (no fetch/fs/exit during tests). If any test now hangs or the process exits, the guard is wrong — fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add packages/knative-server/src/cron-dispatch.ts
git commit -s -m "feat(knative-server): cron-dispatch entrypoint (POST async to in-cluster ksvc)"
```

---

### Task 3: `leaf-cron.yaml` — ConfigMap + CronJob (one manifest)

**Files:**
- Create: `deploy/knative/leaf-cron.yaml`

**Interfaces:**
- Consumes: the `cron-dispatch` entrypoint (Task 2), the `dev.local/serverless-harness:local` image, the `serverless-harness` ServiceAccount.
- Produces: a `leaf-cron-config` ConfigMap (the item list with `__FIRE__` templates) and a `leaf-cron` CronJob that runs the dispatcher per fire.

- [ ] **Step 1: Write the manifest**

```yaml
# deploy/knative/leaf-cron.yaml
# Archetype C: a CronJob that dispatches a static, config-defined list of leaf sessions onto the
# unchanged async path. Operator workflow: edit + `kubectl apply -f deploy/knative/leaf-cron.yaml`;
# fire on demand with `kubectl create job --from=cronjob/leaf-cron <name>`.
apiVersion: v1
kind: ConfigMap
metadata:
  name: leaf-cron-config
  namespace: default
data:
  schedule.json: |
    { "items": [
      { "sessionId": "nightly/__FIRE__/i1", "inputsRef": "/work/nightly/inputs/i1.json",
        "resultRef": "/work/nightly/__FIRE__/results/i1.json",
        "workspaceRef": "/workspace/nightly/repo", "model": "claude-haiku-4-5" },
      { "sessionId": "nightly/__FIRE__/i2", "inputsRef": "/work/nightly/inputs/i2.json",
        "resultRef": "/work/nightly/__FIRE__/results/i2.json",
        "workspaceRef": "/workspace/nightly/repo", "model": "claude-haiku-4-5" },
      { "sessionId": "nightly/__FIRE__/i3", "inputsRef": "/work/nightly/inputs/i3.json",
        "resultRef": "/work/nightly/__FIRE__/results/i3.json",
        "workspaceRef": "/workspace/nightly/repo", "model": "claude-haiku-4-5" }
    ] }
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: leaf-cron
  namespace: default
spec:
  schedule: "0 2 * * *"          # daily 02:00; operator edits to taste. Fire on demand via `kubectl create job --from`.
  concurrencyPolicy: Forbid       # don't start a new dispatcher while the previous fire's dispatcher runs
  jobTemplate:
    spec:
      backoffLimit: 1             # one retry of the dispatcher; idempotent because the fire id is stable
      template:
        spec:
          restartPolicy: Never
          serviceAccountName: serverless-harness
          containers:
            - name: cron-dispatch
              image: dev.local/serverless-harness:local
              imagePullPolicy: IfNotPresent
              workingDir: /app/packages/knative-server
              command: ["node", "--import", "tsx", "src/cron-dispatch.ts"]
              env:
                - name: JOB_NAME    # the fire id — stable across this Job's pod retries, unique per fire
                  valueFrom: { fieldRef: { fieldPath: "metadata.labels['job-name']" } }
                - name: CRON_CONFIG
                  value: /config/schedule.json
                - name: SH_SERVICE_URL
                  value: http://serverless-harness.default.svc.cluster.local
              volumeMounts:
                - name: config
                  mountPath: /config
              resources:
                requests: { memory: 128Mi, cpu: 50m }
                limits: { memory: 256Mi, cpu: 200m }
          volumes:
            - name: config
              configMap:
                name: leaf-cron-config
```

- [ ] **Step 2: Validate the manifest parses and is API-valid (no apply)**

Run: `python3 -c "import yaml; list(yaml.safe_load_all(open('deploy/knative/leaf-cron.yaml'))); print('YAML_OK')"`
Expected: `YAML_OK`.
Run: `KUBECONFIG=~/.kube/config kubectl apply --dry-run=server -f deploy/knative/leaf-cron.yaml`
Expected: `configmap/leaf-cron-config created (server dry run)` and `cronjob.batch/leaf-cron created (server dry run)` (validates the schedule expression and the downward-API fieldPath against the live API server). If the `job-name` label fieldPath is rejected, switch to `metadata.labels['batch.kubernetes.io/job-name']` and re-run.

- [ ] **Step 3: Commit**

```bash
git add deploy/knative/leaf-cron.yaml
git commit -s -m "feat(cron): leaf-cron CronJob + config for scheduled leaf dispatch"
```

> Live validation (real fire → dispatch → completion → idempotent retry) happens in Task 4.

---

### Task 4: Live gate — scheduled dispatch, completion, idempotent retry

**Files:**
- Create: `deploy/knative/leaf-cron-smoke.sh`

**Interfaces:**
- Consumes: everything above + the deployed async path (KEDA + ScaledJob) + `sandbox-0` + the `leaf-work` PVC + the existing `deploy/knative/fixtures/{inputs,repo}` + `lib.sh` (`NS`, `ok`, `ko`, `PASS`, `FAIL`).
- Produces: a gated pass/fail proving spec §6.2 claims 1–3.

- [ ] **Step 1: Write the gated smoke script**

```bash
# deploy/knative/leaf-cron-smoke.sh
#!/usr/bin/env bash
# Gated Kind smoke for scheduled leaf dispatch (Archetype C, design §6.2). Proves: the CronJob's
# dispatcher enqueues a config list onto the async path (leaves complete with correct verdicts) and
# a re-run of the SAME fire is idempotent (same fire-stamped paths, no second run dir).
# Deterministic: fires with `kubectl create job --from=cronjob/leaf-cron` (no waiting on a cron tick).
# Prereq: async path deployed (KEDA + ScaledJob); image rebuilt with cron-dispatch.ts; leaf-cron.yaml
#   applied; sandbox-0 + leaf-work PVC up.
# Usage: CRON_LIVE_SMOKE=1 bash deploy/knative/leaf-cron-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${CRON_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set CRON_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator; SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
FIRE="cronfire-$$"                       # the manual fire id (becomes the Job name → JOB_NAME label)
NRES="/work/nightly/$FIRE/results"        # fire-stamped result dir the config templates produce
ITEMS="i1 i2 i3"
declare -A EXPECT=( [i1]=FLAGGED [i2]=CLEAR [i3]=CLEAR )
trap 'kubectl -n "$NS" delete job "$FIRE" --force --grace-period=0 >/dev/null 2>&1 || true; kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/nightly" 2>/dev/null || true' EXIT
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
fire_and_wait() {  # create a Job named $FIRE from the cronjob, wait for the dispatcher to finish
  kubectl -n "$NS" delete job "$FIRE" --force --grace-period=0 >/dev/null 2>&1 || true
  kubectl -n "$NS" create job --from=cronjob/leaf-cron "$FIRE" >/dev/null
  kubectl -n "$NS" wait --for=condition=complete "job/$FIRE" --timeout=120s >/dev/null 2>&1 \
    || kubectl -n "$NS" wait --for=condition=failed "job/$FIRE" --timeout=5s >/dev/null 2>&1 || true
}

echo "=== Scheduled leaf dispatch smoke (fire=$FIRE) ==="
kubectl -n "$NS" wait --for=condition=Ready "pod/$ORCH" --timeout=90s >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$SBOX" --timeout=90s >/dev/null
for _ in $(seq 1 30); do oexec sh -c 'command -v jq >/dev/null' && break; sleep 2; done
# seed fixtures at the fixed paths the config references
oexec mkdir -p /work/nightly/inputs
kubectl -n "$NS" cp ./fixtures/inputs/. "$ORCH:/work/nightly/inputs"
kubectl -n "$NS" exec "$SBOX" -- mkdir -p /workspace/nightly/repo
kubectl -n "$NS" cp ./fixtures/repo/. "$SBOX:/workspace/nightly/repo"

# Claim 1: schedule validity (the CronJob exists / applied clean)
claim 1 "CronJob applied and present"
if kubectl -n "$NS" get cronjob leaf-cron >/dev/null 2>&1; then ok "leaf-cron CronJob present"; else ko "leaf-cron CronJob missing"; fi

# Claim 2: a fire dispatches the list; leaves complete with correct verdicts under the fire-stamped dir
claim 2 "Fire dispatches list; leaves complete with correct verdicts"
fire_and_wait
cov_ok=1
for id in $ITEMS; do
  got=""
  for _ in $(seq 1 60); do
    if oexec test -f "$NRES/$id.json.status"; then got=$(oexec sh -c "jq -r .status $NRES/$id.json.status"); break; fi
    sleep 5
  done
  v=$(oexec sh -c "jq -r .verdict $NRES/$id.json 2>/dev/null" 2>/dev/null || echo "")
  if [ "$got" = "done" ] && [ "$v" = "${EXPECT[$id]}" ]; then echo "    $id done verdict=$v"; else echo "    $id status=$got verdict=$v (want ${EXPECT[$id]})"; cov_ok=0; fi
done
[ "$cov_ok" = 1 ] && ok "all dispatched leaves completed with correct verdicts" || ko "missing/incorrect"

# Claim 3: re-running the SAME fire id is idempotent — same fire-stamped dir, no second run directory
claim 3 "Idempotent retry: same fire id → same paths, no duplicate run dir"
before=$(oexec sh -c 'ls -1d /work/nightly/cronfire-* 2>/dev/null | wc -l' | tr -d ' ')
fire_and_wait
after=$(oexec sh -c 'ls -1d /work/nightly/cronfire-* 2>/dev/null | wc -l' | tr -d ' ')
still_done=1
for id in $ITEMS; do
  s=$(oexec sh -c "jq -r .status $NRES/$id.json.status" 2>/dev/null || echo "")
  [ "$s" = "done" ] || still_done=0
done
if [ "$before" = "$after" ] && [ "$still_done" = 1 ]; then ok "re-fire reused id (dirs: $before→$after), markers still done"; else ko "dirs $before→$after still_done=$still_done"; fi

echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "CRON SMOKE FAIL"; exit 1; else echo "CRON SMOKE PASS"; exit 0; fi
```

- [ ] **Step 2: Make executable and syntax-check; confirm the gate is honored**

Run: `chmod +x deploy/knative/leaf-cron-smoke.sh && bash -n deploy/knative/leaf-cron-smoke.sh && echo SYNTAX_OK`
Expected: `SYNTAX_OK`.
Run: `bash deploy/knative/leaf-cron-smoke.sh; echo "EXIT:$?"`
Expected: prints `SKIP (set CRON_LIVE_SMOKE=1)` and `EXIT:0`.

- [ ] **Step 3: Rebuild image (adds cron-dispatch.ts), apply, run the live gate**

Redirect verbose output to logs (CLAUDE.md context-budget); analyze failures in a subagent.

```bash
export LOG_DIR=/tmp/kagenti/leaf-cron; mkdir -p $LOG_DIR
# rebuild + reload so the image contains src/cron-dispatch.ts
docker build --load -t dev.local/serverless-harness:local . > $LOG_DIR/build.log 2>&1 && kind load docker-image dev.local/serverless-harness:local --name sh-knative >> $LOG_DIR/build.log 2>&1; echo "build:EXIT:$?"
# apply the cron manifest (ConfigMap + CronJob) and ensure the async path + sandbox are present
kubectl apply -f deploy/knative/leaf-cron.yaml > $LOG_DIR/apply.log 2>&1; echo "apply:EXIT:$?"
kubectl apply -f deploy/knative/leaf-scaledjob.yaml -f deploy/knative/leaf-pvc.yaml -f deploy/knative/leaf-orchestrator.yaml >> $LOG_DIR/apply.log 2>&1
CRON_LIVE_SMOKE=1 bash deploy/knative/leaf-cron-smoke.sh > $LOG_DIR/smoke.log 2>&1; echo "smoke:EXIT:$?"
```

Expected: `/tmp/kagenti/leaf-cron/smoke.log` ends with `CRON SMOKE PASS` (3 claims). If a claim fails, analyze the log + the dispatcher pod log (`kubectl logs job/cronfire-<pid>`) + `kubectl get jobs,pods -l scaledjob.keda.sh/name=leaf-worker` in a subagent — do not read whole logs in the main context. (The dispatcher pod's own log shows the per-item accept/reject summary.)

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/leaf-cron-smoke.sh
git commit -s -m "test(cron): gated live smoke — scheduled dispatch, completion, idempotent retry"
```

---

## Self-Review

**Spec coverage (design §1–§9):**
- §2 architecture (CronJob → dispatcher → POST async → unchanged path) → Tasks 2 (entrypoint) + 3 (CronJob). ✓
- §3.1 config (ConfigMap, `__FIRE__` template, co-located with CronJob) → Task 3 manifest + Task 1 `applyFire`/`loadConfig`. ✓
- §3.2 fire id = Job name via downward API → Task 3 env `JOB_NAME` + Task 2 `main`. ✓
- §3.3 idempotency (fresh run per fire, retried dispatcher resumes) → Task 1 substitution (stable per fire id) + Task 4 Claim 3 (live proof). ✓
- §3.4 dispatch result → exit code (202+accepted = success; non-202 continue+exit non-zero) → Task 1 `dispatchAll`/`exitCodeFor` + Task 2 `buildPost`. ✓
- §4 CronJob-not-KEDA-cron → Task 3 (native CronJob). ✓
- §5 in-cluster invocation (cluster-local ksvc URL) → Task 2 `buildPost` default + Global Constraints. ✓
- §6.1 unit coverage → Task 1 (10 tests). §6.2 live gate (3 claims) → Task 4. ✓
- §7 non-precluding extension → no code (config shape already supports it). §8 scope/YAGNI; §9 prereqs (no setup-kind change) → honored (no new install). ✓

**Placeholder scan:** none — every code/YAML/command step is concrete. The Task 3 dry-run names the exact fallback (`batch.kubernetes.io/job-name`) if the `job-name` fieldPath is rejected.

**Type consistency:** `applyFire`/`dispatchAll`/`loadConfig`/`exitCodeFor` signatures defined in Task 1 are consumed unchanged by Task 2's `main`. The `post` abstraction (`(env) => Promise<boolean>`) is produced by `buildPost` (Task 2) and injected into `dispatchAll` (Task 1) — same shape. `JOB_NAME`/`CRON_CONFIG`/`SH_SERVICE_URL` env names match between Task 2 (`main`/`buildPost`) and Task 3 (CronJob env). The config item field names (`sessionId`/`inputsRef`/`resultRef`/`workspaceRef`/`model`) and the `__FIRE__` token match between Task 1 tests, Task 3 ConfigMap, and Task 4's expected `resultRef` path (`/work/nightly/$FIRE/results/$id.json`).

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
