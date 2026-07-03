# P2 — Shared Sandbox Pool + Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scale Archetype A from one sandbox to a static pool of N sandbox pods, with each short-lived leaf harness load-balanced onto the least-loaded pod via Redis leases, its repo lazily converged to a pinned git ref, and its work isolated in a per-leaf git worktree — the harness still touching no filesystem.

**Architecture:** `@sh/k8s-sandbox` gains a pure kubectl pod-lister; the harness gains a Redis lease store (expiry-scored sorted sets, atomic Lua acquire), a pool selector that picks the least-loaded pod under a soft cap and returns a lease handle, and a converge module that (via sandbox `exec`) fetches the ref into a shared `/workspace/repo` object store and adds a per-leaf `git worktree` at `/workspace/leaves/<leafSessionId>`. `run-leaf.ts` swaps its single-pod `resolveSandboxConfig` call for pool selection + converge + heartbeat + release, deriving `workspaceRef` from the worktree path. Deploy provisions N `Sandbox` CRs sharing a common pod label.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), pnpm workspaces (`harness`, `packages/*`), Vitest, node-redis v6 (sorted sets + `eval`/Lua), kubernetes-sigs/agent-sandbox `Sandbox` CR (`agents.x-k8s.io/v1beta1`), Knative Serving, KEDA, `kubectl` (shelled out).

Spec: [`docs/specs/2026-07-02-p2-shared-sandbox-pool-design.md`](../../specs/2026-07-02-p2-shared-sandbox-pool-design.md). Issues: epic #49, P2 #46. Depends on P1 (#45, merged).

## Global Constraints

- **Every commit is DCO-signed with the AI attribution trailer** — exactly:
  `git commit -s -m "<subject>" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"`.
  Never use `Co-authored-by`.
- **`git add` explicit paths only, never `git add -A`** (the working tree carries unrelated dirty files: `experiments/RESULTS.md`, `.worktrees/`).
- **PR/commit subjects have no `(scope)` parens** and a Capitalized prefix is fine (`docs:`, `feat:`, `fix:` conventional prefixes are used in this repo).
- **ES-module import specifiers keep the `.js` extension** (e.g. `import { x } from "./sandbox-lease.js"`) even though the source is `.ts` — this repo compiles with `tsc`/`tsgo` NodeNext.
- **Per-package test command:** `cd <pkg> && pnpm exec vitest run test/<file>.test.ts` (optionally `-t "<name>"`). **Per-package typecheck:** `cd <pkg> && pnpm exec tsc --noEmit`. Package dirs: `harness`, `packages/k8s-sandbox`.
- **Work on branch `docs/p2-shared-sandbox-pool`** (already created off `main`; the spec commit lives there).
- **Soft capacity cap** (spec D5): rare concurrent overshoot is acceptable; do not add a hard CAS beyond the single-`eval` acquire.
- **FS-free harness contract (P1) is preserved:** every filesystem mutation (converge, worktree add/remove) is issued as a sandbox `exec`; the harness process opens no paths.
- **Config knobs (env, with defaults):** `KAGENTI_SANDBOX_POOL_SELECTOR` (label selector; unset ⇒ fall back to single-pod `KAGENTI_SANDBOX_POD`/`_NAME`), `KAGENTI_SANDBOX_CAP` (default `20`), `KAGENTI_SANDBOX_LEASE_TTL_MS` (default `60000`), `KAGENTI_SANDBOX_HEARTBEAT_MS` (default `20000`), `KAGENTI_SANDBOX_NAMESPACE` (default `default`), `KAGENTI_SANDBOX_CWD` (default `/workspace`), `REDIS_URL` (default `redis://127.0.0.1:6379`).
- **Worktree/lease id = `leafSessionId(env)`** — the existing tenant-prefixed-then-sanitized leaf id from `run-leaf.ts` (unique per leaf).

---

## File Structure

**New files**
- `packages/k8s-sandbox/src/pool.ts` — pure `buildPoolPodsArgs` + `parsePodNames`, and `listPoolPods` (Running pod names by label). (Task 1)
- `packages/k8s-sandbox/test/pool.test.ts` — unit tests with a fake `RunKubectl`. (Task 1)
- `harness/src/sandbox-lease.ts` — `leaseKey`, pure `activeCount`, `ACQUIRE_LUA`, `LeaseStore` interface, `RedisLeaseStore`. (Task 2)
- `harness/test/sandbox-lease.test.ts` — unit tests for the pure parts. (Task 2)
- `harness/src/select-sandbox.ts` — pure `orderByLoad`, `SandboxPoolSaturatedError`, `selectPoolSandbox`. (Task 3)
- `harness/test/select-sandbox.test.ts` — unit tests with fakes. (Task 3)
- `harness/src/converge.ts` — pure `leafWorkspaceRef`/`buildConvergeScript`/`buildCleanupScript`, and `convergeWorkspace`/`cleanupWorkspace`. (Task 4)
- `harness/test/converge.test.ts` — unit tests for the pure builders. (Task 4)
- `deploy/knative/sandbox-pool.yaml` — N `Sandbox` CRs with the common pool label. (Task 6)
- `harness/test/pool-live-smoke.test.ts` — gated (`POOL_LIVE_SMOKE=1`) live-redis + live-cluster smoke. (Task 7)

**Modified files**
- `packages/k8s-sandbox/src/resolve-pod.ts` — export the shared default kubectl runner as `defaultRunKubectl`. (Task 1)
- `packages/k8s-sandbox/src/index.ts` — export the pool API. (Task 1)
- `harness/src/run-leaf.ts` — add `repoUrl`/`ref` to `LeafEnvelope`; swap single-pod resolve for select+converge+heartbeat+release; derive `workspaceRef`. (Task 5)
- `deploy/knative/service.yaml` — set `KAGENTI_SANDBOX_POOL_SELECTOR`; keep `KAGENTI_SANDBOX_POD` as a test override. (Task 6)
- `deploy/knative/kustomization.yaml` (+ `overlays/ocp/…`) — reference `sandbox-pool.yaml` instead of the single `sandbox.yaml`. (Task 6)

---

### Task 1: Pool pod discovery (`@sh/k8s-sandbox`)

**Files:**
- Create: `packages/k8s-sandbox/src/pool.ts`
- Create: `packages/k8s-sandbox/test/pool.test.ts`
- Modify: `packages/k8s-sandbox/src/resolve-pod.ts` (export the default runner)
- Modify: `packages/k8s-sandbox/src/index.ts` (export pool API)

**Interfaces:**
- Consumes: `RunKubectl = (args: string[]) => Promise<string>` from `./resolve-pod.js`.
- Produces: `buildPoolPodsArgs(selector, namespace, context?) => string[]`, `parsePodNames(stdout: string) => string[]`, `listPoolPods(selector, namespace, context?, run?) => Promise<string[]>`, and `defaultRunKubectl: RunKubectl`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/k8s-sandbox/test/pool.test.ts
import { describe, it, expect } from "vitest";
import { buildPoolPodsArgs, parsePodNames, listPoolPods } from "../src/pool.js";

describe("buildPoolPodsArgs", () => {
  it("lists Running pods by selector with a per-name jsonpath", () => {
    expect(buildPoolPodsArgs("app=sandbox", "default")).toEqual([
      "get", "pod", "-n", "default", "-l", "app=sandbox",
      "--field-selector=status.phase=Running",
      "-o", "jsonpath={range .items[*]}{.metadata.name}{'\\n'}{end}",
    ]);
  });
  it("adds --context when provided", () => {
    expect(buildPoolPodsArgs("app=sandbox", "team1", "kind-x")).toContain("--context");
  });
});

describe("parsePodNames", () => {
  it("splits, trims, and drops blanks", () => {
    expect(parsePodNames("sandbox-0-0\nsandbox-1-0\n\n  sandbox-2-0  \n")).toEqual([
      "sandbox-0-0", "sandbox-1-0", "sandbox-2-0",
    ]);
  });
  it("returns [] for empty output", () => {
    expect(parsePodNames("")).toEqual([]);
  });
});

describe("listPoolPods", () => {
  it("runs the built args and parses the result", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return "sandbox-0-0\nsandbox-1-0\n"; };
    const pods = await listPoolPods("app=sandbox", "default", undefined, run);
    expect(pods).toEqual(["sandbox-0-0", "sandbox-1-0"]);
    expect(calls[0]).toEqual(buildPoolPodsArgs("app=sandbox", "default"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/k8s-sandbox && pnpm exec vitest run test/pool.test.ts`
Expected: FAIL — `Cannot find module '../src/pool.js'`.

- [ ] **Step 3: Export the shared kubectl runner from `resolve-pod.ts`**

In `packages/k8s-sandbox/src/resolve-pod.ts`, rename the private `defaultRun` to an exported `defaultRunKubectl` (update its one internal use in `resolveSandboxConfig`'s default parameter):

```typescript
// was: const defaultRun: RunKubectl = (args) => …
export const defaultRunKubectl: RunKubectl = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString().trim())
        : reject(new Error(`kubectl ${args.join(" ")} failed (${code}): ${Buffer.concat(err).toString().trim()}`)),
    );
  });
```

And update the signature default: `run: RunKubectl = defaultRunKubectl,`.

- [ ] **Step 4: Write the implementation**

```typescript
// packages/k8s-sandbox/src/pool.ts
import { type RunKubectl, defaultRunKubectl } from "./resolve-pod.js";

/** Pure: kubectl args to list Running pod names matching a label selector (one name per line). */
export function buildPoolPodsArgs(selector: string, namespace: string, context?: string): string[] {
  const args = ["get", "pod", "-n", namespace, "-l", selector, "--field-selector=status.phase=Running"];
  if (context) args.push("--context", context);
  args.push("-o", "jsonpath={range .items[*]}{.metadata.name}{'\\n'}{end}");
  return args;
}

/** Pure: parse newline-separated pod names from kubectl stdout. */
export function parsePodNames(stdout: string): string[] {
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** List Running pod names in the pool (all pods matching the shared pool label). */
export async function listPoolPods(
  selector: string,
  namespace: string,
  context?: string,
  run: RunKubectl = defaultRunKubectl,
): Promise<string[]> {
  return parsePodNames(await run(buildPoolPodsArgs(selector, namespace, context)));
}
```

Add to `packages/k8s-sandbox/src/index.ts`:

```typescript
export { buildPoolPodsArgs, parsePodNames, listPoolPods } from "./pool.js";
export { defaultRunKubectl } from "./resolve-pod.js";
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `cd packages/k8s-sandbox && pnpm exec vitest run test/pool.test.ts && pnpm exec tsc --noEmit`
Expected: PASS (all pool tests green, no type errors).

- [ ] **Step 6: Commit**

```bash
git add packages/k8s-sandbox/src/pool.ts packages/k8s-sandbox/test/pool.test.ts \
        packages/k8s-sandbox/src/resolve-pod.ts packages/k8s-sandbox/src/index.ts
git commit -s -m "feat: add pool pod discovery to k8s-sandbox" \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 2: Redis lease store (`harness`)

**Files:**
- Create: `harness/src/sandbox-lease.ts`
- Create: `harness/test/sandbox-lease.test.ts`

**Interfaces:**
- Produces: `leaseKey(pod: string) => string`; `activeCount(members: {value: string; score: number}[], now: number) => number`; `ACQUIRE_LUA: string`; `interface LeaseStore { load(pod): Promise<number>; acquire(pod, cap, runId, ttlMs): Promise<boolean>; heartbeat(pod, runId, ttlMs): Promise<void>; release(pod, runId): Promise<void> }`; `class RedisLeaseStore implements LeaseStore` (ctor `(url?, now?)`, plus `close()`).
- Note: the pure parts (`leaseKey`, `activeCount`) are unit-tested here; `RedisLeaseStore`'s Lua acquire is validated against live Redis in Task 7 (the repo runs Redis via docker for integration, never a Lua fake).

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/sandbox-lease.test.ts
import { describe, it, expect } from "vitest";
import { leaseKey, activeCount } from "../src/sandbox-lease.js";

describe("leaseKey", () => {
  it("namespaces per pod", () => {
    expect(leaseKey("sandbox-1-0")).toBe("sh:sandbox:sandbox-1-0:leases");
  });
});

describe("activeCount", () => {
  const now = 1_000_000;
  it("counts only members whose expiry is strictly in the future", () => {
    const members = [
      { value: "a", score: now - 1 },   // expired
      { value: "b", score: now },       // expired (boundary: not > now)
      { value: "c", score: now + 1 },   // active
      { value: "d", score: now + 500 }, // active
    ];
    expect(activeCount(members, now)).toBe(2);
  });
  it("is 0 for an empty set", () => {
    expect(activeCount([], now)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness && pnpm exec vitest run test/sandbox-lease.test.ts`
Expected: FAIL — `Cannot find module '../src/sandbox-lease.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// harness/src/sandbox-lease.ts
import { createClient, type RedisClientType } from "redis";

/** Redis key holding the per-pod lease set (member = leaf id, score = expiry ms). */
export function leaseKey(pod: string): string {
  return `sh:sandbox:${pod}:leases`;
}

/** Pure: count members whose expiry (score, ms) is still in the future. */
export function activeCount(members: { value: string; score: number }[], now: number): number {
  return members.filter((m) => m.score > now).length;
}

/**
 * Atomic acquire. KEYS[1]=leaseKey. ARGV = [now, cap, runId, expiry].
 * Sweeps expired members, then adds {runId -> expiry} iff active < cap.
 * Returns 1 (acquired) or 0 (full). Crash reclaim is implicit: a dead leaf's
 * member ages past its expiry and is swept by the next acquire (spec §4.1).
 */
export const ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
  return 1
end
return 0`;

export interface LeaseStore {
  /** Active (non-expired) lease count for a pod; sweeps expired as a side effect. */
  load(pod: string): Promise<number>;
  /** Try to take a lease under the soft cap. */
  acquire(pod: string, cap: number, runId: string, ttlMs: number): Promise<boolean>;
  /** Refresh a held lease's expiry (called on an interval while the leaf runs). */
  heartbeat(pod: string, runId: string, ttlMs: number): Promise<void>;
  /** Drop a held lease. */
  release(pod: string, runId: string): Promise<void>;
}

/** Real node-redis-backed lease store. Connects lazily; reuses REDIS_URL. */
export class RedisLeaseStore implements LeaseStore {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379", private now: () => number = Date.now) {
    this.client = createClient({ url }) as RedisClientType;
    this.ready = this.client.connect().then(() => undefined);
  }
  async load(pod: string): Promise<number> {
    await this.ready;
    await this.client.zRemRangeByScore(leaseKey(pod), "-inf", this.now());
    return this.client.zCard(leaseKey(pod));
  }
  async acquire(pod: string, cap: number, runId: string, ttlMs: number): Promise<boolean> {
    await this.ready;
    const now = this.now();
    const res = await this.client.eval(ACQUIRE_LUA, {
      keys: [leaseKey(pod)],
      arguments: [String(now), String(cap), runId, String(now + ttlMs)],
    });
    return res === 1;
  }
  async heartbeat(pod: string, runId: string, ttlMs: number): Promise<void> {
    await this.ready;
    await this.client.zAdd(leaseKey(pod), { score: this.now() + ttlMs, value: runId });
  }
  async release(pod: string, runId: string): Promise<void> {
    await this.ready;
    await this.client.zRem(leaseKey(pod), runId);
  }
  async close(): Promise<void> {
    await this.ready;
    await this.client.close();
  }
}
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `cd harness && pnpm exec vitest run test/sandbox-lease.test.ts && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/src/sandbox-lease.ts harness/test/sandbox-lease.test.ts
git commit -s -m "feat: add Redis sandbox lease store" \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 3: Pool selector (`harness`)

**Files:**
- Create: `harness/src/select-sandbox.ts`
- Create: `harness/test/select-sandbox.test.ts`

**Interfaces:**
- Consumes: `listPoolPods`, `resolveSandboxConfig`, `type RunKubectl`, `type K8sSandboxConfig` from `@sh/k8s-sandbox`; `LeaseStore`, `RedisLeaseStore` from `./sandbox-lease.js`.
- Produces:
  - `orderByLoad(loads: {pod: string; active: number}[]) => string[]` (pure, ascending by load, stable).
  - `class SandboxPoolSaturatedError extends Error`.
  - `interface SelectedSandbox { config: K8sSandboxConfig; heartbeat(): Promise<void>; release(): Promise<void> }`.
  - `selectPoolSandbox(env, headCwd, runId, opts: {cap, ttlMs}, deps?) => Promise<SelectedSandbox | null>` — `null` means *no sandbox configured* (run local tools); throws `SandboxPoolSaturatedError` when a pool is configured but every pod is at cap.

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/select-sandbox.test.ts
import { describe, it, expect } from "vitest";
import { orderByLoad, selectPoolSandbox, SandboxPoolSaturatedError } from "../src/select-sandbox.js";
import type { LeaseStore } from "../src/sandbox-lease.js";

describe("orderByLoad", () => {
  it("sorts ascending by active load, stable on ties", () => {
    expect(orderByLoad([
      { pod: "c", active: 2 }, { pod: "a", active: 0 }, { pod: "b", active: 0 },
    ])).toEqual(["a", "b", "c"]);
  });
});

function fakeLease(loads: Record<string, number>, cap: number): LeaseStore & { acquired: string[] } {
  const counts = { ...loads };
  const acquired: string[] = [];
  return {
    acquired,
    async load(pod) { return counts[pod] ?? 0; },
    async acquire(pod, c, _runId) {
      if ((counts[pod] ?? 0) < c) { counts[pod] = (counts[pod] ?? 0) + 1; acquired.push(pod); return true; }
      return false;
    },
    async heartbeat() {},
    async release() {},
  };
}

describe("selectPoolSandbox", () => {
  const opts = { cap: 2, ttlMs: 60000 };

  it("returns null when no sandbox is configured at all", async () => {
    const res = await selectPoolSandbox({} as NodeJS.ProcessEnv, "/head", "leaf-1", opts, {
      listPods: async () => [],
    });
    expect(res).toBeNull();
  });

  it("falls back to single-pod resolution when no pool selector is set", async () => {
    const env = { KAGENTI_SANDBOX_POD: "sandbox-x" } as unknown as NodeJS.ProcessEnv;
    const res = await selectPoolSandbox(env, "/head", "leaf-1", opts, {});
    expect(res?.config.pod).toBe("sandbox-x");
  });

  it("picks the least-loaded pod and acquires a lease", async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: "app=sandbox" } as unknown as NodeJS.ProcessEnv;
    const lease = fakeLease({ "sandbox-0-0": 2, "sandbox-1-0": 0 }, opts.cap);
    const res = await selectPoolSandbox(env, "/head", "leaf-1", opts, {
      listPods: async () => ["sandbox-0-0", "sandbox-1-0"],
      lease,
    });
    expect(res?.config.pod).toBe("sandbox-1-0");
    expect(lease.acquired).toEqual(["sandbox-1-0"]);
  });

  it("throws SandboxPoolSaturatedError when every pod is at cap", async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: "app=sandbox" } as unknown as NodeJS.ProcessEnv;
    const lease = fakeLease({ "sandbox-0-0": 2, "sandbox-1-0": 2 }, opts.cap);
    await expect(selectPoolSandbox(env, "/head", "leaf-1", opts, {
      listPods: async () => ["sandbox-0-0", "sandbox-1-0"],
      lease,
    })).rejects.toBeInstanceOf(SandboxPoolSaturatedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness && pnpm exec vitest run test/select-sandbox.test.ts`
Expected: FAIL — `Cannot find module '../src/select-sandbox.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// harness/src/select-sandbox.ts
import { listPoolPods, resolveSandboxConfig, type RunKubectl, type K8sSandboxConfig } from "@sh/k8s-sandbox";
import { RedisLeaseStore, type LeaseStore } from "./sandbox-lease.js";

/** Pure: pods ordered ascending by active load (stable — ties keep input order). */
export function orderByLoad(loads: { pod: string; active: number }[]): string[] {
  return loads
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => a.active - b.active || a.i - b.i)
    .map((l) => l.pod);
}

/** Thrown when a pool is configured but every pod is at the soft cap. */
export class SandboxPoolSaturatedError extends Error {
  constructor(selector: string) {
    super(`sandbox pool '${selector}' saturated: all pods at capacity`);
    this.name = "SandboxPoolSaturatedError";
  }
}

export interface SelectedSandbox {
  config: K8sSandboxConfig;
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
}

export interface SelectDeps {
  listPods?: (selector: string, namespace: string, context?: string, run?: RunKubectl) => Promise<string[]>;
  lease?: LeaseStore;
  run?: RunKubectl;
}

/**
 * Choose a sandbox pod for a leaf.
 *  - No `KAGENTI_SANDBOX_POOL_SELECTOR` ⇒ fall back to single-pod resolution
 *    (`KAGENTI_SANDBOX_POD`/`_NAME`); returns null if that too is unset (run local tools).
 *  - Pool configured ⇒ list Running pods, pick least-loaded under the soft cap, acquire a lease.
 *    Throws SandboxPoolSaturatedError if all pods are full.
 */
export async function selectPoolSandbox(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  runId: string,
  opts: { cap: number; ttlMs: number },
  deps: SelectDeps = {},
): Promise<SelectedSandbox | null> {
  const selector = env.KAGENTI_SANDBOX_POOL_SELECTOR;
  if (!selector) {
    const config = await resolveSandboxConfig(env, headCwd, deps.run);
    return config ? { config, heartbeat: async () => {}, release: async () => {} } : null;
  }

  const namespace = env.KAGENTI_SANDBOX_NAMESPACE ?? "default";
  const context = env.KAGENTI_SANDBOX_CONTEXT || undefined;
  const podCwd = env.KAGENTI_SANDBOX_CWD ?? "/workspace";
  const list = deps.listPods ?? listPoolPods;
  const lease = deps.lease ?? new RedisLeaseStore(env.REDIS_URL);

  const pods = await list(selector, namespace, context, deps.run);
  if (pods.length === 0) throw new Error(`no Running pods for pool selector '${selector}'`);

  const loads = await Promise.all(pods.map(async (pod) => ({ pod, active: await lease.load(pod) })));
  for (const pod of orderByLoad(loads)) {
    if (await lease.acquire(pod, opts.cap, runId, opts.ttlMs)) {
      const config: K8sSandboxConfig = { pod, namespace, context, podCwd, headCwd };
      return {
        config,
        heartbeat: () => lease.heartbeat(pod, runId, opts.ttlMs),
        release: () => lease.release(pod, runId),
      };
    }
  }
  throw new SandboxPoolSaturatedError(selector);
}
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `cd harness && pnpm exec vitest run test/select-sandbox.test.ts && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/src/select-sandbox.ts harness/test/select-sandbox.test.ts
git commit -s -m "feat: add least-loaded sandbox pool selector" \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 4: Repo converge + worktree (`harness`)

**Files:**
- Create: `harness/src/converge.ts`
- Create: `harness/test/converge.test.ts`

**Interfaces:**
- Consumes: `type ExecInPod` from `@sh/k8s-sandbox` (`(command, opts?) => Promise<{stdout: Buffer; exitCode: number | null}>`).
- Produces:
  - `leafWorkspaceRef(runId: string) => string` → `/workspace/leaves/<runId>`.
  - `buildConvergeScript(repoUrl, ref, runId) => string` (pure shell; single-quote-escapes inputs).
  - `buildCleanupScript(runId) => string` (pure).
  - `convergeWorkspace(exec: ExecInPod, repoUrl, ref, runId) => Promise<string>` (returns the workspace ref; throws on non-zero exit).
  - `cleanupWorkspace(exec: ExecInPod, runId) => Promise<void>` (best-effort; never throws).

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/converge.test.ts
import { describe, it, expect } from "vitest";
import {
  leafWorkspaceRef, buildConvergeScript, buildCleanupScript, convergeWorkspace,
} from "../src/converge.js";

describe("leafWorkspaceRef", () => {
  it("is /workspace/leaves/<runId>", () => {
    expect(leafWorkspaceRef("run-a-item-1")).toBe("/workspace/leaves/run-a-item-1");
  });
});

describe("buildConvergeScript", () => {
  const s = buildConvergeScript("https://git.example/r.git", "abc123", "leaf-1");
  it("clones only when absent (idempotent) and fetches the ref under a flock", () => {
    expect(s).toContain('[ -d "$REPO/.git" ] || git clone');
    expect(s).toContain("flock 9");
    expect(s).toContain("fetch --quiet origin");
  });
  it("adds a per-leaf worktree at the fetched commit and prints the path", () => {
    expect(s).toContain("worktree add");
    expect(s).toContain("/workspace/leaves/leaf-1");
    expect(s).toContain('printf');
  });
  it("single-quote-escapes inputs to resist injection", () => {
    const evil = buildConvergeScript("https://x/r.git'; rm -rf /; '", "main", "leaf-1");
    expect(evil).toContain(`'https://x/r.git'\\''; rm -rf /; '\\'''`);
  });
});

describe("convergeWorkspace", () => {
  it("returns trimmed stdout as the workspace ref on success", async () => {
    const exec = async () => ({ stdout: Buffer.from("/workspace/leaves/leaf-1\n"), exitCode: 0 });
    expect(await convergeWorkspace(exec, "u", "r", "leaf-1")).toBe("/workspace/leaves/leaf-1");
  });
  it("throws on non-zero exit", async () => {
    const exec = async () => ({ stdout: Buffer.from(""), exitCode: 1 });
    await expect(convergeWorkspace(exec, "u", "r", "leaf-1")).rejects.toThrow(/converge failed/);
  });
});

describe("buildCleanupScript", () => {
  it("removes the leaf worktree and prunes", () => {
    const c = buildCleanupScript("leaf-1");
    expect(c).toContain("worktree remove");
    expect(c).toContain("/workspace/leaves/leaf-1");
    expect(c).toContain("worktree prune");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness && pnpm exec vitest run test/converge.test.ts`
Expected: FAIL — `Cannot find module '../src/converge.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// harness/src/converge.ts
import type { ExecInPod } from "@sh/k8s-sandbox";

/** Single-quote-escape a string for safe interpolation into a bash command. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The per-leaf worktree path inside the sandbox pod. */
export function leafWorkspaceRef(runId: string): string {
  return `/workspace/leaves/${runId}`;
}

/**
 * Ref-pinned lazy converge (spec §5): clone /workspace/repo once, fetch the target ref under a
 * per-pod flock (serializes concurrent converges), then add a per-leaf detached worktree at the
 * fetched commit. Idempotent — a pod already holding the ref and worktree is a no-op. Prints the
 * worktree path on stdout.
 */
export function buildConvergeScript(repoUrl: string, ref: string, runId: string): string {
  const LEAF = leafWorkspaceRef(runId);
  return [
    `set -eu`,
    `REPO=/workspace/repo; LOCK=/workspace/.sh-fetch.lock; LEAF=${sq(LEAF)}`,
    `mkdir -p /workspace/leaves`,
    `[ -d "$REPO/.git" ] || git clone --quiet ${sq(repoUrl)} "$REPO"`,
    `( flock 9; git -C "$REPO" fetch --quiet origin ${sq(ref)} ) 9>"$LOCK"`,
    `COMMIT=$(git -C "$REPO" rev-parse FETCH_HEAD)`,
    `[ -d "$LEAF" ] || git -C "$REPO" worktree add --quiet --detach "$LEAF" "$COMMIT"`,
    `printf '%s' "$LEAF"`,
  ].join("\n");
}

/** Remove the per-leaf worktree and prune orphans (best-effort; never fails the leaf). */
export function buildCleanupScript(runId: string): string {
  const LEAF = leafWorkspaceRef(runId);
  return [
    `set -u`,
    `REPO=/workspace/repo; LEAF=${sq(LEAF)}`,
    `git -C "$REPO" worktree remove --force "$LEAF" 2>/dev/null || rm -rf "$LEAF"`,
    `git -C "$REPO" worktree prune 2>/dev/null || true`,
  ].join("\n");
}

/** Run the converge script in the pod; return the worktree ref. Throws on non-zero exit. */
export async function convergeWorkspace(
  exec: ExecInPod, repoUrl: string, ref: string, runId: string,
): Promise<string> {
  const { stdout, exitCode } = await exec(buildConvergeScript(repoUrl, ref, runId), { timeout: 300 });
  if (exitCode !== 0) throw new Error(`converge failed (exit ${exitCode})`);
  return stdout.toString().trim() || leafWorkspaceRef(runId);
}

/** Best-effort worktree cleanup; swallows errors so it never masks a verdict. */
export async function cleanupWorkspace(exec: ExecInPod, runId: string): Promise<void> {
  try { await exec(buildCleanupScript(runId), { timeout: 60 }); } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `cd harness && pnpm exec vitest run test/converge.test.ts && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/src/converge.ts harness/test/converge.test.ts
git commit -s -m "feat: add ref-pinned converge and per-leaf worktree helpers" \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 5: Wire pool selection into the leaf runner (`harness`)

**Files:**
- Modify: `harness/src/run-leaf.ts` (add `repoUrl`/`ref` to `LeafEnvelope`; replace sandbox resolution in `realProduceVerdict`)
- Modify: `harness/test/run-leaf.test.ts` (add an envelope-shape test; existing tests must still pass)

**Interfaces:**
- Consumes: `selectPoolSandbox` from `./select-sandbox.js`; `convergeWorkspace`, `cleanupWorkspace` from `./converge.js`; `kubectlExecInPod` from `@sh/k8s-sandbox`.
- Produces: `LeafEnvelope` gains optional `repoUrl?: string; ref?: string`. `realProduceVerdict` now selects a pool pod (or falls back / runs local), converges when `repoUrl`+`ref` are present, heartbeats during the run, and releases + cleans up in `finally`.

- [ ] **Step 1: Write the failing test**

Add to `harness/test/run-leaf.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { LeafEnvelope } from "../src/run-leaf.js";

describe("LeafEnvelope repo ref fields", () => {
  it("accepts optional repoUrl and ref", () => {
    const env: LeafEnvelope = {
      sessionId: "run-a/item-1",
      item: { item_id: "item-1", file: "a.ts", pattern: "x" },
      repoUrl: "https://git.example/r.git",
      ref: "abc123",
    };
    expect(env.repoUrl).toBe("https://git.example/r.git");
    expect(env.ref).toBe("abc123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness && pnpm exec vitest run test/run-leaf.test.ts -t "repo ref fields"`
Expected: FAIL — TypeScript error: `repoUrl`/`ref` not assignable (property does not exist on `LeafEnvelope`). (Vitest reports the type/compile failure.)

- [ ] **Step 3: Add the envelope fields**

In `harness/src/run-leaf.ts`, extend `LeafEnvelope` (after the `workspaceRef` line):

```typescript
export interface LeafEnvelope {
  sessionId: string;
  item: LeafItem;
  decision?: Decision;
  model?: string;
  provider?: string;
  workspaceRef?: string;      // derived from the worktree in P2 when repoUrl+ref are given
  repoUrl?: string;           // P2: git remote to converge the sandbox repo copy from
  ref?: string;               // P2: commit/branch/tag the leaf's worktree is pinned to
  maxTurns?: number;
  async?: boolean;
  tenant?: string;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd harness && pnpm exec vitest run test/run-leaf.test.ts -t "repo ref fields"`
Expected: PASS.

- [ ] **Step 5: Replace sandbox resolution in `realProduceVerdict`**

Add imports at the top of `harness/src/run-leaf.ts`:

```typescript
import { kubectlExecInPod } from "@sh/k8s-sandbox";
import { selectPoolSandbox } from "./select-sandbox.js";
import { convergeWorkspace, cleanupWorkspace } from "./converge.js";
```

Replace the region **from the gate front-end down to the end of the function** (currently starting at the `// Gate front-end (design §3):` comment, ~line 197, through the closing of `realProduceVerdict`) with the following. This selects the pool pod *after* the verdict fast-path (so a recovered verdict never leases a pod), converges when a repo ref is supplied, derives `workspaceRef`, heartbeats during the run, and releases + cleans up in `finally`:

```typescript
  // --- P2: choose a sandbox pod (pool lease) before building the prompt/session. Placed after the
  // verdict fast-path so a recovered verdict does not lease a pod. Returns null ⇒ no sandbox
  // configured (local tools). Throws SandboxPoolSaturatedError when a configured pool is full.
  const selected = await selectPoolSandbox(process.env, cwd, sid, {
    cap: Number(process.env.KAGENTI_SANDBOX_CAP ?? "20"),
    ttlMs: Number(process.env.KAGENTI_SANDBOX_LEASE_TTL_MS ?? "60000"),
  });
  const converging = selected != null && !!env.repoUrl && !!env.ref;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  try {
    // Ref-pinned lazy converge (spec §5): fetch the ref into the shared object store and add this
    // leaf's worktree; workspaceRef becomes the derived worktree path. All FS work happens in the
    // pod via exec — the harness opens nothing.
    let workspaceRef = env.workspaceRef;
    if (converging) {
      const exec = kubectlExecInPod(selected!.config);
      workspaceRef = await convergeWorkspace(exec, env.repoUrl!, env.ref!, sid);
      const hbMs = Number(process.env.KAGENTI_SANDBOX_HEARTBEAT_MS ?? "20000");
      heartbeat = setInterval(() => { void selected!.heartbeat(); }, hbMs);
    }

    // Gate front-end (design §3): decide whether to pause, abort, or seed a prompt.
    const gateState = computeGateState(prior.map((p) => p.entry));
    const dv = env.decision ? validateDecision(env.decision) : null;
    const decision = dv && dv.ok ? dv.value : null;
    const seed = decideSeed(gateState, decision, buildLeafPrompt(item, workspaceRef));

    if (seed.kind === "abort") {
      if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);
      capture.aborted = true;
      await backend.flush();
      return;
    }
    if (seed.kind === "paused") {
      capture.gate = seed.gate;
      await backend.flush();
      return;
    }
    if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);

    const allowVerdict =
      !item.require_approval || gateState.gateDecisions.length > 0 || seed.record != null;

    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        ...(allowVerdict ? [submitVerdictExtension(capture, sessionManager)] : []),
        requestApprovalExtension(capture, sessionManager, gateState.nextGateId),
        k8sSandboxExtension({ config: selected?.config ?? null }),
        flushExtension(backend),
        checkpointExtension(store, sessionManager),
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      sessionManager,
      model: model as never,
      resourceLoader,
      settingsManager,
    });

    try {
      await session.prompt(seed.prompt);
      if (!capture.verdict && !capture.gate) {
        const row = await store.latestWhere(sid, isVerdictEntry);
        const recovered = verdictFromCustomEntry(row?.entry);
        if (recovered) capture.verdict = recovered;
      }
    } finally {
      await backend.flush();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (converging) await cleanupWorkspace(kubectlExecInPod(selected!.config), sid);
    if (selected) await selected.release();
  }
```

Note: the old lines that resolved `sandboxConfig` via `resolveSandboxConfig(process.env, cwd)` and passed `{ config: sandboxConfig }` to `k8sSandboxExtension` are removed — pool selection replaces them, and single-pod behavior is preserved by `selectPoolSandbox`'s fallback branch.

- [ ] **Step 6: Run the full harness suite + typecheck**

Run: `cd harness && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS — all existing run-leaf tests still green (single-pod fallback unchanged), plus the new envelope test.

- [ ] **Step 7: Commit**

```bash
git add harness/src/run-leaf.ts harness/test/run-leaf.test.ts
git commit -s -m "feat: route leaves to a sandbox pool with lease and converge" \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 6: Deploy the sandbox pool (`deploy/knative`)

**Files:**
- Create: `deploy/knative/sandbox-pool.yaml` (N `Sandbox` CRs with the shared pool label)
- Modify: `deploy/knative/service.yaml` (env: pool selector)
- Modify: `deploy/knative/kustomization.yaml` and `deploy/knative/overlays/ocp/kustomization.yaml` (swap `sandbox.yaml` → `sandbox-pool.yaml`)

**Interfaces:**
- Produces: a pool of Running pods labeled `sh.kagenti.io/sandbox-pool=default`; the harness Service configured with `KAGENTI_SANDBOX_POOL_SELECTOR=sh.kagenti.io/sandbox-pool=default`. N=3 for the PoC (edit this file to scale — spec D4).

- [ ] **Step 1: Author the pool manifest**

Create `deploy/knative/sandbox-pool.yaml` — three CRs identical to the P1 `sandbox.yaml` body except for the name and the added common pod label. (Shown for `sandbox-0`; repeat verbatim for `sandbox-1` and `sandbox-2`, changing only `metadata.name`.)

```yaml
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: sandbox-0
  namespace: default
  labels:
    app: sandbox
spec:
  volumeClaimTemplates:
    - metadata:
        name: workspace
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
  podTemplate:
    metadata:
      labels:
        sh.kagenti.io/sandbox-pool: default    # <-- pool discovery label (harness selects on this)
    spec:
      containers:
        - name: sandbox
          image: alpine:3.20
          command: ["/bin/sh", "-c", "apk add --no-cache bash coreutils findutils grep ripgrep git && mkdir -p /workspace && exec sleep infinity"]
          workingDir: /workspace
          volumeMounts:
            - name: workspace
              mountPath: /workspace
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
---
# ... sandbox-1 (metadata.name: sandbox-1) ...
---
# ... sandbox-2 (metadata.name: sandbox-2) ...
```

Note the `command` adds `git` to the `apk add` list (converge needs it). The OCP overlay (`overlays/ocp/patch-sandbox.yaml`) already swaps to the prebaked GHCR image running as UID 65532 — extend that patch to target all three CR names (`sandbox-0..2`); the GHCR sandbox image must include `git`.

- [ ] **Step 2: Set the pool selector env on the harness Service**

In `deploy/knative/service.yaml`, replace the `KAGENTI_SANDBOX_NAME` env entry with the pool selector, and keep `KAGENTI_SANDBOX_POD` documented as a single-pod override (commented out):

```yaml
            - name: KAGENTI_SANDBOX_POOL_SELECTOR
              value: "sh.kagenti.io/sandbox-pool=default"
            # - name: KAGENTI_SANDBOX_POD      # single-pod test override (bypasses pool selection)
            #   value: "sandbox-0-0"
```

- [ ] **Step 3: Reference the pool manifest in kustomize**

In `deploy/knative/kustomization.yaml`, replace `- sandbox.yaml` with `- sandbox-pool.yaml` under `resources:`. Do the same in `deploy/knative/overlays/ocp/kustomization.yaml` if it lists the sandbox resource, and point the OCP sandbox patch at `sandbox-0..2`.

- [ ] **Step 4: Validate the kustomize renders**

Run (redirect per Context Budget rules — do not inline the render):
```bash
mkdir -p /tmp/sh
kubectl kustomize deploy/knative > /tmp/sh/render-base.log 2>&1; echo "EXIT:$?"
kubectl kustomize deploy/knative/overlays/ocp > /tmp/sh/render-ocp.log 2>&1; echo "EXIT:$?"
```
Expected: both `EXIT:0`. Spot-check with a subagent (not an inline read): "grep `/tmp/sh/render-base.log` for `kind: Sandbox` — expect 3 CRs named sandbox-0..2, each with `sh.kagenti.io/sandbox-pool: default` in the podTemplate labels; and confirm the Service has `KAGENTI_SANDBOX_POOL_SELECTOR`."

- [ ] **Step 5: Commit**

```bash
git add deploy/knative/sandbox-pool.yaml deploy/knative/service.yaml \
        deploy/knative/kustomization.yaml deploy/knative/overlays/ocp/
git commit -s -m "feat: provision a static N-pod sandbox pool" \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

### Task 7: Integration + gated live smoke

**Files:**
- Create: `harness/test/pool-live-smoke.test.ts` (gated by `POOL_LIVE_SMOKE=1`)

**Interfaces:**
- Consumes: `RedisLeaseStore`, `ACQUIRE_LUA` from `../src/sandbox-lease.js`.
- Produces: a gated test proving the real Lua acquire enforces the cap and reclaims expired leases against live Redis, plus a documented cluster smoke procedure.

- [ ] **Step 1: Write the gated live-redis lease test**

```typescript
// harness/test/pool-live-smoke.test.ts
import { describe, it, expect } from "vitest";
import { RedisLeaseStore, leaseKey } from "../src/sandbox-lease.js";

// Gate: only runs with a live Redis (docker) and POOL_LIVE_SMOKE=1.
const live = process.env.POOL_LIVE_SMOKE === "1";
const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe.skipIf(!live)("RedisLeaseStore (live redis)", () => {
  it("enforces the soft cap and reclaims expired leases", async () => {
    const pod = `smoke-${process.pid}`;
    // Controllable clock so we can expire a lease deterministically.
    let now = 1_000_000;
    const store = new RedisLeaseStore(url, () => now);
    try {
      // Fresh key.
      // @ts-expect-error reach the raw client for test cleanup only
      await store["client"].del(leaseKey(pod));

      expect(await store.acquire(pod, 2, "a", 1000)).toBe(true);
      expect(await store.acquire(pod, 2, "b", 1000)).toBe(true);
      expect(await store.acquire(pod, 2, "c", 1000)).toBe(false); // at cap
      expect(await store.load(pod)).toBe(2);

      now += 2000; // both leases expire
      expect(await store.acquire(pod, 2, "c", 1000)).toBe(true); // reclaimed slot
      expect(await store.load(pod)).toBe(1);
    } finally {
      await store.release(pod, "c");
      await store.close();
    }
  });
});
```

- [ ] **Step 2: Run it gated (docker Redis), then confirm it skips without the gate**

```bash
docker run -d --rm -p 6379:6379 --name sh-redis-smoke redis:7 > /tmp/sh/redis.log 2>&1; echo "EXIT:$?"
cd harness && POOL_LIVE_SMOKE=1 pnpm exec vitest run test/pool-live-smoke.test.ts 2>&1 | tail -20
# and unset gate → the suite is skipped:
pnpm exec vitest run test/pool-live-smoke.test.ts 2>&1 | tail -5
docker stop sh-redis-smoke > /dev/null 2>&1; echo "EXIT:$?"
```
Expected: gated run PASS (cap enforced, reclaim works); ungated run reports the suite skipped.

- [ ] **Step 3: Cluster smoke on Kind (N=2), analyzed via subagent**

Bring up the pool on the existing Kind cluster and dispatch concurrent leaves, redirecting output per Context Budget rules:

```bash
kubectl apply -k deploy/knative > /tmp/sh/pool-apply.log 2>&1; echo "EXIT:$?"
kubectl -n default get pods -l sh.kagenti.io/sandbox-pool=default \
  > /tmp/sh/pool-pods.log 2>&1; echo "EXIT:$?"
# Dispatch 4 leaves concurrently at the SAME ref via the leaf-orchestrator/dispatch path
# (see the async-leaf smoke for the dispatch invocation), tee to /tmp/sh/pool-dispatch.log.
```
Then dispatch a subagent (Context Budget Rule 2) to analyze the logs and Redis:
> "Read `/tmp/sh/pool-pods.log`: expect ≥2 Running pods labeled `sh.kagenti.io/sandbox-pool=default`. From `/tmp/sh/pool-dispatch.log` confirm all 4 leaves returned a verdict. Then `kubectl exec` into each pool pod and `ls /workspace/leaves` — report which leaf worktrees landed on which pod (expect them spread across ≥2 pods, not all on one). Report PASS/FAIL and any error lines."

Expected: leaves spread across pods; all return verdicts; each leaf's worktree exists under `/workspace/leaves/` on exactly one pod.

- [ ] **Step 4: Cluster smoke — mixed-ref consistency + crash reclaim (subagent-analyzed)**

> Dispatch two leaves at DIFFERENT commits that land on the same pod; via `kubectl exec`, confirm each worktree's `git rev-parse HEAD` matches its own envelope ref (proves the shared object store + per-worktree pinning). Then delete one pool pod mid-run (`kubectl delete pod <p>`); confirm the in-flight leaf resumes (existing Redis resume) and re-acquires on a surviving pod, and that its lease on the deleted pod is gone after TTL (`ZCARD sh:sandbox:<deleted>:leases` → 0). Report PASS/FAIL with the observed commits and lease counts.

- [ ] **Step 5: Gated OCP live smoke (per-sandbox RWO, `SH_MODEL=claude-haiku-4-5`)**

Using `KUBECONFIG=/Users/paolo/Projects/ocp/auth/kubeconfig`, apply the OCP overlay and run the same dispatch through the Route (reuse the P0′ leaf-smoke `$CURL_OPTS`/`-k` TLS handling). Redirect to `/tmp/sh/ocp-pool-smoke.log`; analyze via subagent. Expected: N:M fan-out completes with correct verdicts on OCP 4.20.8; each sandbox pod holds its own RWO PVC repo copy (no RWX).

- [ ] **Step 6: Commit**

```bash
git add harness/test/pool-live-smoke.test.ts
git commit -s -m "test: add gated sandbox-pool live smoke" \
  -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against `2026-07-02-p2-shared-sandbox-pool-design.md`):
- §3 Pool topology (N `Sandbox` CRs, own RWO PVC, common label) → Task 6. ✅
- §4 Routing (K8s discovery + Redis load), §4.1 expiry-scored leases + implicit reclaim, §4.2 atomic Lua acquire/release, §4.3 saturation → Tasks 1 (discovery), 2 (lease/Lua), 3 (selector + `SandboxPoolSaturatedError`). ✅
- §5 Repo lifecycle (shared object store, per-leaf worktree, flock, cleanup/prune) → Task 4. ✅
- §6 FS-free contract + leaf-flow sequence (select → converge → run → cleanup → release, heartbeat during run) → Task 5. ✅
- §7 Envelope `repoUrl`/`ref`, derived `workspaceRef` → Task 5. ✅
- §8 Deploy (`KAGENTI_SANDBOX_POOL_SELECTOR`, keep `KAGENTI_SANDBOX_POD` override, OCP overlay) → Task 6. ✅
- §9 Isolation is an explicit non-goal → no task (correct); soft cap honored (Task 2/3). ✅
- §10 Failure modes (crash reclaim, pod removed, saturation, fetch failure) → Tasks 2/3/4 + Task 7 crash-reclaim smoke. ✅
- §11 Testing (unit lease/ordering/converge; integration Kind N=2–3 mixed-ref + crash; gated OCP smoke) → Tasks 1–4 units + Task 7. ✅

**2. Placeholder scan:** No `TBD`/`TODO`/"handle errors"/"similar to Task N". Every code step shows complete code; the one repeated YAML block (sandbox-1/2) is explicitly "repeat verbatim, change only `metadata.name`". ✅

**3. Type consistency:** `RunKubectl`, `K8sSandboxConfig`, `ExecInPod`, `LeaseStore`, `SelectedSandbox`, `leafWorkspaceRef`, `selectPoolSandbox`, `convergeWorkspace`/`cleanupWorkspace`, `leafSessionId`(=`sid`) names match across Tasks 1–5. `activeCount`/`ACQUIRE_LUA` (Task 2) are consistent between the pure test and the class. `orderByLoad` used identically in Task 3 test and impl. ✅

No gaps found.

---

## Notes carried from spec (do not re-decide)

- Eager pod pre-warm, Kata isolation, the ~20:1 ratio, autoscaling, and RWX/fleet-wide-single-repo are **P3/future** — out of scope here (spec §13).
- `git fetch origin <ref>` assumes the ref is fetchable (branch/tag, or a SHA the server allows); the PoC controls the target repo. Fetch-by-arbitrary-SHA hardening is a documented future refinement, not part of P2.
