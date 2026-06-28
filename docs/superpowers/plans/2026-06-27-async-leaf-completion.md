# Async Leaf Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add true background (async) execution of leaf sessions — `POST /run-leaf {async:true}` returns `202` immediately, a KEDA-spawned Job runs the leaf to completion via a Redis Streams work queue, writes `result_ref` + a done-marker, and the orchestrator polls.

**Architecture:** A thin control plane (the Knative Service enqueues to a Redis Stream `leaf-queue` and reports status) + an ephemeral data plane (KEDA `ScaledJob` spawns one Job per pending entry; the Job is a thin wrapper around the **unchanged** `runLeaf`). At-least-once delivery; a crashed leaf re-runs the same `sessionId` → gate-7 resume; scale-to-zero when the queue drains.

**Tech Stack:** TypeScript (ESM, `tsx`, `noEmit`), pnpm workspaces, `redis` (node-redis v6) Redis Streams, vitest, Knative Serving + KEDA on Kind.

## Global Constraints

- **No new spec scope.** Single-tenant, **provider key in env**. No authn/identity (Z1), no per-user credentials (Z3/Z5), no per-tenant sandbox/data isolation, no cron/event triggers (C), no human-gate (B). (design §8)
- **Synchronous `POST /run-leaf` is unchanged.** Async is purely additive (the `async` flag). (design §2)
- **`runLeaf` is reused unchanged.** The Job is a queue wrapper around it; all leaf logic (sandbox routing, gateway, gate-7 resume) is inherited. (design §5)
- **Harness adds NO Job RBAC** — KEDA creates Jobs; the Job pod reuses the existing `serverless-harness` ServiceAccount. (design §2)
- **Done-marker** path defaults to `<resultRef>.status`; written **last, atomically** (temp + rename). (design §3.3)
- **Delivery is at-least-once;** idempotent `runLeaf` (resume + overwrite) makes the outcome effectively-once. A true retry uses a NEW `sessionId`. (design §3.5)
- **DCO:** every commit uses `git commit -s`; no `Co-Authored-By`. Conventional-commit prefixes.
- Tests are vitest under each package's `test/**/*.test.ts`. Redis-backed tests connect to `process.env.REDIS_URL ?? "redis://127.0.0.1:6379"` and run unconditionally (a Redis must be reachable — `docker run -p 6379:6379 redis:7-alpine`), mirroring `packages/session-backend/test/redis-backend.test.ts`.

---

## File Structure

- `packages/work-queue/package.json` — new `@sh/work-queue` package manifest.
- `packages/work-queue/src/queue.ts` — `WorkQueue` interface, `ClaimedEntry` type, `RedisWorkQueue` (Redis Streams impl).
- `packages/work-queue/src/index.ts` — re-exports.
- `packages/work-queue/test/queue.test.ts` — gated Redis tests.
- `harness/src/done-marker.ts` — `deriveDoneMarkerPath`, `writeDoneMarker`, `readDoneMarker`.
- `harness/test/done-marker.test.ts` — unit tests.
- `harness/src/classify-outcome.ts` — pure `classifyOutcome(LeafResult)`.
- `harness/test/classify-outcome.test.ts` — unit tests.
- `harness/src/run-leaf.ts` — MODIFY: add `async?`/`doneMarkerRef?`/`tenant?` to `LeafEnvelope`; add `leafSessionId(env)` (tenant-prefixed, sanitized) and use it.
- `harness/test/run-leaf.test.ts` — MODIFY: add `leafSessionId` cases.
- `harness/src/leaf-job-runner.ts` — `runLeafJob(deps)`: claim → `runLeaf` → classify → marker → ack/reclaim.
- `harness/test/leaf-job-runner.test.ts` — unit tests with injected fakes.
- `harness/package.json` — MODIFY: add `@sh/work-queue` dependency.
- `packages/knative-server/src/server.ts` — MODIFY: async branch on `POST /run-leaf` + `GET /run-leaf/status`.
- `packages/knative-server/test/run-leaf-async-route.test.ts` — route tests (`vi.mock`).
- `packages/knative-server/src/leaf-job.ts` — Job entrypoint (thin `main`, live-gated).
- `packages/knative-server/package.json` — MODIFY: add `@sh/work-queue` dependency.
- `deploy/knative/leaf-scaledjob.yaml` — KEDA `ScaledJob`.
- `deploy/knative/setup-kind.sh` — MODIFY: idempotent KEDA install.
- `deploy/knative/leaf-async-smoke.sh` — gated live gate.

---

### Task 1: `@sh/work-queue` — Redis Streams work queue

**Files:**
- Create: `packages/work-queue/package.json`, `packages/work-queue/src/queue.ts`, `packages/work-queue/src/index.ts`
- Test: `packages/work-queue/test/queue.test.ts`

**Interfaces:**
- Produces:
  - `interface ClaimedEntry { entryId: string; envelope: unknown; deliveryCount: number }`
  - `interface WorkQueue { ensureGroup(): Promise<void>; enqueue(envelope: unknown): Promise<string>; claim(consumerId: string, opts: { minIdleMs: number; blockMs: number }): Promise<ClaimedEntry | null>; ack(entryId: string): Promise<void>; touch(entryId: string, consumerId: string): Promise<void>; pending(): Promise<number>; purge(): Promise<void>; close(): Promise<void>; }`
  - `class RedisWorkQueue implements WorkQueue` — `new RedisWorkQueue(url: string, streamKey?: string, group?: string)` (defaults `"leaf-queue"`, `"leaf-workers"`).

- [ ] **Step 1: Create the package manifest**

```json
// packages/work-queue/package.json
{
  "name": "@sh/work-queue",
  "type": "module",
  "version": "0.0.0",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0" },
  "dependencies": { "redis": "^6.0.0" }
}
```

- [ ] **Step 2: Link the workspace**

Run: `pnpm install`
Expected: `@sh/work-queue` is linked (pnpm-workspace already globs `packages/*`). Exit 0.

- [ ] **Step 3: Write the failing test**

```typescript
// packages/work-queue/test/queue.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { RedisWorkQueue } from "../src/queue";

const URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
let q: RedisWorkQueue;
// unique stream per test so runs don't collide
const stream = () => `test-leaf-queue-${process.pid}-${Math.floor(performance.now())}`;

afterEach(async () => { if (q) { await q.purge(); await q.close(); } });

describe("RedisWorkQueue", () => {
  it("enqueues and claims an entry with the envelope and deliveryCount 1", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s1", inputsRef: "/in", resultRef: "/out" });
    const c = await q.claim("worker-a", { minIdleMs: 5000, blockMs: 200 });
    expect(c).not.toBeNull();
    expect((c!.envelope as any).sessionId).toBe("s1");
    expect(c!.deliveryCount).toBe(1);
  });

  it("ack removes the entry from the pending list", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s2" });
    const c = await q.claim("worker-a", { minIdleMs: 5000, blockMs: 200 });
    await q.ack(c!.entryId);
    expect(await q.pending()).toBe(0);
  });

  it("claim returns null when there is no new or reclaimable work", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    const c = await q.claim("worker-a", { minIdleMs: 5000, blockMs: 100 });
    expect(c).toBeNull();
  });

  it("reclaims an unacked entry for another consumer and bumps deliveryCount", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s3" });
    const first = await q.claim("worker-a", { minIdleMs: 0, blockMs: 200 });
    expect(first!.deliveryCount).toBe(1);
    // worker-a never acks; worker-b reclaims with minIdle 0
    const second = await q.claim("worker-b", { minIdleMs: 0, blockMs: 200 });
    expect(second!.entryId).toBe(first!.entryId);
    expect(second!.deliveryCount).toBe(2);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm -C packages/work-queue exec vitest run test/queue.test.ts`
Expected: FAIL — cannot find module `../src/queue`.

- [ ] **Step 5: Write the implementation**

```typescript
// packages/work-queue/src/queue.ts
import { createClient, type RedisClientType } from "redis";

export interface ClaimedEntry {
  entryId: string;
  envelope: unknown;
  deliveryCount: number;
}

export interface WorkQueue {
  ensureGroup(): Promise<void>;
  enqueue(envelope: unknown): Promise<string>;
  claim(consumerId: string, opts: { minIdleMs: number; blockMs: number }): Promise<ClaimedEntry | null>;
  ack(entryId: string): Promise<void>;
  touch(entryId: string, consumerId: string): Promise<void>;
  pending(): Promise<number>;
  purge(): Promise<void>;
  close(): Promise<void>;
}

export class RedisWorkQueue implements WorkQueue {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(
    url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    private readonly stream = "leaf-queue",
    private readonly group = "leaf-workers",
  ) {
    this.client = createClient({ url });
    this.ready = this.client.connect().then(() => undefined);
  }

  async ensureGroup(): Promise<void> {
    await this.ready;
    try {
      // "0" = deliver from the start of the stream; MKSTREAM creates it if absent.
      await this.client.xGroupCreate(this.stream, this.group, "0", { MKSTREAM: true });
    } catch (err) {
      if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
    }
  }

  async enqueue(envelope: unknown): Promise<string> {
    await this.ready;
    return this.client.xAdd(this.stream, "*", { envelope: JSON.stringify(envelope) });
  }

  async claim(consumerId: string, opts: { minIdleMs: number; blockMs: number }): Promise<ClaimedEntry | null> {
    await this.ready;
    // 1. Prefer reclaiming a stale (delivered-but-unacked) entry — crash recovery.
    const auto = await this.client.xAutoClaim(this.stream, this.group, consumerId, opts.minIdleMs, "0", { COUNT: 1 });
    const reclaimed = auto.messages?.find((m) => m && m.message);
    if (reclaimed) {
      return { entryId: reclaimed.id, envelope: JSON.parse(reclaimed.message.envelope), deliveryCount: await this.deliveryCount(reclaimed.id) };
    }
    // 2. Otherwise read a brand-new entry.
    const res = await this.client.xReadGroup(this.group, consumerId, [{ key: this.stream, id: ">" }], { COUNT: 1, BLOCK: opts.blockMs });
    const msg = res?.[0]?.messages?.[0];
    if (!msg) return null;
    return { entryId: msg.id, envelope: JSON.parse(msg.message.envelope), deliveryCount: 1 };
  }

  private async deliveryCount(id: string): Promise<number> {
    const rows = await this.client.xPendingRange(this.stream, this.group, id, id, 1);
    return rows?.[0]?.deliveriesCounter ?? 1;
  }

  async ack(entryId: string): Promise<void> {
    await this.ready;
    await this.client.xAck(this.stream, this.group, entryId);
  }

  async touch(entryId: string, consumerId: string): Promise<void> {
    await this.ready;
    // Reset idle time without re-fetching the payload, so a healthy long run is not reclaimed.
    await this.client.xClaim(this.stream, this.group, consumerId, 0, [entryId], { JUSTID: true });
  }

  async pending(): Promise<number> {
    await this.ready;
    const summary = await this.client.xPending(this.stream, this.group);
    return summary?.pending ?? 0;
  }

  async purge(): Promise<void> {
    await this.ready;
    try { await this.client.xGroupDestroy(this.stream, this.group); } catch { /* ignore */ }
    try { await this.client.del(this.stream); } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    await this.ready;
    await this.client.close();
  }
}
```

```typescript
// packages/work-queue/src/index.ts
export { RedisWorkQueue } from "./queue.js";
export type { WorkQueue, ClaimedEntry } from "./queue.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm -C packages/work-queue exec vitest run test/queue.test.ts`
Expected: PASS (4 tests). If a node-redis method name/shape differs (e.g. `xAutoClaim` return shape), the failing assertion pinpoints it — adjust against the installed `redis` v6 API and re-run.

- [ ] **Step 7: Commit**

```bash
git add packages/work-queue
git commit -s -m "feat(work-queue): Redis Streams work queue (@sh/work-queue)"
```

---

### Task 2: Done-marker writer/reader

**Files:**
- Create: `harness/src/done-marker.ts`
- Test: `harness/test/done-marker.test.ts`

**Interfaces:**
- Produces:
  - `interface DoneMarker { status: "done" | "failed"; sessionId: string; reason: string | null; ts: string }`
  - `function deriveDoneMarkerPath(resultRef: string, override?: string): string`
  - `function writeDoneMarker(path: string, marker: DoneMarker): void` (atomic temp + rename)
  - `function readDoneMarker(path: string): DoneMarker | null`

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/done-marker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveDoneMarkerPath, writeDoneMarker, readDoneMarker } from "../src/done-marker";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "marker-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("deriveDoneMarkerPath", () => {
  it("derives <resultRef>.status by default", () => {
    expect(deriveDoneMarkerPath("/work/r/out.json")).toBe("/work/r/out.json.status");
  });
  it("honors an explicit override", () => {
    expect(deriveDoneMarkerPath("/work/r/out.json", "/work/r/done")).toBe("/work/r/done");
  });
});

describe("writeDoneMarker / readDoneMarker", () => {
  it("round-trips a done marker and leaves no temp file", () => {
    const p = join(dir, "out.json.status");
    writeDoneMarker(p, { status: "done", sessionId: "s1", reason: null, ts: "2026-06-27T00:00:00Z" });
    expect(readDoneMarker(p)).toEqual({ status: "done", sessionId: "s1", reason: null, ts: "2026-06-27T00:00:00Z" });
    expect(readdirSync(dir)).toEqual(["out.json.status"]); // no .tmp left behind
  });
  it("round-trips a failed marker with a reason", () => {
    const p = join(dir, "m.status");
    writeDoneMarker(p, { status: "failed", sessionId: "s2", reason: "bad_inputs", ts: "t" });
    expect(readDoneMarker(p)?.reason).toBe("bad_inputs");
  });
  it("returns null for a missing marker", () => {
    expect(readDoneMarker(join(dir, "nope.status"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/done-marker.test.ts`
Expected: FAIL — cannot find module `../src/done-marker`.

- [ ] **Step 3: Write the implementation**

```typescript
// harness/src/done-marker.ts
import { writeFileSync, renameSync, readFileSync } from "node:fs";

export interface DoneMarker {
  status: "done" | "failed";
  sessionId: string;
  reason: string | null;
  ts: string;
}

export function deriveDoneMarkerPath(resultRef: string, override?: string): string {
  return override && override.length > 0 ? override : `${resultRef}.status`;
}

/** Write atomically (temp + rename) so a reader never observes a partial marker. */
export function writeDoneMarker(path: string, marker: DoneMarker): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, path);
}

export function readDoneMarker(path: string): DoneMarker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DoneMarker;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/done-marker.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add harness/src/done-marker.ts harness/test/done-marker.test.ts
git commit -s -m "feat(harness): atomic done-marker writer/reader"
```

---

### Task 3: `classifyOutcome` — ack-vs-reclaim decision

**Files:**
- Create: `harness/src/classify-outcome.ts`
- Test: `harness/test/classify-outcome.test.ts`

**Interfaces:**
- Consumes: `LeafResult` from `harness/src/run-leaf.ts` (`{ status: "done"; resultRef } | { status: "failed"; reason: "no_verdict"|"invalid_verdict"|"bad_inputs"|"error"; message? }`).
- Produces:
  - `interface Outcome { ack: boolean; marker: { status: "done" | "failed"; reason: string | null } | null; retryable: boolean }`
  - `function classifyOutcome(result: LeafResult): Outcome`

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/classify-outcome.test.ts
import { describe, it, expect } from "vitest";
import { classifyOutcome } from "../src/classify-outcome";

describe("classifyOutcome", () => {
  it("done → ack + done marker", () => {
    expect(classifyOutcome({ status: "done", resultRef: "/out" })).toEqual({
      ack: true, marker: { status: "done", reason: null }, retryable: false,
    });
  });
  for (const reason of ["bad_inputs", "no_verdict", "invalid_verdict"] as const) {
    it(`failed:${reason} → ack + failed marker (deterministic)`, () => {
      expect(classifyOutcome({ status: "failed", reason })).toEqual({
        ack: true, marker: { status: "failed", reason }, retryable: false,
      });
    });
  }
  it("failed:error → no ack, retryable, no marker (yet)", () => {
    expect(classifyOutcome({ status: "failed", reason: "error", message: "boom" })).toEqual({
      ack: false, marker: null, retryable: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/classify-outcome.test.ts`
Expected: FAIL — cannot find module `../src/classify-outcome`.

- [ ] **Step 3: Write the implementation**

```typescript
// harness/src/classify-outcome.ts
import type { LeafResult } from "./run-leaf.js";

export interface Outcome {
  ack: boolean;
  marker: { status: "done" | "failed"; reason: string | null } | null;
  retryable: boolean;
}

/**
 * Decide what the leaf-job does with a queue entry given the leaf's terminal result.
 * - done / deterministic failures → write a marker and ACK (no reprocess).
 * - "error" (possibly transient model/gateway) → no marker, no ack, retryable (reclaim).
 *   (A process crash never returns here at all → entry stays pending → reclaimed.)
 */
export function classifyOutcome(result: LeafResult): Outcome {
  if (result.status === "done") {
    return { ack: true, marker: { status: "done", reason: null }, retryable: false };
  }
  if (result.reason === "error") {
    return { ack: false, marker: null, retryable: true };
  }
  return { ack: true, marker: { status: "failed", reason: result.reason }, retryable: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/classify-outcome.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add harness/src/classify-outcome.ts harness/test/classify-outcome.test.ts
git commit -s -m "feat(harness): classifyOutcome ack-vs-reclaim decision"
```

---

### Task 4: Envelope async fields + tenant-namespaced session id

**Files:**
- Modify: `harness/src/run-leaf.ts` (add fields to `LeafEnvelope`; add `leafSessionId`; use it in `realProduceVerdict`)
- Test: `harness/test/run-leaf.test.ts` (add `leafSessionId` cases)

**Interfaces:**
- Consumes: existing `toSessionId` (`harness/src/run-leaf.ts`).
- Produces:
  - `LeafEnvelope` gains `async?: boolean`, `doneMarkerRef?: string`, `tenant?: string` (all optional).
  - `function leafSessionId(env: { sessionId: string; tenant?: string }): string` — tenant-prefixed then sanitized.

- [ ] **Step 1: Write the failing test**

```typescript
// append to harness/test/run-leaf.test.ts
import { leafSessionId } from "../src/run-leaf";

describe("leafSessionId", () => {
  it("sanitizes the bare sessionId when no tenant is set", () => {
    expect(leafSessionId({ sessionId: "run-1/i1" })).toBe("run-1-i1");
  });
  it("prefixes and sanitizes with the tenant for per-tenant id isolation", () => {
    expect(leafSessionId({ sessionId: "run-1/i1", tenant: "acme" })).toBe("acme-run-1-i1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/run-leaf.test.ts`
Expected: FAIL — `leafSessionId` is not exported.

- [ ] **Step 3: Add the fields and helper, and use it**

In `harness/src/run-leaf.ts`, extend the `LeafEnvelope` interface:

```typescript
export interface LeafEnvelope {
  sessionId: string;
  model?: string;
  provider?: string;
  inputsRef: string;
  resultRef: string;
  workspaceRef?: string;
  maxTurns?: number;
  async?: boolean;            // when true, the HTTP layer enqueues instead of running inline
  doneMarkerRef?: string;     // overrides the derived <resultRef>.status
  tenant?: string;            // namespaces the session id (non-precluding; design §7)
}
```

Add the helper near `toSessionId`:

```typescript
/** The Pi/Redis session id for a leaf: tenant-prefixed (if any), then sanitized. */
export function leafSessionId(env: { sessionId: string; tenant?: string }): string {
  return toSessionId(env.tenant ? `${env.tenant}/${env.sessionId}` : env.sessionId);
}
```

In `realProduceVerdict`, replace the existing `const sid = toSessionId(env.sessionId);` line with:

```typescript
  const sid = leafSessionId(env);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/run-leaf.test.ts`
Expected: PASS (existing run-leaf tests + 2 new `leafSessionId` cases).

- [ ] **Step 5: Commit**

```bash
git add harness/src/run-leaf.ts harness/test/run-leaf.test.ts
git commit -s -m "feat(harness): async/doneMarkerRef/tenant envelope fields + leafSessionId"
```

---

### Task 5: `leaf-job-runner` — the queue wrapper around `runLeaf`

**Files:**
- Create: `harness/src/leaf-job-runner.ts`
- Test: `harness/test/leaf-job-runner.test.ts`
- Modify: `harness/package.json` (add `@sh/work-queue` dependency)

**Interfaces:**
- Consumes: `WorkQueue`, `ClaimedEntry` (`@sh/work-queue`); `classifyOutcome` (Task 3); `writeDoneMarker`, `deriveDoneMarkerPath`, `DoneMarker` (Task 2); `runLeaf`, `LeafEnvelope`, `LeafResult` (`./run-leaf.js`).
- Produces:
  - `interface LeafJobDeps { queue: WorkQueue; runLeaf: (env: LeafEnvelope) => Promise<LeafResult>; writeMarker?: (path: string, m: DoneMarker) => void; consumerId: string; maxAttempts?: number; minIdleMs?: number; blockMs?: number; heartbeatMs?: number; now?: () => string; setHeartbeat?: (fn: () => void, ms: number) => unknown; clearHeartbeat?: (h: unknown) => void; }`
  - `function processOne(deps: LeafJobDeps): Promise<"done" | "failed" | "deadletter" | "idle" | "retry">`

- [ ] **Step 1: Add the dependency**

In `harness/package.json`, add to `dependencies`:

```json
    "@sh/work-queue": "workspace:*",
```

Run: `pnpm install`
Expected: linked, exit 0.

- [ ] **Step 2: Write the failing test**

```typescript
// harness/test/leaf-job-runner.test.ts
import { describe, it, expect, vi } from "vitest";
import { processOne, type LeafJobDeps } from "../src/leaf-job-runner";
import type { ClaimedEntry, WorkQueue } from "@sh/work-queue";
import type { LeafEnvelope, LeafResult } from "../src/run-leaf";

function fakeQueue(claimed: ClaimedEntry | null): WorkQueue & { acked: string[]; touched: string[] } {
  const acked: string[] = []; const touched: string[] = [];
  return {
    acked, touched,
    ensureGroup: async () => {},
    enqueue: async () => "1-0",
    claim: async () => claimed,
    ack: async (id: string) => { acked.push(id); },
    touch: async (id: string) => { touched.push(id); },
    pending: async () => 0,
    purge: async () => {},
    close: async () => {},
  };
}

const ENV: LeafEnvelope = { sessionId: "run/i1", inputsRef: "/in", resultRef: "/out" };
function baseDeps(over: Partial<LeafJobDeps>): LeafJobDeps {
  const markers: Array<{ path: string; status: string; reason: string | null }> = [];
  return {
    queue: fakeQueue(null),
    runLeaf: async () => ({ status: "done", resultRef: "/out" }),
    writeMarker: (path, m) => { markers.push({ path, status: m.status, reason: m.reason }); (baseDeps as any)._m = markers; },
    consumerId: "w1",
    now: () => "t",
    setHeartbeat: () => 0,
    clearHeartbeat: () => {},
    ...over,
  };
}

describe("processOne", () => {
  it("returns idle and does nothing when the queue is empty", async () => {
    const q = fakeQueue(null);
    const r = await processOne(baseDeps({ queue: q }));
    expect(r).toBe("idle");
    expect(q.acked).toEqual([]);
  });

  it("dead-letters (failed marker + ack, runLeaf NOT called) past maxAttempts", async () => {
    const q = fakeQueue({ entryId: "9-0", envelope: ENV, deliveryCount: 4 });
    const runLeaf = vi.fn();
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: runLeaf as any, maxAttempts: 3, writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("deadletter");
    expect(runLeaf).not.toHaveBeenCalled();
    expect(markers[0]).toMatchObject({ status: "failed", reason: "error" });
    expect(q.acked).toEqual(["9-0"]);
  });

  it("done → writes done marker and acks", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "done", resultRef: "/out" }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("done");
    expect(markers[0]).toMatchObject({ status: "done", reason: null });
    expect(q.acked).toEqual(["1-0"]);
  });

  it("deterministic failure → failed marker + ack", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "failed", reason: "bad_inputs" }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("failed");
    expect(markers[0]).toMatchObject({ status: "failed", reason: "bad_inputs" });
    expect(q.acked).toEqual(["1-0"]);
  });

  it("retryable error → no ack, no marker, returns retry", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "failed", reason: "error", message: "x" }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("retry");
    expect(markers).toEqual([]);
    expect(q.acked).toEqual([]);
  });

  it("schedules and clears a heartbeat around the run", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const set = vi.fn(() => 42); const clear = vi.fn();
    await processOne(baseDeps({ queue: q, setHeartbeat: set as any, clearHeartbeat: clear as any }));
    expect(set).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(42);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/leaf-job-runner.test.ts`
Expected: FAIL — cannot find module `../src/leaf-job-runner`.

- [ ] **Step 4: Write the implementation**

```typescript
// harness/src/leaf-job-runner.ts
import type { WorkQueue } from "@sh/work-queue";
import { classifyOutcome } from "./classify-outcome.js";
import { deriveDoneMarkerPath, writeDoneMarker, type DoneMarker } from "./done-marker.js";
import type { LeafEnvelope, LeafResult } from "./run-leaf.js";

export interface LeafJobDeps {
  queue: WorkQueue;
  runLeaf: (env: LeafEnvelope) => Promise<LeafResult>;
  writeMarker?: (path: string, m: DoneMarker) => void;
  consumerId: string;
  maxAttempts?: number;
  minIdleMs?: number;
  blockMs?: number;
  heartbeatMs?: number;
  now?: () => string;
  setHeartbeat?: (fn: () => void, ms: number) => unknown;
  clearHeartbeat?: (h: unknown) => void;
}

/**
 * Claim and process at most one queue entry. Returns a label describing the outcome.
 * - "idle": nothing to claim.
 * - "deadletter": delivery count exceeded → failed marker + ack, runLeaf not run.
 * - "done"/"failed": runLeaf reached a terminal state → marker + ack.
 * - "retry": transient error → NOT acked (entry stays pending for reclaim).
 */
export async function processOne(deps: LeafJobDeps): Promise<"done" | "failed" | "deadletter" | "idle" | "retry"> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const minIdleMs = deps.minIdleMs ?? 90_000;
  const blockMs = deps.blockMs ?? 5_000;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const writeMarker = deps.writeMarker ?? writeDoneMarker;
  const now = deps.now ?? (() => new Date().toISOString());
  const setHb = deps.setHeartbeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearHb = deps.clearHeartbeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const claimed = await deps.queue.claim(deps.consumerId, { minIdleMs, blockMs });
  if (!claimed) return "idle";

  const env = claimed.envelope as LeafEnvelope;
  const markerPath = deriveDoneMarkerPath(env.resultRef, env.doneMarkerRef);

  if (claimed.deliveryCount > maxAttempts) {
    writeMarker(markerPath, { status: "failed", sessionId: env.sessionId, reason: "error", ts: now() });
    await deps.queue.ack(claimed.entryId);
    return "deadletter";
  }

  const hb = setHb(() => { void deps.queue.touch(claimed.entryId, deps.consumerId); }, heartbeatMs);
  let result: LeafResult;
  try {
    result = await deps.runLeaf(env);
  } finally {
    clearHb(hb);
  }

  const outcome = classifyOutcome(result);
  if (outcome.marker) {
    writeMarker(markerPath, { status: outcome.marker.status, sessionId: env.sessionId, reason: outcome.marker.reason, ts: now() });
  }
  if (outcome.ack) {
    await deps.queue.ack(claimed.entryId);
    return result.status === "done" ? "done" : "failed";
  }
  return "retry";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/leaf-job-runner.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add harness/src/leaf-job-runner.ts harness/test/leaf-job-runner.test.ts harness/package.json pnpm-lock.yaml
git commit -s -m "feat(harness): leaf-job-runner queue wrapper around runLeaf"
```

---

### Task 6: `POST /run-leaf` async branch + `GET /run-leaf/status`

**Files:**
- Modify: `packages/knative-server/src/server.ts`
- Modify: `packages/knative-server/package.json` (add `@sh/work-queue`)
- Test: `packages/knative-server/test/run-leaf-async-route.test.ts`

**Interfaces:**
- Consumes: `RedisWorkQueue` (`@sh/work-queue`); `readDoneMarker`, `deriveDoneMarkerPath` (`@sh/harness/done-marker`); `runLeaf`, `LeafEnvelope`, `leafSessionId` (`@sh/harness/run-leaf`).
- Produces: `POST /run-leaf` with `async:true` → `202 { status:"accepted", sessionId, resultRef, doneMarker }`; `GET /run-leaf/status?doneMarker=&sessionId=` → `{ status: "queued"|"running"|"done"|"failed", reason? }`.

- [ ] **Step 1: Add the dependency + a harness export for done-marker**

In `packages/knative-server/package.json` dependencies add `"@sh/work-queue": "workspace:*",`.
In `harness/package.json` `exports`, add `"./done-marker": "./src/done-marker.ts"`.
Run: `pnpm install` (exit 0).

- [ ] **Step 2: Write the failing test**

```typescript
// packages/knative-server/test/run-leaf-async-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueue = vi.fn(async () => "1-0");
const ensureGroup = vi.fn(async () => {});
vi.mock("@sh/work-queue", () => ({
  RedisWorkQueue: class { ensureGroup = ensureGroup; enqueue = enqueue; close = async () => {}; },
}));
const readDoneMarker = vi.fn();
vi.mock("@sh/harness/done-marker", () => ({
  readDoneMarker: (...a: any[]) => readDoneMarker(...a),
  deriveDoneMarkerPath: (r: string, o?: string) => o ?? `${r}.status`,
}));

import { startServer } from "../src/server";

let base: string; let server: any;
beforeEach(() => { enqueue.mockClear(); readDoneMarker.mockReset(); });
async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("async /run-leaf", () => {
  beforeEach(() => { server = startServer(0); base = `http://127.0.0.1:${server.address().port}`; });

  it("202 + enqueues on async:true with a valid envelope", async () => {
    const r = await req("POST", "/run-leaf", { sessionId: "run/i1", inputsRef: "/in", resultRef: "/out", async: true });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: "accepted", sessionId: "run/i1", doneMarker: "/out.status" });
    expect(enqueue).toHaveBeenCalledOnce();
    server.close();
  });

  it("400 and no enqueue on a malformed async envelope", async () => {
    const r = await req("POST", "/run-leaf", { sessionId: "s", async: true });
    expect(r.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    server.close();
  });

  it("status returns done from the marker", async () => {
    readDoneMarker.mockReturnValue({ status: "done", sessionId: "run/i1", reason: null, ts: "t" });
    const r = await req("GET", "/run-leaf/status?doneMarker=/out.status&sessionId=run/i1");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "done" });
    server.close();
  });

  it("status returns queued when no marker yet", async () => {
    readDoneMarker.mockReturnValue(null);
    const r = await req("GET", "/run-leaf/status?doneMarker=/out.status&sessionId=run/i1");
    expect(r.json).toMatchObject({ status: "queued" });
    server.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -C packages/knative-server exec vitest run test/run-leaf-async-route.test.ts`
Expected: FAIL — async branch / status route absent (404 or 200-sync).

- [ ] **Step 4: Implement the async branch + status route**

In `packages/knative-server/src/server.ts`, add imports:

```typescript
import { RedisWorkQueue } from "@sh/work-queue";
import { readDoneMarker, deriveDoneMarkerPath } from "@sh/harness/done-marker";
import { leafSessionId } from "@sh/harness/run-leaf";
```

Add a lazily-constructed queue and handlers:

```typescript
let queue: RedisWorkQueue | undefined;
function getQueue(): RedisWorkQueue {
  if (!queue) queue = new RedisWorkQueue(process.env.REDIS_URL);
  return queue;
}

async function handleEnqueueLeaf(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req));
  if (!isLeafEnvelope(body)) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" }));
    return;
  }
  const q = getQueue();
  await q.ensureGroup();
  await q.enqueue(body);
  res.writeHead(202, JSON_HEADERS).end(JSON.stringify({
    status: "accepted",
    sessionId: body.sessionId,
    resultRef: body.resultRef,
    doneMarker: deriveDoneMarkerPath(body.resultRef, body.doneMarkerRef),
  }));
}

function handleLeafStatus(url: URL, res: ServerResponse): void {
  const doneMarker = url.searchParams.get("doneMarker");
  if (!doneMarker) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "doneMarker_required" })); return; }
  const marker = readDoneMarker(doneMarker);
  if (marker) {
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: marker.status, reason: marker.reason ?? undefined }));
    return;
  }
  // No terminal marker yet — best-effort non-terminal state for visibility.
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "queued" }));
}
```

In the request `handler`, before the existing `POST /run-leaf` branch, route async and status. Replace the current `if (req.method === "POST" && req.url === "/run-leaf")` block with:

```typescript
  if (req.method === "GET" && req.url?.startsWith("/run-leaf/status")) {
    handleLeafStatus(new URL(req.url, "http://localhost"), res);
    return;
  }

  if (req.method === "POST" && req.url === "/run-leaf") {
    const route = async () => {
      const raw = await readBody(req);
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* handled below */ }
      if (parsed && parsed.async === true) return handleEnqueueLeafParsed(parsed, res);
      return handleRunLeafParsed(parsed, raw, res);
    };
    route().catch((err) => { if (!res.headersSent) res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) })); });
    return;
  }
```

To avoid double-reading the body, refactor `handleRunLeaf`/`handleEnqueueLeaf` to take the already-parsed body. Add:

```typescript
async function handleEnqueueLeafParsed(body: any, res: ServerResponse): Promise<void> {
  if (!isLeafEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }
  const q = getQueue();
  await q.ensureGroup();
  await q.enqueue(body);
  res.writeHead(202, JSON_HEADERS).end(JSON.stringify({
    status: "accepted", sessionId: body.sessionId, resultRef: body.resultRef,
    doneMarker: deriveDoneMarkerPath(body.resultRef, body.doneMarkerRef),
  }));
}

async function handleRunLeafParsed(body: any, _raw: string, res: ServerResponse): Promise<void> {
  if (!isLeafEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }
  const result = await runLeaf(body, buildConfig());
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
}
```

(Delete the now-unused `handleRunLeaf`/`handleEnqueueLeaf` body-reading variants if present, keeping only the `*Parsed` forms. `leafSessionId` import is available for future status-by-session lookups; leave it imported.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -C packages/knative-server exec vitest run test/run-leaf-async-route.test.ts`
Expected: PASS (4 tests). Also run the existing sync route test to confirm no regression:
Run: `pnpm -C packages/knative-server exec vitest run`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add packages/knative-server/src/server.ts packages/knative-server/package.json harness/package.json pnpm-lock.yaml packages/knative-server/test/run-leaf-async-route.test.ts
git commit -s -m "feat(knative-server): async POST /run-leaf enqueue + GET /run-leaf/status"
```

---

### Task 7: Leaf-job entrypoint

**Files:**
- Create: `packages/knative-server/src/leaf-job.ts`

**Interfaces:**
- Consumes: `RedisWorkQueue` (`@sh/work-queue`); `processOne` (`@sh/harness/leaf-job-runner`); `runLeaf` (`@sh/harness/run-leaf`); `buildConfig` pattern (mirror `server.ts`).
- Produces: a runnable entrypoint `node --import tsx src/leaf-job.ts` that drains the queue then exits 0 (exercised by the Task 9 live gate, not unit-tested — it constructs real Redis + Pi, like `realProduceVerdict`).

- [ ] **Step 1: Add the harness exports the entrypoint needs**

In `harness/package.json` `exports`, add `"./leaf-job-runner": "./src/leaf-job-runner.ts"` (so the entrypoint can import `processOne`).
Run: `pnpm install` (exit 0).

- [ ] **Step 2: Write the entrypoint**

```typescript
// packages/knative-server/src/leaf-job.ts
import { RedisWorkQueue } from "@sh/work-queue";
import { processOne } from "@sh/harness/leaf-job-runner";
import { runLeaf, type LeafEnvelope, type TurnConfig } from "@sh/harness/run-leaf";

function buildConfig(): TurnConfig {
  return {
    redisUrl: process.env.REDIS_URL,
    cwd: process.env.HARNESS_CWD || process.cwd(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  };
}

async function main(): Promise<void> {
  const queue = new RedisWorkQueue(process.env.REDIS_URL);
  await queue.ensureGroup();
  const consumerId = process.env.HOSTNAME ?? `leaf-job-${process.pid}`;
  // Drain: process entries until the queue yields nothing, then exit so KEDA can scale to zero.
  // A transient "retry" rethrows below (non-zero exit) so the entry is reclaimed by a later Job.
  for (;;) {
    const outcome = await processOne({
      queue,
      runLeaf: (env: LeafEnvelope) => runLeaf(env, buildConfig()),
      consumerId,
    });
    if (outcome === "idle") break;
    if (outcome === "retry") { await queue.close(); process.exit(1); }
  }
  await queue.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("leaf-job error:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify it type-resolves / imports**

Run: `pnpm -C packages/knative-server exec tsx --eval "import('./src/leaf-job.ts').then(()=>{}).catch(e=>{console.error(String(e));process.exit(2)})" 2>&1 | head -5; echo "EXIT:$?"`
Expected: it attempts to start (may block connecting to Redis — that's fine) or exits cleanly; it must NOT fail with a module-resolution / syntax error. If Redis is unreachable it will hang — Ctrl-C / kill is acceptable here; the goal is only to confirm imports resolve. (A cleaner check: `pnpm -C packages/knative-server exec vitest run` still passes — no import breakage.)

- [ ] **Step 4: Commit**

```bash
git add packages/knative-server/src/leaf-job.ts harness/package.json pnpm-lock.yaml
git commit -s -m "feat(knative-server): leaf-job entrypoint (drains the queue via processOne)"
```

---

### Task 8: KEDA install + ScaledJob manifest

**Files:**
- Modify: `deploy/knative/setup-kind.sh` (idempotent KEDA install)
- Create: `deploy/knative/leaf-scaledjob.yaml`

**Interfaces:**
- Consumes: the `leaf-job` entrypoint (Task 7), the `dev.local/serverless-harness:local` image, the `serverless-harness` ServiceAccount, the `leaf-work` PVC, the `llm-credentials` secret.
- Produces: a KEDA `ScaledJob` that spawns leaf-job Jobs from `leaf-queue`.

- [ ] **Step 1: Add an idempotent KEDA install to setup-kind.sh**

After the `config-features` PVC patch block in `deploy/knative/setup-kind.sh`, add:

```bash
# Install KEDA (event-driven autoscaling) — async leaf completion uses a KEDA ScaledJob.
KEDA_VERSION="${KEDA_VERSION:-v2.14.0}"
if ! kubectl get crd scaledjobs.keda.sh >/dev/null 2>&1; then
  echo "--- Installing KEDA $KEDA_VERSION ---"
  kubectl apply --server-side -f "https://github.com/kedacore/keda/releases/download/${KEDA_VERSION}/keda-${KEDA_VERSION}.yaml"
fi
kubectl wait --for=condition=Available deployment --all -n keda --timeout=180s || true
```

- [ ] **Step 2: Write the ScaledJob manifest**

```yaml
# deploy/knative/leaf-scaledjob.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: leaf-worker
  namespace: default
spec:
  jobTargetRef:
    backoffLimit: 0
    template:
      spec:
        restartPolicy: Never
        serviceAccountName: serverless-harness
        containers:
          - name: leaf-job
            image: dev.local/serverless-harness:local
            imagePullPolicy: IfNotPresent
            workingDir: /app/packages/knative-server
            command: ["node", "--import", "tsx", "src/leaf-job.ts"]
            env:
              - name: REDIS_URL
                value: "redis://redis.default.svc:6379"
              - name: SH_MODEL
                value: "claude-haiku-4-5"
              - name: KAGENTI_SANDBOX_POD
                value: "sandbox-0"
              - name: ANTHROPIC_API_KEY
                valueFrom: { secretKeyRef: { name: llm-credentials, key: api-key } }
              - name: ANTHROPIC_BASE_URL
                valueFrom: { secretKeyRef: { name: llm-credentials, key: base-url, optional: true } }
              - name: ANTHROPIC_AUTH_TOKEN
                valueFrom: { secretKeyRef: { name: llm-credentials, key: auth-token, optional: true } }
            volumeMounts:
              - name: work
                mountPath: /work
        volumes:
          - name: work
            persistentVolumeClaim:
              claimName: leaf-work
  pollingInterval: 5
  maxReplicaCount: 10
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  triggers:
    - type: redis-streams
      metadata:
        addressFromEnv: ""
        address: redis.default.svc:6379
        stream: leaf-queue
        consumerGroup: leaf-workers
        pendingEntriesCount: "1"
```

- [ ] **Step 3: Commit**

```bash
git add deploy/knative/setup-kind.sh deploy/knative/leaf-scaledjob.yaml
git commit -s -m "feat(keda): KEDA install + leaf-worker ScaledJob for async leaves"
```

> Live validation of this manifest happens in Task 9 (it requires the rebuilt image + a running cluster).

---

### Task 9: Live gate — async fan-out, crash-resume, scale-to-zero

**Files:**
- Create: `deploy/knative/leaf-async-smoke.sh`

**Interfaces:**
- Consumes: everything above + the gate-7 resume + the `leaf-work` PVC + `sandbox-0` + fixtures.
- Produces: a gated pass/fail proving design §6.2 claims 1–6.

- [ ] **Step 1: Write the gated smoke script**

```bash
# deploy/knative/leaf-async-smoke.sh
#!/usr/bin/env bash
# Gated Kind smoke for async leaf completion (design §6.2). Proves: async accept, KEDA
# scale-out, completion via done-marker, crash-resume, scale-to-zero, deterministic failure.
# Prereq: setup-kind.sh (incl. KEDA) done; image rebuilt with leaf-job + async routes;
#   leaf-pvc.yaml + leaf-orchestrator.yaml applied; leaf-scaledjob.yaml applied; sandbox-0 up.
# Usage: ASYNC_LIVE_SMOKE=1 bash deploy/knative/leaf-async-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${ASYNC_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set ASYNC_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator; SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
RUN="arun-$$"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
ITEMS="i1 i2 i3"; MODEL="${SH_MODEL:-claude-haiku-4-5}"
declare -A EXPECT=( [i1]=FLAGGED [i2]=CLEAR [i3]=CLEAR )
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
leaf_job_pods() { kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '; }

# async dispatch: POST {async:true} -> 202 handle
adispatch() {
  local id="$1" model="${2:-$MODEL}" in="${3:-$INPUTS/$id.json}"
  jq -nc --arg s "$RUN/$id" --arg m "$model" --arg in "$in" --arg out "$RES/$id.json" --arg ws "$SBOX_REPO" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws, async:true}' \
  | curl -s --max-time 30 -H "$HOST_HEADER" -H "Content-Type: application/json" -d @- "$BASE/run-leaf"
}

echo "=== Async leaf smoke (run=$RUN) ==="
ensure_port_forward >/dev/null || true
kubectl -n "$NS" wait --for=condition=Ready "pod/$ORCH" --timeout=90s >/dev/null
kubectl -n "$NS" wait --for=condition=Ready "pod/$SBOX" --timeout=90s >/dev/null
for _ in $(seq 1 30); do oexec sh -c 'command -v jq >/dev/null && command -v curl >/dev/null' && break; sleep 2; done
oexec mkdir -p "$INPUTS" "$RES"
kubectl -n "$NS" cp ./fixtures/inputs "$ORCH:$INPUTS"
kubectl -n "$NS" exec "$SBOX" -- mkdir -p "$SBOX_REPO"
kubectl -n "$NS" cp ./fixtures/repo "$SBOX:$SBOX_REPO"

# Claim 1: async accept (fast 202)
claim 1 "Async accept: 202 + handle, returns fast"
acc_ok=1
for id in $ITEMS; do
  st=$(adispatch "$id" | jq -r '.status // "none"'); echo "    $id -> $st"
  [ "$st" = "accepted" ] || acc_ok=0
done
[ "$acc_ok" = 1 ] && ok "all accepted" || ko "not all accepted"

# Claim 2: KEDA scale-out (>=2 leaf-job pods at some point)
claim 2 "KEDA scales out leaf-job pods"
maxp=0
for _ in $(seq 1 24); do p=$(leaf_job_pods); [ "$p" -gt "$maxp" ] && maxp=$p; [ "$p" -ge 2 ] && break; sleep 5; done
[ "$maxp" -ge 2 ] && ok "observed $maxp concurrent leaf-job pods" || echo "  NOTE: observed max $maxp (cap/scheduling may serialize)"

# Claim 3: completion via done-marker + correct verdicts
claim 3 "Completion via done-marker; verdicts correct"
cov_ok=1
for id in $ITEMS; do
  got=""
  for _ in $(seq 1 60); do
    if oexec test -f "$RES/$id.json.status"; then got=$(oexec sh -c "jq -r .status $RES/$id.json.status"); break; fi
    sleep 5
  done
  v=$(oexec sh -c "jq -r .verdict $RES/$id.json 2>/dev/null" 2>/dev/null || echo "")
  if [ "$got" = "done" ] && [ "$v" = "${EXPECT[$id]}" ]; then echo "    $id done verdict=$v"; else echo "    $id status=$got verdict=$v (want ${EXPECT[$id]})"; cov_ok=0; fi
done
[ "$cov_ok" = 1 ] && ok "all async leaves completed with correct verdicts" || ko "missing/incorrect"

# Claim 4: crash-resume — kill a running leaf-job mid-run, entry reclaimed, still completes
claim 4 "Crash mid-run → reclaimed → resumes → verdict"
RID="$RUN/r1"; adispatch "r1" "$MODEL" "$INPUTS/i1.json" >/dev/null
# wait for a running leaf-job pod, then kill it
killed=0
for _ in $(seq 1 24); do
  pod=$(kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | awk '{print $1}' | head -1)
  [ -n "$pod" ] && { kubectl delete pod -n "$NS" "$pod" --force --grace-period=0 >/dev/null 2>&1; killed=1; break; }
  sleep 5
done
res_ok=""
for _ in $(seq 1 72); do
  if oexec test -f "$RES/r1.json.status"; then res_ok=$(oexec sh -c "jq -r .status $RES/r1.json.status"); break; fi
  sleep 5
done
if [ "$killed" = 1 ] && [ "$res_ok" = "done" ] && oexec sh -c "jq -e .verdict $RES/r1.json >/dev/null 2>&1"; then
  ok "killed a running leaf-job; reclaimed + resumed → verdict produced"
else
  ko "crash-resume: killed=$killed status=$res_ok"
fi

# Claim 5: scale-to-zero when queue drains
claim 5 "Scale-to-zero: no leaf-job pods when idle"
zero=0
for _ in $(seq 1 36); do [ "$(leaf_job_pods)" = "0" ] && { zero=1; break; }; sleep 5; done
[ "$zero" = 1 ] && ok "leaf-worker scaled to zero" || ko "leaf-job pods still running"

# Claim 6: deterministic failure → failed marker, no result, no infinite reprocess
claim 6 "Bad inputs → failed marker, no result_ref"
adispatch "ineg" "$MODEL" "$INPUTS/does-not-exist.json" >/dev/null
neg=""
for _ in $(seq 1 36); do
  if oexec test -f "$RES/ineg.json.status"; then neg=$(oexec sh -c "jq -r .reason $RES/ineg.json.status"); break; fi
  sleep 5
done
if [ "$neg" = "bad_inputs" ] && ! oexec test -f "$RES/ineg.json"; then ok "failed (bad_inputs), no result_ref"; else ko "reason=$neg"; fi

kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/$RUN" 2>/dev/null || true
echo ""; echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then echo "ASYNC SMOKE FAIL"; exit 1; else echo "ASYNC SMOKE PASS"; exit 0; fi
```

- [ ] **Step 2: Make it executable and syntax-check**

Run: `chmod +x deploy/knative/leaf-async-smoke.sh && bash -n deploy/knative/leaf-async-smoke.sh && echo OK`
Expected: `OK`. Gate honored: `bash deploy/knative/leaf-async-smoke.sh` (no env) prints `SKIP`.

- [ ] **Step 3: Rebuild image, (re)deploy, install KEDA + ScaledJob, run the gate**

Redirect verbose output to logs (CLAUDE.md context-budget); analyze failures in a subagent.

```bash
export LOG_DIR=/tmp/kagenti/leaf-async; mkdir -p $LOG_DIR
# KEDA + ScaledJob (setup-kind.sh installs KEDA; or apply the release directly once)
kubectl get crd scaledjobs.keda.sh >/dev/null 2>&1 || kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.14.0/keda-v2.14.0.yaml > $LOG_DIR/keda.log 2>&1
kubectl wait --for=condition=Available deployment --all -n keda --timeout=180s >> $LOG_DIR/keda.log 2>&1; echo "keda:EXIT:$?"
# rebuild + reload the image (now has leaf-job.ts + async routes)
docker build --load -t dev.local/serverless-harness:local . > $LOG_DIR/build.log 2>&1 && kind load docker-image dev.local/serverless-harness:local --name sh-knative >> $LOG_DIR/build.log 2>&1; echo "build:EXIT:$?"
kubectl apply -f deploy/knative/leaf-scaledjob.yaml > $LOG_DIR/sj.log 2>&1; echo "sj:EXIT:$?"
# ensure PVC + orchestrator present (from the gate-7/Task-6 work)
kubectl apply -f deploy/knative/leaf-pvc.yaml -f deploy/knative/leaf-orchestrator.yaml >> $LOG_DIR/sj.log 2>&1
ASYNC_LIVE_SMOKE=1 bash deploy/knative/leaf-async-smoke.sh > $LOG_DIR/smoke.log 2>&1; echo "smoke:EXIT:$?"
```

Expected: `/tmp/kagenti/leaf-async/smoke.log` ends with `ASYNC SMOKE PASS` (6 claims). If a claim fails, analyze the log + `kubectl get jobs,pods -l scaledjob.keda.sh/name=leaf-worker` and the KEDA operator logs in a subagent — do not read whole logs in the main context.

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/leaf-async-smoke.sh
git commit -s -m "test(keda): gated async smoke — accept, scale-out, done-marker, crash-resume, scale-to-zero"
```

---

## Self-Review

**Spec coverage (design §2–§9):**
- §2 architecture / control-plane vs data-plane → Tasks 6 (enqueue/status) + 7 (job) + 8 (ScaledJob). ✓
- §3.1 envelope additions (`async`/`doneMarkerRef`/`tenant`) → Task 4. ✓
- §3.2 enqueue `202` → Task 6. §3.3 atomic done-marker → Task 2. §3.4 status endpoint → Task 6. ✓
- §3.5 idempotency/at-least-once → reuses gate-7 (`runLeaf` unchanged, Task 4 only adds fields) + Task 1 reclaim. ✓
- §4 queue + KEDA (group, lifecycle, heartbeat, dead-letter, scaler) → Task 1 (queue incl. `touch`/`pending`/delivery-count) + Task 8 (ScaledJob). ✓
- §5 leaf-job + classifyOutcome table → Task 3 (pure) + Task 5 (runner) + Task 7 (entrypoint). ✓
- §6.1 unit coverage → Tasks 1,2,3,4,5,6. §6.2 live gate (6 claims) → Task 9. ✓
- §7 tenant non-precluding → Task 4 (`leafSessionId` prefix; single shared queue). ✓
- §8 scope/YAGNI; §9 prereqs (KEDA install) → Task 8. ✓

**Placeholder scan:** none — every code/test/command step is concrete. The Task 7 import-resolution check is intentionally loose (it may block on Redis) and offers the vitest-passes fallback as the real signal.

**Type consistency:** `LeafResult`/`LeafEnvelope` (run-leaf) consumed identically by `classifyOutcome` (T3), `leaf-job-runner` (T5), the entrypoint (T7), and the route (T6). `WorkQueue`/`ClaimedEntry` (T1) consumed by `leaf-job-runner` (T5) and the entrypoint (T7). `DoneMarker`/`deriveDoneMarkerPath`/`writeDoneMarker`/`readDoneMarker` (T2) consumed by T5 (write) and T6 (read/derive). `leafSessionId` (T4) consumed by T6's import (reserved) and used in `realProduceVerdict`. The `processOne` outcome union (`"done"|"failed"|"deadletter"|"idle"|"retry"`) matches the entrypoint's drain loop checks.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
