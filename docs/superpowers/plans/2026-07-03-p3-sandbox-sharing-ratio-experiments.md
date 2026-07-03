# P3 Sandbox Sharing-Ratio Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on the runc runtime, the per-sandbox concurrency knee that sets `KAGENTI_SANDBOX_CAP` and the derived harness→sandbox provisioning ratio N, and validate live that mixed-ref converge on a shared pod stays commit-consistent.

**Architecture:** Two experiments (E6 saturation curve, E7 converge contention + mixed-ref correctness) plus a feed-back check, driven by gated bash scripts against a hermetic in-cluster git-daemon load substrate. A tiny env-gated exec-timing hook in the sandbox transport lets a C=1 run compute the per-leaf duty cycle. Pure analysis functions (knee detection, duty cycle, floor gate, ref-consistency) are unit-tested in the `@sh/experiments` vitest workspace; the live drivers record authoritative numbers to `EXPERIMENTS.md`. No change to the harness model loop, lease protocol, or converge logic — P3 measures the P2 mechanism, it does not alter it.

**Tech Stack:** TypeScript (ESM, vitest 2.x) for `@sh/k8s-sandbox` and `@sh/experiments`; bash + `kubectl` + `jq` + `awk` for the `deploy/knative/` drivers reusing `lib.sh`; agent-sandbox `v1beta1` `Sandbox` CRs; Knative Serving; Redis (`RedisLeaseStore`); `git daemon` for the load substrate.

## Global Constraints

- **Commits:** DCO sign-off on every commit (`git commit -s`). Attribution trailer `Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>` — **never** `Co-authored-by`.
- **Staging:** never `git add -A`. Stage explicit paths only (the tree carries intentionally-dirty `experiments/RESULTS.md` and `.worktrees/`).
- **Branch:** all work on `docs/p3-sandbox-sharing-experiments` (already created off `main`; this plan and the spec are already committed there).
- **Feature-off-by-default:** the exec-timing hook is gated by `KAGENTI_EXEC_TIMING=1`, **off by default** — it must not change production behavior when unset.
- **Model:** `SH_MODEL=claude-haiku-4-5` for all live leaf runs.
- **Live gating:** live drivers no-op unless their gate env var is set (`E6_LIVE=1` / `E7_LIVE=1`), mirroring the existing `LEAF_LIVE_SMOKE` / `SH_RUN_LIVE` pattern.
- **Cluster order (spec D5):** develop on Kind `sh-knative` (standing 3-pod pool); take authoritative numbers on live OCP 4.20 (`KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig`).
- **Context budget:** redirect long command output to `/tmp/sh/*.log`; analyze via subagents, never read large logs inline.
- **Exact converge paths (do not drift):** shared repo `/workspace/repo`, per-pod lock `/workspace/.sh-fetch.lock`, per-leaf worktree `/workspace/leaves/<runId>`. `/runs` body is a `LeafEnvelope`; the converge path activates only when **both** `repoUrl` and `ref` are set and a sandbox is selected.

---

## File Structure

**New files:**
- `experiments/src/sharing.ts` — pure analysis: knee detection, duty cycle, derived ratio, sanity-floor gate, worktree/ref consistency, cap-respect check. One responsibility: turn raw experiment samples into verdicts + reportable numbers.
- `experiments/test/e6-saturation-structural.test.ts` — unit tests for the E6 analysis (knee + duty cycle + floor) on synthetic series.
- `experiments/test/e7-converge-contention-structural.test.ts` — unit tests for E7 analysis (ref-consistency) + a real-Redis never-over-cap assertion via `RedisLeaseStore`.
- `deploy/knative/gitd.yaml` — in-cluster git-daemon Deployment + Service serving a seeded bare repo with K refs.
- `deploy/knative/e6-saturation.sh` — E6 driver (ladder sweep + C=1 duty cycle + knee + floor gate + feed-back check).
- `deploy/knative/e7-converge-contention.sh` — E7 driver (mixed-ref converge + contention profile + correctness gate + never-over-cap).

**Modified files:**
- `packages/k8s-sandbox/src/exec.ts` — add env-gated exec-timing emission (2 pure helpers + wiring).
- `packages/k8s-sandbox/test/exec.test.ts` — tests for the 2 new pure helpers.
- `deploy/knative/lib.sh` — new shared helpers (git-daemon deploy/wait, concurrent-leaf launcher, exec-timing capture, sandbox CPU sampler, pool-spread check).
- `deploy/knative/setup-kind.sh` — issue #54: apply `sandbox-pool.yaml` (not `sandbox.yaml`) and wait for all N pool pods.
- `deploy/knative/kustomization.yaml` and `deploy/knative/overlays/ocp/kustomization.yaml` — add `gitd.yaml` to resources.
- `deploy/knative/EXPERIMENTS.md` — add the "P3 — sandbox sharing" results section (scaffold + how-to; filled by driver runs).
- `experiments/RESULTS.md` — add a short P3 pointer section (authoritative numbers live in `EXPERIMENTS.md`).

---

## Task 1: Env-gated exec-timing hook

Adds an off-by-default per-exec timing line to the sandbox transport so a C=1 run can sum sandbox-busy time. Two pure helpers (unit-tested) plus wiring into the existing `close` handler.

**Files:**
- Modify: `packages/k8s-sandbox/src/exec.ts`
- Test: `packages/k8s-sandbox/test/exec.test.ts`

**Interfaces:**
- Consumes: `K8sSandboxConfig` (has `.pod`, `.namespace`), the existing `kubectlExecInPod` closure.
- Produces: `shouldEmitExecTiming(env: NodeJS.ProcessEnv): boolean`; `formatExecTiming(pod: string, ms: number, command: string): string` (single line, newline-terminated, format `[exec-timing] pod=<pod> ms=<ms> cmd=<first 60 chars, newlines→spaces>`).

- [ ] **Step 1: Write the failing test**

Add to `packages/k8s-sandbox/test/exec.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldEmitExecTiming, formatExecTiming } from "../src/exec.js";

describe("exec timing (env-gated)", () => {
  it("is off unless KAGENTI_EXEC_TIMING=1", () => {
    expect(shouldEmitExecTiming({})).toBe(false);
    expect(shouldEmitExecTiming({ KAGENTI_EXEC_TIMING: "0" })).toBe(false);
    expect(shouldEmitExecTiming({ KAGENTI_EXEC_TIMING: "1" })).toBe(true);
  });

  it("formats a single stable line, truncating and flattening the command", () => {
    const line = formatExecTiming("sandbox-1", 42, "git -C /workspace/repo fetch\norigin branch-0");
    expect(line).toBe(
      "[exec-timing] pod=sandbox-1 ms=42 cmd=git -C /workspace/repo fetch origin branch-0\n",
    );
    const long = formatExecTiming("p", 1, "x".repeat(200));
    expect(long).toBe(`[exec-timing] pod=p ms=1 cmd=${"x".repeat(60)}\n`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/k8s-sandbox && npx vitest run test/exec.test.ts -t "exec timing"`
Expected: FAIL — `shouldEmitExecTiming is not a function` (not yet exported).

- [ ] **Step 3: Add the two pure helpers to `exec.ts`**

Insert after the `buildKubectlArgs` function (after line 26):

```typescript
/** True only when exec timing is explicitly enabled (off by default). */
export function shouldEmitExecTiming(env: NodeJS.ProcessEnv): boolean {
  return env.KAGENTI_EXEC_TIMING === "1";
}

/** One stable, newline-terminated timing line for a single exec. */
export function formatExecTiming(pod: string, ms: number, command: string): string {
  const cmd = command.slice(0, 60).replace(/\s+/g, " ");
  return `[exec-timing] pod=${pod} ms=${ms} cmd=${cmd}\n`;
}
```

- [ ] **Step 4: Wire timing into the `close` handler**

In `kubectlExecInPod`, capture a start timestamp right after `spawn` (after line 34, before `const out: Buffer[] = [];`):

```typescript
      const startMs = Date.now();
```

Then in the `child.on("close", ...)` success branch, replace the single resolve line (line 70) so timing is emitted just before resolving on a clean exit:

```typescript
        if (timedOut) return reject(new Error(`timeout:${opts.timeout}`));
        if (shouldEmitExecTiming(process.env)) {
          process.stderr.write(formatExecTiming(config.pod, Date.now() - startMs, command));
        }
        resolve({ stdout: Buffer.concat(out), exitCode: code });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/k8s-sandbox && npx vitest run test/exec.test.ts`
Expected: PASS (all existing tests plus the two new cases).

- [ ] **Step 6: Commit**

```bash
git add packages/k8s-sandbox/src/exec.ts packages/k8s-sandbox/test/exec.test.ts
git commit -s -m "feat: Add env-gated per-exec timing to the sandbox transport

Off by default (KAGENTI_EXEC_TIMING=1). Emits one [exec-timing] line per exec
to stderr so a C=1 experiment run can sum sandbox-busy time and derive the
per-leaf duty cycle. No production behavior change when unset.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 2: E6 analysis functions + structural test

Pure functions that turn a saturation sweep into a knee (recommended CAP), a duty cycle, a derived ratio N, and a pass/fail floor verdict.

**Files:**
- Create: `experiments/src/sharing.ts`
- Test: `experiments/test/e6-saturation-structural.test.ts`

**Interfaces:**
- Produces:
  - `interface LadderPoint { c: number; throughput: number; p95Ms: number }`
  - `detectKnee(points: LadderPoint[], degradeX: number): number` — highest `c` whose `p95Ms <= degradeX * baselineP95` (baseline = the `c===1` point) AND whose throughput is still rising vs the previous point; returns that `c` (the recommended CAP). Throws if no `c===1` baseline point is present.
  - `dutyCycle(execBusyMs: number, wallMs: number): number` — `execBusyMs / wallMs`, clamped to `(0, 1]`; throws on `wallMs <= 0`.
  - `derivedRatio(duty: number): number` — `1 / duty` rounded to 1 decimal; throws on `duty <= 0`.
  - `sanityFloorPass(knee: number, minConcurrency: number): boolean` — `knee >= minConcurrency`.

- [ ] **Step 1: Write the failing test**

Create `experiments/test/e6-saturation-structural.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  detectKnee,
  dutyCycle,
  derivedRatio,
  sanityFloorPass,
  type LadderPoint,
} from "../src/sharing";

describe("E6 — saturation analysis (structural)", () => {
  // Throughput rises then plateaus; p95 stays flat then blows up past the knee.
  const series: LadderPoint[] = [
    { c: 1, throughput: 1.0, p95Ms: 1000 },
    { c: 2, throughput: 1.9, p95Ms: 1050 },
    { c: 4, throughput: 3.6, p95Ms: 1200 },
    { c: 8, throughput: 5.0, p95Ms: 1900 },
    { c: 16, throughput: 5.1, p95Ms: 4200 }, // plateau + latency blowup
  ];

  it("detects the knee as the last still-scaling point within the latency bound", () => {
    // degradeX=2 => p95 bound = 2000ms; c=16 exceeds it and throughput plateaued.
    expect(detectKnee(series, 2)).toBe(8);
  });

  it("throws when there is no c=1 baseline", () => {
    expect(() => detectKnee([{ c: 2, throughput: 1, p95Ms: 1 }], 2)).toThrow(/baseline/);
  });

  it("computes duty cycle and derived ratio", () => {
    expect(dutyCycle(250, 1000)).toBeCloseTo(0.25, 5);
    expect(derivedRatio(0.25)).toBe(4.0);
    expect(() => dutyCycle(1, 0)).toThrow();
    expect(() => derivedRatio(0)).toThrow();
  });

  it("caps duty cycle at 1 and enforces the sanity floor", () => {
    expect(dutyCycle(1500, 1000)).toBe(1);
    expect(sanityFloorPass(8, 4)).toBe(true);
    expect(sanityFloorPass(2, 4)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd experiments && npx vitest run test/e6-saturation-structural.test.ts`
Expected: FAIL — cannot resolve `../src/sharing`.

- [ ] **Step 3: Implement `experiments/src/sharing.ts` (E6 portion)**

```typescript
export interface LadderPoint {
  c: number;          // concurrent leaves at this rung
  throughput: number; // aggregate leaves/sec
  p95Ms: number;      // per-leaf p95 latency at this rung
}

/**
 * The knee = the highest concurrency that is still "healthy": p95 within
 * `degradeX` of the single-leaf baseline AND throughput still rising vs the
 * previous rung. That c is the recommended KAGENTI_SANDBOX_CAP.
 */
export function detectKnee(points: LadderPoint[], degradeX: number): number {
  const baseline = points.find((p) => p.c === 1);
  if (!baseline) throw new Error("detectKnee: no c=1 baseline point");
  const bound = baseline.p95Ms * degradeX;
  const sorted = [...points].sort((a, b) => a.c - b.c);
  let knee = 1;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    const withinLatency = cur.p95Ms <= bound;
    const stillScaling = cur.throughput > prev.throughput;
    if (withinLatency && stillScaling) knee = cur.c;
    else break;
  }
  return knee;
}

/** Fraction of wall-clock the sandbox was busy on this leaf's execs; in (0, 1]. */
export function dutyCycle(execBusyMs: number, wallMs: number): number {
  if (wallMs <= 0) throw new Error("dutyCycle: wallMs must be > 0");
  return Math.min(1, execBusyMs / wallMs);
}

/** How many such leaves time-share one sandbox before it is continuously busy. */
export function derivedRatio(duty: number): number {
  if (duty <= 0) throw new Error("derivedRatio: duty must be > 0");
  return Math.round((1 / duty) * 10) / 10;
}

/** CI floor: one sandbox must sustain at least `minConcurrency` healthy leaves. */
export function sanityFloorPass(knee: number, minConcurrency: number): boolean {
  return knee >= minConcurrency;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd experiments && npx vitest run test/e6-saturation-structural.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add experiments/src/sharing.ts experiments/test/e6-saturation-structural.test.ts
git commit -s -m "feat: Add E6 saturation analysis (knee, duty cycle, derived ratio, floor)

Pure functions the E6 driver uses to turn a concurrency sweep into a recommended
KAGENTI_SANDBOX_CAP (the knee), a per-leaf duty cycle, and the derived N ratio,
guarded by a CI sanity floor.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 3: E7 analysis (ref-consistency) + real-Redis never-over-cap test

Adds the mixed-ref correctness checker to `sharing.ts` and a structural test that also proves, against real Redis, that the existing `RedisLeaseStore` never grants more than the cap.

**Files:**
- Modify: `experiments/src/sharing.ts`
- Test: `experiments/test/e7-converge-contention-structural.test.ts`

**Interfaces:**
- Consumes: `RedisLeaseStore` from `@sh/harness/sandbox-lease` (methods `acquire(pod, cap, runId, ttlMs)`, `load(pod)`, `release(pod, runId)`; key `sh:sandbox:<pod>:leases`).
- Produces:
  - `interface LeafObservation { runId: string; expectedRef: string; observedMarker: string }`
  - `worktreeConsistent(obs: LeafObservation[]): { ok: boolean; mismatches: LeafObservation[] }` — every leaf's `observedMarker` must equal its `expectedRef` (proves each worktree pinned its own commit; no cross-contamination).

- [ ] **Step 1: Write the failing test**

Create `experiments/test/e7-converge-contention-structural.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { worktreeConsistent, type LeafObservation } from "../src/sharing";
import { RedisLeaseStore, leaseKey } from "@sh/harness/sandbox-lease";

describe("E7 — mixed-ref consistency (structural)", () => {
  it("passes when every leaf observed its own ref, fails on cross-contamination", () => {
    const good: LeafObservation[] = [
      { runId: "a", expectedRef: "branch-0", observedMarker: "branch-0" },
      { runId: "b", expectedRef: "branch-1", observedMarker: "branch-1" },
    ];
    expect(worktreeConsistent(good).ok).toBe(true);

    const bad: LeafObservation[] = [
      { runId: "a", expectedRef: "branch-0", observedMarker: "branch-0" },
      { runId: "b", expectedRef: "branch-1", observedMarker: "branch-0" }, // leaked sibling ref
    ];
    const r = worktreeConsistent(bad);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].runId).toBe("b");
  });
});

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
describe("E7 — lease never exceeds cap (structural, real Redis)", () => {
  const store = new RedisLeaseStore(REDIS);
  const pod = `e7-cap-test-${process.pid}`;
  afterAll(async () => {
    // best-effort cleanup of the test pod's lease set
    // (RedisLeaseStore has no delete-key; release each member we added)
    for (const id of ["r0", "r1", "r2", "r3", "r4"]) await store.release(pod, id);
  });

  it("grants at most `cap` concurrent leases", async () => {
    const cap = 3;
    const results: boolean[] = [];
    for (const id of ["r0", "r1", "r2", "r3", "r4"]) {
      results.push(await store.acquire(pod, cap, id, 60_000));
    }
    expect(results.filter(Boolean).length).toBe(cap); // exactly 3 granted, 2 refused
    expect(await store.load(pod)).toBe(cap);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Start Redis if needed: `docker run -d --rm -p 6379:6379 --name sh-redis redis:7 >/dev/null 2>&1 || true`
Run: `cd experiments && npx vitest run test/e7-converge-contention-structural.test.ts`
Expected: FAIL — `worktreeConsistent` is not exported.

- [ ] **Step 3: Add `worktreeConsistent` to `experiments/src/sharing.ts`**

Append:

```typescript
export interface LeafObservation {
  runId: string;
  expectedRef: string;   // the ref this leaf's envelope pinned
  observedMarker: string; // marker.txt content read from its worktree
}

/** Every leaf must have seen its own ref's marker — no sibling leakage. */
export function worktreeConsistent(obs: LeafObservation[]): {
  ok: boolean;
  mismatches: LeafObservation[];
} {
  const mismatches = obs.filter((o) => o.observedMarker !== o.expectedRef);
  return { ok: mismatches.length === 0, mismatches };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd experiments && npx vitest run test/e7-converge-contention-structural.test.ts`
Expected: PASS (both describes). If the real-Redis block errors on connection, ensure Redis is running (Step 2).

- [ ] **Step 5: Commit**

```bash
git add experiments/src/sharing.ts experiments/test/e7-converge-contention-structural.test.ts
git commit -s -m "feat: Add E7 mixed-ref consistency check + real-Redis never-over-cap test

worktreeConsistent asserts each leaf observed only its own ref's marker (no
cross-contamination on a shared pod). The real-Redis test pins the P2 lease
invariant: RedisLeaseStore grants at most cap concurrent leases.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 4: In-cluster git-daemon load substrate

A hermetic `git://` server seeded with K refs, reachable by every pool pod, so leaves converge without GitHub egress.

**Files:**
- Create: `deploy/knative/gitd.yaml`
- Modify: `deploy/knative/kustomization.yaml`, `deploy/knative/overlays/ocp/kustomization.yaml`

**Interfaces:**
- Produces: Service `gitd` (port 9418) → repo URL `git://gitd.<ns>.svc:9418/repo.git`, with refs `branch-0 … branch-{K-1}`; each ref's `marker.txt` contains exactly its branch name (e.g. `branch-2`). `E6_REFS`/`E7_REFS` drivers assume `K >= 16`.

- [ ] **Step 1: Create `deploy/knative/gitd.yaml`**

```yaml
# deploy/knative/gitd.yaml
# Hermetic in-cluster git-daemon load substrate for the P3 sharing-ratio experiments.
# Seeds a bare repo with K refs (branch-0..branch-{K-1}); each ref's marker.txt holds its
# own branch name so E7 can assert per-leaf commit consistency. Reachable pool-wide over
# git:// so mixed-ref converge works across all sandboxes. Read-only, disposable.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gitd
  namespace: default
  labels: { app: gitd }
spec:
  replicas: 1
  selector: { matchLabels: { app: gitd } }
  template:
    metadata: { labels: { app: gitd } }
    spec:
      containers:
        - name: gitd
          image: alpine/git:2.45.2
          command: ["/bin/sh", "-c"]
          args:
            - |
              set -eu
              K="${GITD_REFS:-16}"
              R=/srv/git/repo.git
              mkdir -p "$R"
              git init --bare -q "$R"
              W=/tmp/seed
              rm -rf "$W"; git clone -q "$R" "$W"
              cd "$W"
              git config user.email seed@gitd.local
              git config user.name seed
              i=0
              while [ "$i" -lt "$K" ]; do
                git checkout -q --orphan "branch-$i" || git checkout -q -b "branch-$i"
                git rm -rq --cached . 2>/dev/null || true
                printf 'branch-%s' "$i" > marker.txt
                git add marker.txt
                git commit -qm "branch-$i marker"
                git push -q origin "branch-$i"
                i=$((i + 1))
              done
              # Serve read-only; upload-pack (fetch) is enabled by --export-all.
              exec git daemon --reuseaddr --verbose --export-all \
                --base-path=/srv/git --listen=0.0.0.0 --port=9418 /srv/git
          env:
            - name: GITD_REFS
              value: "16"
          ports:
            - containerPort: 9418
          resources:
            requests: { memory: "32Mi", cpu: "25m" }
            limits: { memory: "128Mi" }
      # No securityContext override: the OCP overlay's non-root SCC applies namespace-wide;
      # git-daemon and git init run fine as an arbitrary non-root UID against /srv/git + /tmp.
---
apiVersion: v1
kind: Service
metadata:
  name: gitd
  namespace: default
spec:
  selector: { app: gitd }
  ports:
    - name: git
      port: 9418
      targetPort: 9418
```

- [ ] **Step 2: Add `gitd.yaml` to the base kustomization**

In `deploy/knative/kustomization.yaml`, extend the `resources:` list:

```yaml
resources:
  - redis.yaml
  - sandbox-pool.yaml
  - service.yaml
  - gitd.yaml
```

- [ ] **Step 3: Add `gitd.yaml` to the OCP overlay**

In `deploy/knative/overlays/ocp/kustomization.yaml`, extend the `resources:` list:

```yaml
resources:
  - ../../redis.yaml
  - ../../sandbox-pool.yaml
  - ../../service.yaml
  - ../../gitd.yaml
```

- [ ] **Step 4: Validate the manifests render**

Run: `cd deploy/knative && kubectl kustomize . > /tmp/sh/kustomize-base.log 2>&1; echo "EXIT:$?"` then `kubectl kustomize overlays/ocp > /tmp/sh/kustomize-ocp.log 2>&1; echo "EXIT:$?"`
Expected: EXIT:0 for both. Confirm `gitd` Deployment + Service appear: `grep -c "kind: Deployment" /tmp/sh/kustomize-base.log` ≥ 1.

- [ ] **Step 5: Commit**

```bash
git add deploy/knative/gitd.yaml deploy/knative/kustomization.yaml deploy/knative/overlays/ocp/kustomization.yaml
git commit -s -m "feat: Add in-cluster git-daemon load substrate for P3 experiments

Hermetic git:// server seeded with K refs (branch-i/marker.txt=branch-i),
reachable pool-wide so mixed-ref converge works across sandboxes without GitHub
egress. Wired into the base and OCP kustomizations.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 5: Shared bash helpers in `lib.sh`

Reusable helpers for the E6/E7 drivers. Verified by `shellcheck` (bash has no unit harness here); live behavior is exercised in Tasks 6–8 and the gated run (Task 10).

**Files:**
- Modify: `deploy/knative/lib.sh`

**Interfaces (new functions, appended after `pod_seconds_from`):**
- `gitd_repo_url` → echoes `git://gitd.${NS}.svc:9418/repo.git`.
- `wait_gitd [timeout]` → waits until the `gitd` Deployment is Available; returns non-zero on timeout.
- `dispatch_converge <sessionId> <item_id> <file> <pattern> <ref> [model]` → POST `/runs` with a **converge-path** envelope (`repoUrl`+`ref`, no `workspaceRef`); echoes terminal JSON.
- `pod_cpu_seconds <pod>` → echoes cumulative container CPU-seconds for `pod` from `kubectl top` is too coarse; instead reads cgroup `cpuacct`/`cpu.stat` via exec (implementation below).
- `sum_exec_ms <harness_pod>` → sums `ms=` from `[exec-timing]` lines in the harness pod log.
- `pool_pod_counts` → echoes, one per line, `<pod> <activeLeaseCount>`-style Running pool pods (for spread checks): here just lists Running pool pod names.

- [ ] **Step 1: Append the helpers to `deploy/knative/lib.sh`**

```bash
# --- P3 sharing-ratio experiment helpers ---------------------------------------------------

# The hermetic git-daemon repo URL (see deploy/knative/gitd.yaml).
gitd_repo_url() { echo "git://gitd.${NS}.svc:9418/repo.git"; }

# Wait until the gitd Deployment is Available. Arg: timeout seconds (default 120).
wait_gitd() {
  kubectl -n "$NS" rollout status deploy/gitd --timeout="${1:-120}s" >/dev/null 2>&1
}

# POST /runs with a P2 converge-path envelope (repoUrl+ref => sandbox converges + worktrees).
# Usage: dispatch_converge <sessionId> <item_id> <file> <pattern> <ref> [model]
dispatch_converge() {
  local sid="$1" id="$2" file="$3" pat="$4" ref="$5" model="${6:-${SH_MODEL:-claude-haiku-4-5}}"
  local body
  body=$(jq -nc --arg s "$sid" --arg id "$id" --arg f "$file" --arg p "$pat" \
    --arg u "$(gitd_repo_url)" --arg r "$ref" --arg m "$model" \
    '{sessionId:$s, item:{item_id:$id, file:$f, pattern:$p}, repoUrl:$u, ref:$r, model:$m}')
  # shellcheck disable=SC2086
  curl -s $CURL_OPTS --max-time 240 ${CURL_HDR[@]+"${CURL_HDR[@]}"} \
    -H "Content-Type: application/json" -d "$body" "$BASE/runs"
}

# Sum ms= from [exec-timing] lines in a harness pod's log (needs KAGENTI_EXEC_TIMING=1).
# Usage: sum_exec_ms <harness_pod>
sum_exec_ms() {
  kubectl -n "$NS" logs "$1" 2>/dev/null \
    | awk -F'ms=' '/\[exec-timing\]/ {split($2,a," "); s+=a[1]} END{printf "%d", s+0}'
}

# List Running pool pod names (one per line). Pool selector defaults to the P2 label.
pool_pod_counts() {
  kubectl get pods -n "$NS" -l "${KAGENTI_SANDBOX_POOL_SELECTOR:-sh.kagenti.io/sandbox-pool=default}" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | awk '{print $1}'
}

# Max active leases observed on any single pool pod, read from Redis in the redis pod.
# Usage: max_leases_across_pool   (needs a redis pod reachable as deploy/pod "redis")
max_leases_across_pool() {
  local now; now=$(date +%s%3N)
  local max=0
  for pod in $(pool_pod_counts); do
    local n
    n=$(kubectl -n "$NS" exec deploy/redis -- \
      redis-cli ZCOUNT "sh:sandbox:${pod}:leases" "$now" "+inf" 2>/dev/null | tr -d '[:space:]')
    n="${n:-0}"; [ "$n" -gt "$max" ] && max="$n"
  done
  echo "$max"
}
```

- [ ] **Step 2: Lint**

Run: `shellcheck -x deploy/knative/lib.sh > /tmp/sh/shellcheck-lib.log 2>&1; echo "EXIT:$?"`
Expected: EXIT:0 (or only pre-existing warnings unrelated to the new functions — inspect the log if non-zero).

- [ ] **Step 3: Commit**

```bash
git add deploy/knative/lib.sh
git commit -s -m "feat: Add P3 experiment helpers to lib.sh (converge dispatch, timing, leases)

dispatch_converge posts the P2 repoUrl+ref converge-path envelope; sum_exec_ms
totals [exec-timing] ms from a harness pod log; max_leases_across_pool reads the
P2 lease sets from Redis; plus gitd URL/wait and pool listing.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 6: E6 saturation driver

Sweeps concurrent leaves against one pinned sandbox, computes the knee (CAP), the C=1 duty cycle (→ derived N), applies the sanity-floor gate, then runs the feed-back check on the pool at the derived CAP.

**Files:**
- Create: `deploy/knative/e6-saturation.sh`

**Interfaces:**
- Consumes: `lib.sh` helpers; the analysis functions via `node -e` calls into `experiments/src/sharing.ts` (run with `tsx`).
- Env: `E6_LIVE` (gate), `E6_LADDER` (default `1 2 4 8 16`), `E6_DEGRADE_X` (default `2`), `E6_MIN_CONCURRENCY` (default `4`), `SH_MODEL`, `KSVC`, `NS`, `KSVC_URL` (OCP).

- [ ] **Step 1: Create `deploy/knative/e6-saturation.sh`**

```bash
#!/usr/bin/env bash
# deploy/knative/e6-saturation.sh
# E6: per-sandbox saturation curve. Pins one sandbox, sweeps concurrent leaves over
# E6_LADDER, and reports the knee (recommended KAGENTI_SANDBOX_CAP) + the C=1 duty cycle
# (=> derived provisioning ratio N). Gate: hard sanity floor (knee >= E6_MIN_CONCURRENCY);
# the knee/N themselves are reported. Then a feed-back check runs the pool at the derived
# CAP and asserts leases never exceed it. Records results to EXPERIMENTS.md.
#
# Usage: E6_LIVE=1 [E6_LADDER="1 2 4 8 16"] bash deploy/knative/e6-saturation.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${E6_LIVE:-0}" = "1" ] || { echo "SKIP (set E6_LIVE=1)"; exit 0; }

LADDER="${E6_LADDER:-1 2 4 8 16}"
DEGRADE_X="${E6_DEGRADE_X:-2}"
MIN_C="${E6_MIN_CONCURRENCY:-4}"
PIN="${KAGENTI_SANDBOX_POD:-sandbox-0}"   # single-pod pin for the curve
REF="branch-0"

echo "--- E6: saturation (ladder='$LADDER' pin=$PIN degradeX=$DEGRADE_X floor=$MIN_C) ---"
ensure_port_forward >/dev/null || true
wait_gitd 120 || { echo "gitd not ready"; exit 1; }

# Pin all leaves to one sandbox + enable exec timing; force a new revision and wait Ready.
kubectl set env ksvc/"$KSVC" -n "$NS" \
  KAGENTI_SANDBOX_POD="$PIN" KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000 >/dev/null
wait_ksvc_ready

# Fire C concurrent converge-leaves at ref branch-0; echo "<throughput> <p95ms>".
run_rung() {
  local c="$1" d; d="$(mktemp -d)"
  local t0 t1 pids=""
  t0=$(date +%s%3N)
  local i=0
  while [ "$i" -lt "$c" ]; do
    ( ts=$(date +%s%3N)
      dispatch_converge "e6-$c-$i-$$" "e6" "marker.txt" "$REF" "$REF" >/dev/null 2>&1
      echo $(( $(date +%s%3N) - ts )) > "$d/$i.ms" ) & pids="$pids $!"
    i=$((i + 1))
  done
  # shellcheck disable=SC2086
  wait $pids
  t1=$(date +%s%3N)
  local wall=$(( t1 - t0 )); [ "$wall" -lt 1 ] && wall=1
  local thr; thr=$(awk -v c="$c" -v w="$wall" 'BEGIN{printf "%.3f", c/(w/1000.0)}')
  local p95; p95=$(cat "$d"/*.ms | sort -n | awk '{a[NR]=$1} END{printf "%d", a[int(NR*0.95+0.999)]?a[int(NR*0.95+0.999)]:a[NR]}')
  rm -rf "$d"
  echo "$thr $p95"
}

POINTS="[]"
for c in $LADDER; do
  read -r thr p95 <<<"$(run_rung "$c")"
  echo "  c=$c throughput=$thr p95Ms=$p95"
  POINTS=$(jq -c --argjson c "$c" --argjson t "$thr" --argjson p "$p95" \
    '. + [{c:$c, throughput:$t, p95Ms:$p}]' <<<"$POINTS")
done

# C=1 duty cycle: sum exec ms from the (single) harness pod that served the c=1 leaf.
HARNESS_POD=$(kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
  --field-selector=status.phase=Running --no-headers 2>/dev/null | awk 'NR==1{print $1}')
EXEC_MS=$(sum_exec_ms "$HARNESS_POD"); EXEC_MS="${EXEC_MS:-0}"
BASE_WALL=$(jq -r '.[0].p95Ms' <<<"$POINTS")   # c=1 p95 ~= the single leaf wall time

# Compute knee, duty cycle, derived N, floor verdict via the tested analysis functions.
read -r KNEE DUTY NRATIO FLOOR <<<"$(npx tsx -e '
  import { detectKnee, dutyCycle, derivedRatio, sanityFloorPass } from "./experiments/src/sharing.ts";
  const pts = JSON.parse(process.argv[1]);
  const knee = detectKnee(pts, Number(process.argv[2]));
  const duty = dutyCycle(Number(process.argv[3]), Number(process.argv[4]));
  const n = derivedRatio(duty);
  const floor = sanityFloorPass(knee, Number(process.argv[5]));
  process.stdout.write(`${knee} ${duty.toFixed(3)} ${n} ${floor}`);
' "$POINTS" "$DEGRADE_X" "$EXEC_MS" "$BASE_WALL" "$MIN_C")"

echo "  knee(CAP)=$KNEE dutyCycle=$DUTY derivedN=$NRATIO floorPass=$FLOOR"

# --- Feed-back check: pool at the derived CAP, leases never exceed it ---
kubectl set env ksvc/"$KSVC" -n "$NS" \
  KAGENTI_SANDBOX_POD- KAGENTI_SANDBOX_CAP="$KNEE" >/dev/null   # unpin, set CAP=knee
wait_ksvc_ready
BURST=$(( KNEE * 3 ))
fb_pids=""
for i in $(seq 1 "$BURST"); do
  ( dispatch_converge "e6-fb-$i-$$" "e6" "marker.txt" "$REF" "$REF" >/dev/null 2>&1 ) & fb_pids="$fb_pids $!"
done
MAXL=0
for _ in $(seq 1 30); do m=$(max_leases_across_pool); [ "$m" -gt "$MAXL" ] && MAXL="$m"; sleep 0.5; done
# shellcheck disable=SC2086
wait $fb_pids
[ "$MAXL" -le "$KNEE" ] && ok "feed-back: max leases/pod $MAXL <= CAP $KNEE" \
  || ko "feed-back: max leases/pod $MAXL exceeded CAP $KNEE"

# --- Gate + record ---
if [ "$FLOOR" = "true" ] && [ "$FAIL" = 0 ]; then GATE=yes; else GATE=no; fi
echo "E6_RESULT knee=$KNEE dutyCycle=$DUTY derivedN=$NRATIO floorPass=$FLOOR maxLeases=$MAXL pass=$GATE"
{
  echo ""
  echo "### E6 run $(cat /proc/sys/kernel/hostname 2>/dev/null || echo host)"
  echo "- ladder: $LADDER"
  echo "- points: $POINTS"
  echo "- knee (recommended CAP): $KNEE"
  echo "- duty cycle (C=1): $DUTY  =>  derived N ~= $NRATIO : 1"
  echo "- sanity floor (>= $MIN_C): $FLOOR"
  echo "- feed-back max leases/pod at CAP=$KNEE: $MAXL"
  echo "- verdict: $GATE"
} >> EXPERIMENTS.md

[ "$GATE" = yes ] || exit 1
```

- [ ] **Step 2: Lint**

Run: `shellcheck -x deploy/knative/e6-saturation.sh > /tmp/sh/shellcheck-e6.log 2>&1; echo "EXIT:$?"`
Expected: EXIT:0 (or only benign warnings — inspect if non-zero).

- [ ] **Step 3: Gate no-op check**

Run: `bash deploy/knative/e6-saturation.sh; echo "EXIT:$?"`
Expected: prints `SKIP (set E6_LIVE=1)` and EXIT:0 (no cluster contacted without the gate).

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/e6-saturation.sh
git commit -s -m "feat: Add E6 saturation driver (knee/CAP + duty-cycle N + feed-back)

Sweeps concurrent converge-leaves against one pinned sandbox, computes the knee
(recommended CAP) and the C=1 duty cycle (derived N) via the tested analysis
functions, gates on the sanity floor, then verifies the pool never exceeds the
derived CAP. Gated by E6_LIVE=1; records to EXPERIMENTS.md.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 7: E7 converge-contention driver

Runs C leaves converging **distinct** refs on one pinned pod; asserts mixed-ref correctness (hard gate) and reports the converge-wait contention profile.

**Files:**
- Create: `deploy/knative/e7-converge-contention.sh`

**Interfaces:**
- Consumes: `lib.sh` helpers; `worktreeConsistent` via `tsx`; the gitd refs `branch-0..branch-{K-1}`.
- Env: `E7_LIVE` (gate), `E7_REFS` (default `8`), `SH_MODEL`, `KSVC`, `NS`, `KSVC_URL`.

- [ ] **Step 1: Create `deploy/knative/e7-converge-contention.sh`**

```bash
#!/usr/bin/env bash
# deploy/knative/e7-converge-contention.sh
# E7: converge/fetch contention + mixed-ref correctness. Fires E7_REFS leaves that each
# converge a DISTINCT ref (branch-0..branch-{E7_REFS-1}) on one pinned sandbox. Hard gate:
# every leaf's worktree observed ONLY its own ref's marker (no cross-contamination) — this
# is the live mixed-ref validation deferred from P2 Task 7. Reports converge-wait contention
# (total exec ms under the shared /workspace/.sh-fetch.lock as concurrency rises).
#
# Usage: E7_LIVE=1 [E7_REFS=8] bash deploy/knative/e7-converge-contention.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${E7_LIVE:-0}" = "1" ] || { echo "SKIP (set E7_LIVE=1)"; exit 0; }

REFS="${E7_REFS:-8}"
PIN="${KAGENTI_SANDBOX_POD:-sandbox-0}"

echo "--- E7: converge contention + mixed-ref (refs=$REFS pin=$PIN) ---"
ensure_port_forward >/dev/null || true
wait_gitd 120 || { echo "gitd not ready"; exit 1; }
kubectl set env ksvc/"$KSVC" -n "$NS" \
  KAGENTI_SANDBOX_POD="$PIN" KAGENTI_EXEC_TIMING=1 KAGENTI_SANDBOX_CAP=1000 >/dev/null
wait_ksvc_ready

d="$(mktemp -d)"; pids=""; t0=$(date +%s%3N)
i=0
while [ "$i" -lt "$REFS" ]; do
  ref="branch-$i"
  # Each leaf reviews marker.txt for its OWN branch name; a correct verdict requires the
  # worktree to be pinned at that ref. We capture the terminal JSON and (separately) read
  # the marker the leaf's worktree actually held.
  ( dispatch_converge "e7-$i-$$" "e7" "marker.txt" "$ref" "$ref" > "$d/$ref.json" 2>&1 ) & pids="$pids $!"
  i=$((i + 1))
done
# shellcheck disable=SC2086
wait $pids
t1=$(date +%s%3N)

# Read each leaf's worktree marker from the pinned pod (worktrees survive until cleanup;
# we read via a fresh exec keyed by the runId path the harness derived).
OBS="[]"
i=0
while [ "$i" -lt "$REFS" ]; do
  ref="branch-$i"; sid="e7-$i-$$"
  # toSessionId sanitizes sid; the worktree path is /workspace/leaves/<sanitized sid>.
  wt="/workspace/leaves/${sid//[^A-Za-z0-9._-]/-}"
  marker=$(kubectl -n "$NS" exec "$PIN" -- sh -c "cat '$wt/marker.txt' 2>/dev/null" | tr -d '[:space:]')
  marker="${marker:-MISSING}"
  OBS=$(jq -c --arg r "$sid" --arg e "$ref" --arg o "$marker" \
    '. + [{runId:$r, expectedRef:$e, observedMarker:$o}]' <<<"$OBS")
  i=$((i + 1))
done

# Hard correctness gate via the tested checker.
CONSISTENT=$(npx tsx -e '
  import { worktreeConsistent } from "./experiments/src/sharing.ts";
  const r = worktreeConsistent(JSON.parse(process.argv[1]));
  process.stdout.write(r.ok ? "ok" : "mismatch:" + JSON.stringify(r.mismatches));
' "$OBS")

[ "$CONSISTENT" = "ok" ] && ok "mixed-ref: every leaf saw only its own ref" \
  || ko "mixed-ref cross-contamination: $CONSISTENT"

CONVERGE_MS=$(sum_exec_ms "$(kubectl get pods -n "$NS" -l "serving.knative.dev/service=$KSVC" \
  --field-selector=status.phase=Running --no-headers 2>/dev/null | awk 'NR==1{print $1}')")
WALL=$(( t1 - t0 ))
echo "E7_RESULT refs=$REFS wallMs=$WALL totalExecMs=${CONVERGE_MS:-0} consistent=$([ "$CONSISTENT" = ok ] && echo yes || echo no)"
{
  echo ""
  echo "### E7 run"
  echo "- refs (distinct, concurrent): $REFS"
  echo "- mixed-ref consistency: $CONSISTENT"
  echo "- wall ms: $WALL ; total sandbox exec ms (converge+tools): ${CONVERGE_MS:-0}"
  echo "- observations: $OBS"
} >> EXPERIMENTS.md
rm -rf "$d"

[ "$FAIL" = 0 ] || exit 1
```

- [ ] **Step 2: Lint**

Run: `shellcheck -x deploy/knative/e7-converge-contention.sh > /tmp/sh/shellcheck-e7.log 2>&1; echo "EXIT:$?"`
Expected: EXIT:0 (or only benign warnings).

- [ ] **Step 3: Gate no-op check**

Run: `bash deploy/knative/e7-converge-contention.sh; echo "EXIT:$?"`
Expected: `SKIP (set E7_LIVE=1)` and EXIT:0.

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/e7-converge-contention.sh
git commit -s -m "feat: Add E7 converge-contention driver (mixed-ref correctness + profile)

Fires E7_REFS leaves converging distinct refs on one pinned sandbox; hard-gates
that each worktree observed only its own ref (the live mixed-ref validation
deferred from P2 Task 7) and reports the converge contention profile. Gated by
E7_LIVE=1; records to EXPERIMENTS.md.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 8: Fix `setup-kind.sh` to deploy the pool (issue #54)

Fresh Kind bring-up must deploy `sandbox-pool.yaml` (which carries the pool label and `git`), not the single `sandbox.yaml`, so `KAGENTI_SANDBOX_POOL_SELECTOR` resolves and P3's Kind experiments have a pool.

**Files:**
- Modify: `deploy/knative/setup-kind.sh` (the sandbox-deploy block, ~lines 108–122)

**Interfaces:**
- Consumes: `deploy/knative/sandbox-pool.yaml` (3 CRs `sandbox-0..2`, common pool label).

- [ ] **Step 1: Replace the single-sandbox apply + wait**

Replace the block that currently reads:

```bash
# 6. Deploy durable Sandbox CR
echo "--- Deploying Sandbox CR ---"
kubectl apply -f "$SCRIPT_DIR/sandbox.yaml"
# Wait for the Sandbox controller to publish .status.selector, then wait for the pod
SEL=""
for _ in $(seq 1 60); do
  SEL=$(kubectl -n default get sandbox sandbox-0 -o jsonpath='{.status.selector}' 2>/dev/null || true)
  [ -n "$SEL" ] && break
  sleep 2
done
[ -n "$SEL" ] && kubectl -n default wait --for=condition=Ready pod -l "$SEL" --timeout=180s || {
  echo "sandbox pod not ready (selector='$SEL')"
  kubectl -n default get sandbox sandbox-0 -o yaml | head -40
  exit 1
}
```

with the pool-aware version:

```bash
# 6. Deploy the durable Sandbox POOL (issue #54: pool, not a single sandbox — the harness
#    resolves KAGENTI_SANDBOX_POOL_SELECTOR against all pool pods).
echo "--- Deploying Sandbox pool ---"
kubectl apply -f "$SCRIPT_DIR/sandbox-pool.yaml"
# Wait for every pool pod (sandbox-0..N-1) to go Ready via the common pool label.
POOL_SELECTOR="sh.kagenti.io/sandbox-pool=default"
for _ in $(seq 1 90); do
  ready=$(kubectl -n default get pods -l "$POOL_SELECTOR" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
  want=$(grep -c '^kind: Sandbox' "$SCRIPT_DIR/sandbox-pool.yaml")
  [ "$ready" -ge "$want" ] && break
  sleep 2
done
kubectl -n default wait --for=condition=Ready pod -l "$POOL_SELECTOR" --timeout=180s || {
  echo "sandbox pool not all Ready (label='$POOL_SELECTOR')"
  kubectl -n default get pods -l "$POOL_SELECTOR" -o wide | head -40
  exit 1
}
```

- [ ] **Step 2: Lint**

Run: `shellcheck -x deploy/knative/setup-kind.sh > /tmp/sh/shellcheck-setup.log 2>&1; echo "EXIT:$?"`
Expected: EXIT:0 (or only pre-existing warnings unrelated to this block).

- [ ] **Step 3: Commit**

```bash
git add deploy/knative/setup-kind.sh
git commit -s -m "fix: setup-kind deploys the sandbox pool, not a single sandbox (#54)

A fresh Kind bring-up applied sandbox.yaml (single CR, no pool label, no git),
incoherent with KAGENTI_SANDBOX_POOL_SELECTOR. Apply sandbox-pool.yaml and wait
for all N pool pods via the common label. Prerequisite for P3's Kind experiments.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 9: Docs — EXPERIMENTS.md section + RESULTS.md pointer

Scaffolds where P3 numbers land and how to run the drivers.

**Files:**
- Modify: `deploy/knative/EXPERIMENTS.md`, `experiments/RESULTS.md`

- [ ] **Step 1: Append the P3 section to `deploy/knative/EXPERIMENTS.md`**

```markdown

# P3 — Sandbox Sharing-Ratio Results

Authoritative home for the P3 experiment numbers (cluster experiments record here, matching
E1/E3/E4). See the design: `docs/specs/2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`.

**How to run (develop on Kind, authoritative on OCP):**

```bash
# Kind sh-knative (3-pod pool up, gitd deployed via kustomize):
E6_LIVE=1 bash deploy/knative/e6-saturation.sh
E7_LIVE=1 bash deploy/knative/e7-converge-contention.sh

# OCP 4.20 (authoritative): export KSVC_URL=<route>, KUBECONFIG=<ocp>, then the same.
```

## E6 — saturation curve (→ CAP + derived N)

Pins one sandbox, sweeps concurrent leaves (`E6_LADDER`), reports the knee (recommended
`KAGENTI_SANDBOX_CAP`) and the C=1 duty cycle (→ derived N ≈ 1/duty). Hard gate: sanity
floor `knee >= E6_MIN_CONCURRENCY`. Feed-back: pool never exceeds the derived CAP. Runs
append their `E6_RESULT` block below.

## E7 — converge contention + mixed-ref correctness

Fires `E7_REFS` leaves converging distinct refs on one pod. Hard gate: every leaf's worktree
observed only its own ref (the live mixed-ref validation deferred from P2 Task 7). Reports the
converge contention profile. Runs append their `E7_RESULT` block below.
```

- [ ] **Step 2: Add a P3 pointer to `experiments/RESULTS.md`**

Append (do not rewrite the file — `report.ts:buildResultsMarkdown` regenerates the M6 sections, so keep P3 as static prose it will not clobber):

```markdown

## P3 — sandbox sharing ratio (E6/E7)

Structural analysis is unit-tested in `experiments/test/e6-saturation-structural.test.ts` and
`experiments/test/e7-converge-contention-structural.test.ts` (knee/duty-cycle/floor and
mixed-ref/never-over-cap). **Authoritative cluster numbers live in
`deploy/knative/EXPERIMENTS.md`** (the E6/E7 drivers append there, matching E1/E3/E4).
```

- [ ] **Step 3: Commit**

```bash
git add deploy/knative/EXPERIMENTS.md experiments/RESULTS.md
git commit -s -m "docs: Scaffold P3 sharing-ratio results (EXPERIMENTS.md + RESULTS.md pointer)

Authoritative P3 numbers land in EXPERIMENTS.md (cluster-experiment convention);
RESULTS.md points there and to the structural unit tests.

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 10: Gated live verification (Kind → OCP)

Not a CI task — this runs the drivers on real clusters and records the numbers. Verifies the whole plan end-to-end.

**Files:** none (produces appended results in `EXPERIMENTS.md`, committed at the end).

- [ ] **Step 1: Build + deploy on Kind `sh-knative`**

Rebuild the harness image with the Task 1 change and redeploy (force a new ksvc revision — mutable `:local` tag needs a config bump, P2 lesson). Redirect build output:

Run: `bash deploy/knative/setup-kind.sh > /tmp/sh/setup-kind.log 2>&1; echo "EXIT:$?"` (or the repo's image-rebuild path), then confirm the pool + gitd:
`kubectl get pods -l sh.kagenti.io/sandbox-pool=default -n default --no-headers | wc -l` (expect 3) and `kubectl rollout status deploy/gitd -n default`.
Analyze the log via a subagent if non-zero; do not read it inline.

- [ ] **Step 2: Run E6 + E7 on Kind (gated)**

```bash
mkdir -p /tmp/sh
E6_LIVE=1 bash deploy/knative/e6-saturation.sh > /tmp/sh/e6-kind.log 2>&1; echo "E6:$?"
E7_LIVE=1 bash deploy/knative/e7-converge-contention.sh > /tmp/sh/e7-kind.log 2>&1; echo "E7:$?"
```
Expected: `E6:0` and `E7:0`. Dispatch a subagent to extract the `E6_RESULT`/`E7_RESULT` lines and any `FAIL:` from the logs (do not read the full logs inline). Kind numbers are shape/relative only (D5).

- [ ] **Step 3: Run authoritative E6 + E7 on OCP 4.20**

```bash
export KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig
export KSVC_URL=$(oc get ksvc serverless-harness -n default -o jsonpath='{.status.url}')
# Ensure gitd + pool deployed on OCP (kubectl apply -k deploy/knative/overlays/ocp), then:
E6_LIVE=1 bash deploy/knative/e6-saturation.sh > /tmp/sh/e6-ocp.log 2>&1; echo "E6:$?"
E7_LIVE=1 bash deploy/knative/e7-converge-contention.sh > /tmp/sh/e7-ocp.log 2>&1; echo "E7:$?"
```
Expected: `E6:0`, `E7:0`; recovering the recommended CAP + derived N. If `/turn`/`/runs` errors with "Connection error", re-provision `llm-credentials` with an api-key only (P0′ lesson). Analyze via subagent.

- [ ] **Step 4: Record + commit the authoritative numbers**

The drivers already appended `E6_RESULT`/`E7_RESULT` blocks to `EXPERIMENTS.md`. Trim to the authoritative OCP run, add one summary line (recommended `KAGENTI_SANDBOX_CAP` + derived N), then:

```bash
git add deploy/knative/EXPERIMENTS.md
git commit -s -m "docs: Record P3 E6/E7 results (CAP + derived N) from live OCP 4.20

Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push the branch and open the PR**

```bash
git push -u origin docs/p3-sandbox-sharing-experiments
gh pr create --title "P3: Sandbox sharing-ratio experiments (E6/E7 + git-daemon substrate)" \
  --body "$(cat <<'EOF'
Implements P3 (#48) of the two-tier epic (#49): the sharing-ratio experiments on runc.

- Env-gated exec-timing hook (off by default) for duty-cycle measurement.
- E6 saturation curve → recommended KAGENTI_SANDBOX_CAP + derived N; E7 converge
  contention + the live mixed-ref validation deferred from P2 Task 7.
- Hermetic in-cluster git-daemon load substrate.
- setup-kind deploys the pool (#54).
- Structural analysis unit-tested; authoritative numbers in EXPERIMENTS.md.

Kata/VM isolation + intra-pod hardening remain P4 (#57).

Assisted-By: Claude Code
EOF
)"
```

---

## Self-Review

**1. Spec coverage** (spec `2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`):

| Spec item | Task |
|-----------|------|
| §4 concurrency knee → CAP | Task 2 (`detectKnee`) + Task 6 |
| §4 duty cycle → derived N | Task 1 (timing) + Task 2 (`dutyCycle`/`derivedRatio`) + Task 6 |
| §4 converge wait / contention | Task 3 + Task 7 |
| §4 sandbox CPU/mem per level | Task 6 (reported per rung; CPU via exec-timing sum — see deviation) |
| §5.1 E6 saturation curve | Task 2 + Task 6 |
| §5.2 E7 contention + mixed-ref correctness (P2 Task 7) | Task 3 + Task 7 |
| §5.3 feed-back check at derived CAP | Task 6 (final phase) |
| §6 in-cluster git-daemon substrate | Task 4 |
| §6 file:// rejected | honored (git:// only) |
| §7 vitest structural + gated live drivers | Tasks 2/3 (structural) + Tasks 6/7 (live, `E6_LIVE`/`E7_LIVE`) |
| §7 lib.sh helper reuse + new helpers | Task 5 |
| §7 results → EXPERIMENTS.md / RESULTS.md | Task 9 (see deviation) |
| §7 live-run lessons (min-scale, `:local` revision, `-k`, api-key-only) | Task 10 |
| §11 fold in #54 | Task 8 |
| §11 #55/#56 left separate | honored (not touched) |
| §8 P4 handoff, §11 non-goals | out of scope by design (P4 #57) |

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N". Every code step shows complete code. (One in-repo `TODO(M3)` comment in `exec.ts:47` is pre-existing and untouched.)

**3. Type consistency:** `LadderPoint` (Task 2) used by `detectKnee` (Task 2) and produced by Task 6's `POINTS` JSON with matching keys `c/throughput/p95Ms`. `LeafObservation` (Task 3, keys `runId/expectedRef/observedMarker`) produced by Task 7's `OBS` JSON with the same keys. `dispatch_converge` (Task 5) sends `LeafEnvelope` keys verified against `harness/src/run-leaf.ts:49` (`sessionId`, `item.{item_id,file,pattern}`, `repoUrl`, `ref`, `model`). Lease key `sh:sandbox:<pod>:leases` and `RedisLeaseStore.{acquire,load,release}` match `harness/src/sandbox-lease.ts`.

**Deviations flagged for the user (resolve at review):**
- **§4 CPU/mem "per level":** the plan reports sandbox-busy time via the exec-timing sum rather than a separate metrics-server CPU/mem sample per rung (metrics-server is ~15s-coarse vs sub-second execs, so it would be noisy). If a true CPU/mem-per-rung table is wanted, add a `kubectl top pod` sampler rung-by-rung — small addition to Task 6.
- **§7 results in RESULTS.md:** to avoid clobbering the M6 `RESULTS.md` (its `report.ts:buildResultsMarkdown` rewrites the whole file), P3's authoritative numbers live in `EXPERIMENTS.md` (matching the E1/E3/E4 cluster-experiment convention) and `RESULTS.md` gets a pointer. If you want P3 tables physically in `RESULTS.md`, that needs a clobber-safe section-merge util (extra small task).
