# P1 — FS-Free Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the credentialed harness perform no filesystem I/O — move the leaf envelope (inputs, verdict, done-marker) and the human-gate markers off the `/work` PVC (inline in the HTTP request/response + a single Redis result record), and move the sandbox working set from `emptyDir` to a durable agent-sandbox `Sandbox` CR.

**Architecture:** The harness (Knative Service + KEDA async worker) becomes a network-only "brain": inputs arrive inline in `POST /runs`, the sync verdict returns inline, the async verdict + gate/done state live in one Redis key `leaf:result:<sessionId>` with a TTL, and `GET /runs/status?sessionId=…` reads that key. The sandbox ("hands") is the sole filesystem: a `Sandbox` CR (`agents.x-k8s.io/v1alpha1`) with `spec.volumeClaimTemplates` durable RWO storage, and the harness resolves the sandbox pod via the CR's `.status.selector` label selector instead of a hardcoded pod name.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), pnpm workspaces (`harness`, `packages/*`), Vitest, node-redis v4, Knative Serving, KEDA `ScaledJob` + Redis Streams, kubernetes-sigs/agent-sandbox, `kubectl` (shelled out).

Spec: [`docs/specs/2026-07-02-p1-fs-free-harness-design.md`](../../specs/2026-07-02-p1-fs-free-harness-design.md). Issues: epic #49, P1 #45.

## Global Constraints

- **Every commit is DCO-signed with the AI attribution trailer** — exactly:
  `git commit -s -m "<subject>" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"`.
  Never use `Co-authored-by`.
- **`git add` explicit paths only, never `git add -A`** (the working tree carries unrelated dirty files).
- **ES-module import specifiers keep the `.js` extension** (e.g. `import { x } from "./verdict.js"`) even though the source is `.ts` — this repo compiles with `tsc`/`tsgo` NodeNext.
- **Per-package test command:** `cd <pkg> && pnpm exec vitest run test/<file>.test.ts` (optionally `-t "<name>"`). **Per-package typecheck:** `cd <pkg> && pnpm exec tsc --noEmit`. Package dirs: `harness`, `packages/knative-server`, `packages/k8s-sandbox`.
- **Clean-break wire contract:** the old file-based fields (`inputsRef`, `resultRef`, `doneMarkerRef`, `gateRef`, `decisionRef`) are removed, not dual-supported. No live external consumer exists.
- **`workspaceRef` stays** — it is a path *inside the sandbox pod*, never opened by the harness process.
- **Redis result key:** `leaf:result:<leafSessionId>` where `leafSessionId({sessionId, tenant})` is the existing tenant-prefixed-then-sanitized id from `run-leaf.ts`.
- **Default result TTL:** env `LEAF_RESULT_TTL_SECONDS`, default `86400`.

---

## File Structure

**New files**
- `harness/src/leaf-result-store.ts` — Redis result record type, key builder, `LeafResult → record` mapping, `writeResult`/`readResult`, and a real `RedisResultStore` client. (Task 1)
- `harness/test/leaf-result-store.test.ts` — unit tests with an in-memory fake. (Task 1)
- `packages/k8s-sandbox/src/resolve-pod.ts` — pure kubectl arg builders + `resolveSandboxConfig` (selector-based pod resolution). (Task 5)
- `packages/k8s-sandbox/test/resolve-pod.test.ts` — unit tests with a fake `run`. (Task 5)

**Modified files**
- `harness/src/run-leaf.ts` — inline `item`/`decision` envelope; verdict/gate returned inline; drop all `node:fs`. (Task 2)
- `harness/src/classify-outcome.ts` — collapse to `{ack, retryable}`; record written for all non-retryable. (Task 3)
- `harness/src/leaf-job-runner.ts` — write the Redis result record instead of a file marker. (Task 3)
- `packages/knative-server/src/leaf-job.ts` — dead-letter reap writes a Redis failed record; pass the store to `processOne`. (Task 3)
- `packages/knative-server/src/server.ts` — parse inline `item`/`decision`; sync writes + returns the record; `/runs/status?sessionId`; drop `WORK_ROOT`. (Task 4)
- `harness/src/run-turn.ts`, `harness/src/run-leaf.ts` — resolve sandbox config async, pass to the extension. (Task 5)
- `packages/k8s-sandbox/src/index.ts` — export `resolveSandboxConfig`. (Task 5)
- `deploy/knative/service.yaml`, `leaf-scaledjob.yaml`, `sandbox.yaml` — remove `/work`, add sandbox-name + TTL env + RBAC; `Sandbox` CR. (Task 7)
- `deploy/knative/leaf-pvc.yaml` — **deleted**. (Task 7)
- `deploy/knative/cron-dispatch` caller + `leaf-smoke.sh`, `leaf-async-smoke.sh`, `lib.sh`. (Task 8)

**Deleted files**
- `harness/src/done-marker.ts`, `harness/src/gate-marker.ts` (+ their tests). (Task 6)

---

## Task 1: Redis result store module

**Files:**
- Create: `harness/src/leaf-result-store.ts`
- Test: `harness/test/leaf-result-store.test.ts`

**Interfaces:**
- Consumes: `Verdict` from `./verdict.js`; `LeafResult` (type-only) from `./run-leaf.js` (defined in Task 2 — this is a `import type`, no runtime cycle).
- Produces:
  - `interface LeafResultRecord { status: "done"|"failed"|"aborted"|"paused"; verdict: Verdict|null; gate: {gateId:number; summary:string; proposed_action:string}|null; reason: string|null; sessionId: string; ts: string }`
  - `interface RedisLike { set(key:string, value:string, opts?:{EX?:number}): Promise<unknown>; get(key:string): Promise<string|null> }`
  - `resultKey(leafSessionId: string): string`
  - `toResultRecord(result: LeafResult, rawSessionId: string, ts: string): LeafResultRecord`
  - `writeResult(redis: RedisLike, leafSessionId: string, record: LeafResultRecord, ttlSeconds: number): Promise<void>`
  - `readResult(redis: RedisLike, leafSessionId: string): Promise<LeafResultRecord|null>`
  - `class RedisResultStore implements RedisLike` with `constructor(url?)`, `set`, `get`, `close()`.

- [ ] **Step 1: Write the failing test**

Create `harness/test/leaf-result-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  resultKey, toResultRecord, writeResult, readResult, type RedisLike, type LeafResultRecord,
} from "../src/leaf-result-store";
import type { LeafResult } from "../src/run-leaf";

function fakeRedis(): RedisLike & { store: Map<string, string>; ttl: Map<string, number> } {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    store, ttl,
    async set(key, value, opts) { store.set(key, value); if (opts?.EX) ttl.set(key, opts.EX); },
    async get(key) { return store.get(key) ?? null; },
  };
}

describe("resultKey", () => {
  it("namespaces by leaf session id", () => {
    expect(resultKey("run-1-i1")).toBe("leaf:result:run-1-i1");
  });
});

describe("toResultRecord", () => {
  it("maps done → verdict-bearing record", () => {
    const r: LeafResult = { status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" } };
    expect(toResultRecord(r, "run-1/i1", "T")).toEqual({
      status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" },
      gate: null, reason: null, sessionId: "run-1/i1", ts: "T",
    });
  });
  it("maps paused → gate-bearing record", () => {
    const r: LeafResult = { status: "paused", gateId: 1, gate: { summary: "s", proposed_action: "a" } };
    expect(toResultRecord(r, "run-1/i1", "T")).toMatchObject({
      status: "paused", gate: { gateId: 1, summary: "s", proposed_action: "a" }, verdict: null,
    });
  });
  it("maps failed → reason-bearing record", () => {
    const r: LeafResult = { status: "failed", reason: "no_verdict" };
    expect(toResultRecord(r, "s", "T")).toMatchObject({ status: "failed", reason: "no_verdict" });
  });
});

describe("writeResult / readResult", () => {
  it("round-trips a record and sets the TTL", async () => {
    const redis = fakeRedis();
    const rec: LeafResultRecord = { status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" }, gate: null, reason: null, sessionId: "run-1/i1", ts: "T" };
    await writeResult(redis, "run-1-i1", rec, 3600);
    expect(redis.ttl.get("leaf:result:run-1-i1")).toBe(3600);
    expect(await readResult(redis, "run-1-i1")).toEqual(rec);
  });
  it("returns null for a missing key", async () => {
    expect(await readResult(fakeRedis(), "nope")).toBeNull();
  });
  it("returns null for a garbled value", async () => {
    const redis = fakeRedis();
    await redis.set("leaf:result:x", "{not json", {});
    expect(await readResult(redis, "x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd harness && pnpm exec vitest run test/leaf-result-store.test.ts`
Expected: FAIL — cannot resolve `../src/leaf-result-store` (module not found).

- [ ] **Step 3: Write the implementation**

Create `harness/src/leaf-result-store.ts`:

```typescript
import { createClient, type RedisClientType } from "redis";
import type { Verdict } from "./verdict.js";
import type { LeafResult } from "./run-leaf.js";

export interface LeafResultRecord {
  status: "done" | "failed" | "aborted" | "paused";
  verdict: Verdict | null;
  gate: { gateId: number; summary: string; proposed_action: string } | null;
  reason: string | null;
  sessionId: string; // RAW (un-sanitized) id, for caller correlation
  ts: string;
}

/** Minimal structural Redis surface — lets unit tests inject an in-memory fake. */
export interface RedisLike {
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function resultKey(leafSessionId: string): string {
  return `leaf:result:${leafSessionId}`;
}

/** Map a terminal LeafResult to the persisted record. `rawSessionId` is the un-sanitized envelope id. */
export function toResultRecord(result: LeafResult, rawSessionId: string, ts: string): LeafResultRecord {
  const base: LeafResultRecord = { status: "failed", verdict: null, gate: null, reason: null, sessionId: rawSessionId, ts };
  if (result.status === "done") return { ...base, status: "done", verdict: result.verdict };
  if (result.status === "paused") {
    return { ...base, status: "paused", gate: { gateId: result.gateId, summary: result.gate.summary, proposed_action: result.gate.proposed_action } };
  }
  if (result.status === "aborted") return { ...base, status: "aborted" };
  return { ...base, status: "failed", reason: result.reason };
}

export async function writeResult(redis: RedisLike, leafSessionId: string, record: LeafResultRecord, ttlSeconds: number): Promise<void> {
  await redis.set(resultKey(leafSessionId), JSON.stringify(record), { EX: ttlSeconds });
}

export async function readResult(redis: RedisLike, leafSessionId: string): Promise<LeafResultRecord | null> {
  const raw = await redis.get(resultKey(leafSessionId));
  if (!raw) return null;
  try { return JSON.parse(raw) as LeafResultRecord; } catch { return null; }
}

/** Real client used by the server and async worker. Reuses REDIS_URL, connects lazily. */
export class RedisResultStore implements RedisLike {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379") {
    this.client = createClient({ url }) as RedisClientType;
    this.ready = this.client.connect().then(() => undefined);
  }
  async set(key: string, value: string, opts?: { EX?: number }): Promise<unknown> {
    await this.ready;
    return opts?.EX ? this.client.set(key, value, { EX: opts.EX }) : this.client.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    await this.ready;
    return this.client.get(key);
  }
  async close(): Promise<void> {
    await this.ready;
    await this.client.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd harness && pnpm exec vitest run test/leaf-result-store.test.ts`
Expected: PASS (all cases). Typecheck will fail until Task 2 defines `LeafResult` with the new shape — that is expected; do not fix here.

- [ ] **Step 5: Commit**

```bash
git add harness/src/leaf-result-store.ts harness/test/leaf-result-store.test.ts
git commit -s -m "feat(harness): Redis leaf-result store (record, TTL, mapping)" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 2: FS-free `runLeaf` — inline envelope, verdict, and gate

**Files:**
- Modify: `harness/src/run-leaf.ts`
- Test: `harness/test/run-leaf.test.ts` (update existing)

**Interfaces:**
- Consumes: `Verdict`, `validateVerdict` from `./verdict.js`; `Decision`, `validateDecision`, `computeGateState`, `decideSeed`, `readDecision`(removed), `GATE_DECISION_ENTRY_TYPE` from `./gate.js`.
- Produces (relied on by Tasks 1, 3, 4):
  - `interface LeafItem { item_id: string; file: string; pattern: string; require_approval?: boolean }`
  - `interface LeafEnvelope { sessionId: string; item: LeafItem; decision?: Decision; model?: string; provider?: string; workspaceRef?: string; maxTurns?: number; async?: boolean; tenant?: string }`
  - `type LeafResult = { status: "done"; verdict: Verdict } | { status: "paused"; gateId: number; gate: { summary: string; proposed_action: string } } | { status: "aborted" } | { status: "failed"; reason: "no_verdict"|"invalid_verdict"|"bad_inputs"|"error"; message?: string }`
  - `validateItem(o: unknown): LeafItem | null`
  - `leafSessionId(env: { sessionId: string; tenant?: string }): string` (unchanged signature)
  - `runLeaf(env, config?, deps?): Promise<LeafResult>`

- [ ] **Step 1: Update the failing tests**

Open `harness/test/run-leaf.test.ts`. Replace file-envelope usages with the inline shape and assert inline results. Ensure these cases exist (add/replace as needed):

```typescript
// bad inputs: no item
it("fails with bad_inputs when item is missing", async () => {
  const r = await runLeaf({ sessionId: "s" } as any, undefined, { produceVerdict: async () => {} });
  expect(r).toEqual({ status: "failed", reason: "bad_inputs" });
});

// done: verdict returned inline (no resultRef)
it("returns the verdict inline on success", async () => {
  const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
  const r = await runLeaf(env, undefined, {
    produceVerdict: async (_i, _e, _c, cap) => { cap.verdict = { item_id: "i1", verdict: "FLAGGED", reason: "x" }; },
  });
  expect(r).toEqual({ status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" } });
});

// paused: gate returned inline (no gateRef, no file written)
it("returns the gate inline when paused", async () => {
  const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p", require_approval: true } };
  const r = await runLeaf(env, undefined, {
    produceVerdict: async (_i, _e, _c, cap) => { cap.gate = { gateId: 2, summary: "s", proposed_action: "a" }; },
  });
  expect(r).toEqual({ status: "paused", gateId: 2, gate: { summary: "s", proposed_action: "a" } });
});

it("returns aborted when the capture is aborted", async () => {
  const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
  const r = await runLeaf(env, undefined, { produceVerdict: async (_i, _e, _c, cap) => { cap.aborted = true; } });
  expect(r).toEqual({ status: "aborted" });
});

it("fails with no_verdict when nothing is captured", async () => {
  const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
  const r = await runLeaf(env, undefined, { produceVerdict: async () => {} });
  expect(r).toEqual({ status: "failed", reason: "no_verdict" });
});

it("fails with invalid_verdict when the captured verdict is off-shape", async () => {
  const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
  const r = await runLeaf(env, undefined, { produceVerdict: async (_i, _e, _c, cap) => { cap.verdict = { item_id: "" } as any; } });
  expect(r.status).toBe("failed");
  if (r.status === "failed") expect(r.reason).toBe("invalid_verdict");
});
```

Also update `validateItem` coverage:

```typescript
import { validateItem } from "../src/run-leaf";
describe("validateItem", () => {
  it("accepts a well-formed item", () => {
    expect(validateItem({ item_id: "i", file: "f", pattern: "p" })).toEqual({ item_id: "i", file: "f", pattern: "p", require_approval: false });
  });
  it("rejects a missing field and non-objects", () => {
    expect(validateItem({ item_id: "i", file: "f" })).toBeNull();
    expect(validateItem(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness && pnpm exec vitest run test/run-leaf.test.ts`
Expected: FAIL — `validateItem` not exported / `LeafResult.verdict` not present / envelope type errors.

- [ ] **Step 3: Rewrite `run-leaf.ts`**

Apply these edits to `harness/src/run-leaf.ts`:

**3a.** Replace the top imports (lines 1–2 and the gate imports) — remove all `node:fs`/`node:path` and marker imports, add `validateDecision`:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { k8sSandboxExtension } from "@sh/k8s-sandbox";
import { resolveModelSelection, requireModel, applyModelGateway, type TurnConfig } from "./run-turn.js";
import { BufferedRedisBackend } from "./buffered-redis-backend.js";
import { flushExtension } from "./flush-extension.js";
import { checkpointExtension } from "./checkpoint-extension.js";
import { submitVerdictExtension, VERDICT_ENTRY_TYPE, type VerdictCapture } from "./submit-verdict-tool.js";
import { validateVerdict, type Verdict } from "./verdict.js";
import type { GateCapture } from "./request-approval-tool.js";
import { computeGateState, decideSeed, validateDecision, type Decision, GATE_DECISION_ENTRY_TYPE } from "./gate.js";
import { requestApprovalExtension } from "./request-approval-tool.js";
```

(Removed: `readFileSync, writeFileSync, mkdirSync`, `dirname`, `deriveGateRef, writeGateMarker`, `computeGateState … readDecision` — `readDecision` is dropped; keep `computeGateState, decideSeed, GATE_DECISION_ENTRY_TYPE`.)

**3b.** Replace the `LeafItem` / `LeafEnvelope` / `LeafResult` block (old lines 48–74):

```typescript
export interface LeafItem { item_id: string; file: string; pattern: string; require_approval?: boolean }

export interface LeafEnvelope {
  sessionId: string;
  item: LeafItem;             // inputs inline (was inputsRef)
  decision?: Decision;        // resume/approve only (was decisionRef)
  model?: string;
  provider?: string;
  workspaceRef?: string;      // absolute path INSIDE the sandbox pod (harness never opens it)
  maxTurns?: number;
  async?: boolean;            // when true, the HTTP layer enqueues instead of running inline
  tenant?: string;            // namespaces the session id
}

/** The Pi/Redis session id for a leaf: tenant-prefixed (if any), then sanitized. */
export function leafSessionId(env: { sessionId: string; tenant?: string }): string {
  return toSessionId(env.tenant ? `${env.tenant}/${env.sessionId}` : env.sessionId);
}

export type LeafResult =
  | { status: "done"; verdict: Verdict }
  | { status: "paused"; gateId: number; gate: { summary: string; proposed_action: string } }
  | { status: "aborted" }
  | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error"; message?: string };
```

**3c.** Replace `readItem` (old lines 114–124) with `validateItem`:

```typescript
export function validateItem(o: unknown): LeafItem | null {
  const x = o as Record<string, unknown> | null;
  if (x && typeof x.item_id === "string" && typeof x.file === "string" && typeof x.pattern === "string") {
    return { item_id: x.item_id, file: x.file, pattern: x.pattern, require_approval: x.require_approval === true };
  }
  return null;
}
```

**3d.** Replace the `runLeaf` body (old lines 126–163) — inline inputs, inline verdict/gate, no FS:

```typescript
export async function runLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceVerdict?: ProduceVerdict },
): Promise<LeafResult> {
  const item = validateItem(env.item);
  if (!item) return { status: "failed", reason: "bad_inputs" };

  const capture: LeafCapture = {};
  const produce = deps?.produceVerdict ?? realProduceVerdict;
  try {
    await produce(item, env, config, capture);
  } catch (err) {
    return { status: "failed", reason: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // Gate outcomes take precedence over verdict handling.
  if (capture.aborted) return { status: "aborted" };
  if (capture.gate) {
    return {
      status: "paused",
      gateId: capture.gate.gateId,
      gate: { summary: capture.gate.summary, proposed_action: capture.gate.proposed_action },
    };
  }

  if (!capture.verdict) return { status: "failed", reason: "no_verdict" };
  const v = validateVerdict(capture.verdict);
  if (!v.ok) return { status: "failed", reason: "invalid_verdict", message: v.error };
  return { status: "done", verdict: v.value };
}
```

**3e.** In `realProduceVerdict`, replace the decision read (old line 215) — read the inline decision instead of a file:

```typescript
  const dv = env.decision ? validateDecision(env.decision) : null;
  const decision = dv && dv.ok ? dv.value : null;
  const seed = decideSeed(gateState, decision, buildLeafPrompt(item, env.workspaceRef));
```

(Everything else in `realProduceVerdict` — the session setup, gate seed handling, the `allowVerdict` guard, the extension list — is unchanged in this task. The `k8sSandboxExtension()` call stays as-is; Task 5 changes it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd harness && pnpm exec vitest run test/run-leaf.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run the result-store test (now that `LeafResult` exists in its new shape)**

Run: `cd harness && pnpm exec vitest run test/leaf-result-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add harness/src/run-leaf.ts harness/test/run-leaf.test.ts
git commit -s -m "feat(harness): inline leaf envelope, verdict, and gate (no fs in runLeaf)" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 3: Async worker writes the Redis result record

**Files:**
- Modify: `harness/src/classify-outcome.ts`
- Modify: `harness/src/leaf-job-runner.ts`
- Modify: `packages/knative-server/src/leaf-job.ts`
- Test: `harness/test/classify-outcome.test.ts`, `harness/test/leaf-job-runner.test.ts` (update existing)

**Interfaces:**
- Consumes: `LeafResult`, `LeafEnvelope`, `leafSessionId` from `./run-leaf.js`; `RedisLike`, `LeafResultRecord`, `toResultRecord`, `writeResult`, `RedisResultStore` from `./leaf-result-store.js`; `WorkQueue` from `@sh/work-queue`.
- Produces:
  - `interface Outcome { ack: boolean; retryable: boolean }`
  - `classifyOutcome(result: LeafResult): Outcome`
  - `LeafJobDeps` gains `resultStore: RedisLike; ttlSeconds: number` and drops `writeMarker`.
  - `processOne(deps): Promise<"done"|"failed"|"paused"|"aborted"|"deadletter"|"idle"|"retry">` (unchanged return union).

- [ ] **Step 1: Update the failing tests**

Rewrite `harness/test/classify-outcome.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { classifyOutcome } from "../src/classify-outcome";
import type { LeafResult } from "../src/run-leaf";

describe("classifyOutcome", () => {
  it("acks a done result (non-retryable)", () => {
    expect(classifyOutcome({ status: "done", verdict: { item_id: "i", verdict: "CLEAR", reason: "r" } }))
      .toEqual({ ack: true, retryable: false });
  });
  it("acks a paused result (resume is a fresh invocation)", () => {
    expect(classifyOutcome({ status: "paused", gateId: 1, gate: { summary: "s", proposed_action: "a" } }))
      .toEqual({ ack: true, retryable: false });
  });
  it("acks an aborted result", () => {
    expect(classifyOutcome({ status: "aborted" })).toEqual({ ack: true, retryable: false });
  });
  it("acks a deterministic failure", () => {
    expect(classifyOutcome({ status: "failed", reason: "no_verdict" })).toEqual({ ack: true, retryable: false });
  });
  it("retries a transient error without acking", () => {
    expect(classifyOutcome({ status: "failed", reason: "error" })).toEqual({ ack: false, retryable: true });
  });
});
```

In `harness/test/leaf-job-runner.test.ts`, replace the `writeMarker` capture with an in-memory `resultStore` and assert the record. Representative cases (adapt the existing `deps` builder):

```typescript
import type { RedisLike, LeafResultRecord } from "../src/leaf-result-store";
function fakeStore() {
  const m = new Map<string, string>();
  const store: RedisLike = { async set(k, v) { m.set(k, v); }, async get(k) { return m.get(k) ?? null; } };
  return { store, get: (id: string) => { const r = m.get(`leaf:result:${id}`); return r ? JSON.parse(r) as LeafResultRecord : null; } };
}

it("writes a done record and acks", async () => {
  const { store, get } = fakeStore();
  const queue = /* existing fake queue that claims one entry with envelope {sessionId:'run/i1', item:{...}} */;
  const outcome = await processOne({
    queue, consumerId: "c", resultStore: store, ttlSeconds: 3600,
    runLeaf: async () => ({ status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" } }),
    now: () => "T",
  });
  expect(outcome).toBe("done");
  expect(get("run-i1")).toMatchObject({ status: "done", sessionId: "run/i1" });
});

it("does not write a record and does not ack on transient error (retry)", async () => {
  const { store, get } = fakeStore();
  const queue = /* fake queue, one entry */;
  const outcome = await processOne({
    queue, consumerId: "c", resultStore: store, ttlSeconds: 3600,
    runLeaf: async () => ({ status: "failed", reason: "error" }), now: () => "T",
  });
  expect(outcome).toBe("retry");
  expect(get("run-i1")).toBeNull();
});
```

(Keep the existing dead-letter test but assert a failed **record** via `get(...)` instead of a marker file. The envelope in the fake queue must now use `item` inline and `sessionId: "run/i1"` → `leafSessionId` sanitizes to `run-i1`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd harness && pnpm exec vitest run test/classify-outcome.test.ts test/leaf-job-runner.test.ts`
Expected: FAIL — `Outcome.marker` gone / `resultStore` not in `LeafJobDeps`.

- [ ] **Step 3: Rewrite `classify-outcome.ts`**

```typescript
import type { LeafResult } from "./run-leaf.js";

export interface Outcome {
  ack: boolean;
  retryable: boolean;
}

/**
 * Decide what the leaf-job does with a queue entry given the leaf's terminal result.
 * - done / paused / aborted / deterministic failures → ack (a result record is written by the caller).
 * - "error" (possibly transient) → no ack, retryable (entry stays pending → reclaimed).
 *   (A process crash never returns here → entry stays pending → reclaimed.)
 */
export function classifyOutcome(result: LeafResult): Outcome {
  if (result.status === "failed" && result.reason === "error") {
    return { ack: false, retryable: true };
  }
  return { ack: true, retryable: false };
}
```

- [ ] **Step 4: Rewrite `leaf-job-runner.ts`**

```typescript
// harness/src/leaf-job-runner.ts
import type { WorkQueue } from "@sh/work-queue";
import { classifyOutcome } from "./classify-outcome.js";
import { leafSessionId, type LeafEnvelope, type LeafResult } from "./run-leaf.js";
import { toResultRecord, writeResult, type RedisLike } from "./leaf-result-store.js";

export interface LeafJobDeps {
  queue: WorkQueue;
  runLeaf: (env: LeafEnvelope) => Promise<LeafResult>;
  resultStore: RedisLike;
  ttlSeconds: number;
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
 * Claim and process at most one queue entry.
 * - "idle": nothing to claim.
 * - "deadletter": delivery count exceeded → failed result record + ack, runLeaf not run.
 * - "done"/"failed"/"paused"/"aborted": runLeaf reached this terminal/parked state → write the
 *   result record + ack.
 * - "retry": transient error → NO record, NOT acked (entry stays pending for reclaim).
 */
export async function processOne(
  deps: LeafJobDeps,
): Promise<"done" | "failed" | "paused" | "aborted" | "deadletter" | "idle" | "retry"> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const minIdleMs = deps.minIdleMs ?? 90_000;
  const blockMs = deps.blockMs ?? 5_000;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const now = deps.now ?? (() => new Date().toISOString());
  const setHb = deps.setHeartbeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearHb = deps.clearHeartbeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const claimed = await deps.queue.claim(deps.consumerId, { minIdleMs, blockMs });
  if (!claimed) return "idle";

  const env = claimed.envelope as LeafEnvelope;
  const sid = leafSessionId(env);

  if (claimed.deliveryCount > maxAttempts) {
    await writeResult(deps.resultStore, sid,
      toResultRecord({ status: "failed", reason: "error" }, env.sessionId, now()), deps.ttlSeconds);
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
  if (outcome.retryable) return "retry";

  await writeResult(deps.resultStore, sid, toResultRecord(result, env.sessionId, now()), deps.ttlSeconds);
  if (outcome.ack) {
    await deps.queue.ack(claimed.entryId);
    return result.status;
  }
  return "retry";
}
```

- [ ] **Step 5: Update `leaf-job.ts` entrypoint**

In `packages/knative-server/src/leaf-job.ts`: remove the `done-marker` import; add the result store; write a failed record on dead-letter; pass the store + ttl to `processOne`.

Replace the import (old line 4):

```typescript
import { runLeaf, leafSessionId, type LeafEnvelope } from "@sh/harness/run-leaf";
import { RedisResultStore, toResultRecord, writeResult } from "@sh/harness/leaf-result-store";
```

Add near the constants (after line 10):

```typescript
const RESULT_TTL_SECONDS = parseInt(process.env.LEAF_RESULT_TTL_SECONDS ?? "86400", 10);
```

In `main()`, after `const q = new RedisWorkQueue(...)`, add the store:

```typescript
  const resultStore = new RedisResultStore(process.env.REDIS_URL);
```

Replace the dead-letter marker write (old lines 34–42 body) with:

```typescript
    if (envelope && typeof envelope === "object") {
      const env = envelope as LeafEnvelope;
      try {
        await writeResult(resultStore, leafSessionId(env),
          toResultRecord({ status: "failed", reason: "error" }, env.sessionId, new Date().toISOString()), RESULT_TTL_SECONDS);
      } catch { /* best-effort record write */ }
    } else {
      console.warn(`reaper: entry ${entryId} dead-lettered with unrecoverable envelope`);
    }
```

Replace the `processOne` call args (old lines 59–63):

```typescript
    const outcome = await processOne({
      queue: q,
      runLeaf: (env: LeafEnvelope) => runLeaf(env, buildConfig()),
      resultStore,
      ttlSeconds: RESULT_TTL_SECONDS,
      consumerId,
    });
```

Add `await resultStore.close();` alongside each `await q.close();` on the terminal paths (after the retry `q.close()` and the clean-exit `q.close()`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd harness && pnpm exec vitest run test/classify-outcome.test.ts test/leaf-job-runner.test.ts`
Expected: PASS.
Run: `cd packages/knative-server && pnpm exec tsc --noEmit`
Expected: no errors from `leaf-job.ts`.

- [ ] **Step 7: Commit**

```bash
git add harness/src/classify-outcome.ts harness/src/leaf-job-runner.ts packages/knative-server/src/leaf-job.ts harness/test/classify-outcome.test.ts harness/test/leaf-job-runner.test.ts
git commit -s -m "feat(worker): write leaf verdict/done state to Redis result record" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 4: Sync route + `/runs/status` on Redis

**Files:**
- Modify: `packages/knative-server/src/server.ts`
- Test: `packages/knative-server/test/run-leaf-route.test.ts`, `run-leaf-async-route.test.ts`, `server.test.ts` (update existing)

**Interfaces:**
- Consumes: `runLeaf`, `leafSessionId`, `validateItem`, `type LeafEnvelope`, `type LeafResult` from `@sh/harness/run-leaf`; `RedisResultStore`, `toResultRecord`, `writeResult`, `readResult` from `@sh/harness/leaf-result-store`; `RedisWorkQueue` from `@sh/work-queue`.
- Produces: HTTP behavior only. `isLeafEnvelope(o)` now requires `sessionId` string + `validateItem(o.item)` non-null.

- [ ] **Step 1: Update the failing tests**

In `run-leaf-route.test.ts`, change the envelope shape and the mocked result, and the 400 case:

```typescript
it("400s on a malformed envelope (missing item)", async () => {
  const r = await post("/runs", { sessionId: "s" });
  expect(r.status).toBe(400);
});

it("returns the verdict inline on a valid envelope", async () => {
  runLeaf.mockResolvedValue({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
  const r = await post("/runs", { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
  expect(runLeaf).toHaveBeenCalledOnce();
});
```

Because the server now constructs a real `RedisResultStore`, mock the store module so the route tests stay hermetic (no live redis). At the top of `run-leaf-route.test.ts` and `server.test.ts`:

```typescript
vi.mock("@sh/harness/leaf-result-store", async (orig) => {
  const actual = await orig<typeof import("@sh/harness/leaf-result-store")>();
  const mem = new Map<string, string>();
  class FakeStore { async set(k: string, v: string) { mem.set(k, v); } async get(k: string) { return mem.get(k) ?? null; } async close() {} }
  return { ...actual, RedisResultStore: FakeStore };
});
```

Add a status test in `server.test.ts`:

```typescript
it("GET /runs/status returns queued when no record exists", async () => {
  const r = await (await fetch(`${base}/runs/status?sessionId=run/none`)).json();
  expect(r).toEqual({ status: "queued" });
});
it("GET /runs/status returns the record after a sync run", async () => {
  runLeaf.mockResolvedValue({ status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" } });
  await post("/runs", { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } });
  const r = await (await fetch(`${base}/runs/status?sessionId=run/i1`)).json();
  expect(r).toMatchObject({ status: "done", verdict: { item_id: "i1", verdict: "FLAGGED" } });
});
```

In `run-leaf-async-route.test.ts`, assert the 202 shape is `{ status: "accepted", sessionId }` (drop `resultRef`/`doneMarker`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/knative-server && pnpm exec vitest run`
Expected: FAIL — old envelope/response assertions and status endpoint.

- [ ] **Step 3: Rewrite `server.ts`**

Key edits (replace the corresponding regions):

**3a.** Imports (old lines 1–8):

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { runTurn, type TurnConfig } from "@sh/harness/run-turn";
import { runLeaf, leafSessionId, validateItem, type LeafEnvelope } from "@sh/harness/run-leaf";
import { RedisWorkQueue } from "@sh/work-queue";
import { RedisResultStore, toResultRecord, writeResult, readResult } from "@sh/harness/leaf-result-store";
```

**3b.** Replace `WORK_ROOT` constant (old line 13) with the TTL and drop the path root:

```typescript
const RESULT_TTL_SECONDS = parseInt(process.env.LEAF_RESULT_TTL_SECONDS ?? "86400", 10);
```

**3c.** Replace `isLeafEnvelope` (old lines 72–74):

```typescript
function isLeafEnvelope(o: any): o is LeafEnvelope {
  return o && typeof o.sessionId === "string" && validateItem(o.item) !== null;
}
```

**3d.** Add a lazy result store alongside `getQueue()`:

```typescript
let resultStore: RedisResultStore | undefined;
function getResultStore(): RedisResultStore {
  if (!resultStore) resultStore = new RedisResultStore(process.env.REDIS_URL);
  return resultStore;
}
```

**3e.** Replace `handleEnqueueLeafParsed` (old lines 82–91):

```typescript
async function handleEnqueueLeafParsed(body: any, res: ServerResponse): Promise<void> {
  if (!isLeafEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }
  const q = getQueue();
  await q.ensureGroup();
  await q.enqueue(body);
  res.writeHead(202, JSON_HEADERS).end(JSON.stringify({ status: "accepted", sessionId: body.sessionId }));
}
```

**3f.** Replace `handleRunLeafParsed` (old lines 93–97) — write the record, return inline:

```typescript
async function handleRunLeafParsed(body: any, _raw: string, res: ServerResponse): Promise<void> {
  if (!isLeafEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }
  const result = await runLeaf(body, buildConfig());
  await writeResult(getResultStore(), leafSessionId(body), toResultRecord(result, body.sessionId, new Date().toISOString()), RESULT_TTL_SECONDS);
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
}
```

**3g.** Replace `confineToWorkRoot` + `handleLeafStatus` (old lines 99–132) with a Redis-backed status handler:

```typescript
async function handleLeafStatus(url: URL, res: ServerResponse): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "sessionId_required" })); return; }
  const tenant = url.searchParams.get("tenant") ?? undefined;
  const record = await readResult(getResultStore(), leafSessionId({ sessionId, tenant }));
  if (!record) { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "queued" })); return; }
  if (record.status === "done") { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "done", verdict: record.verdict })); return; }
  if (record.status === "paused") { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "paused", gateId: record.gate?.gateId, gate: record.gate })); return; }
  if (record.status === "failed") { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "failed", reason: record.reason ?? undefined })); return; }
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: record.status }));
}
```

**3h.** Update the status route dispatch (old lines 159–163) to call the now-async handler:

```typescript
  if (req.method === "GET" && (url.startsWith("/runs/status") || url.startsWith("/run-leaf/status"))) {
    if (url.startsWith("/run-leaf/status")) warnDeprecatedRoute("/run-leaf/status");
    handleLeafStatus(new URL(url, "http://localhost"), res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
    return;
  }
```

(The `POST /runs` route dispatch, `/turn`, `/health`, deprecation aliases, and `SIGTERM` handling are unchanged. Remove the now-unused `resolve as resolvePath` import and the `readDoneMarker`/`deriveDoneMarkerPath`/`readGateMarker` imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/knative-server && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knative-server/src/server.ts packages/knative-server/test/run-leaf-route.test.ts packages/knative-server/test/run-leaf-async-route.test.ts packages/knative-server/test/server.test.ts
git commit -s -m "feat(server): inline /runs contract + Redis-backed /runs/status" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 5: Sandbox pod resolution by label selector

**Files:**
- Create: `packages/k8s-sandbox/src/resolve-pod.ts`
- Test: `packages/k8s-sandbox/test/resolve-pod.test.ts`
- Modify: `packages/k8s-sandbox/src/index.ts`, `harness/src/run-leaf.ts`, `harness/src/run-turn.ts`

**Interfaces:**
- Consumes: `resolveConfig`, `type K8sSandboxConfig` from `./config.js`.
- Produces:
  - `buildSelectorArgs(name: string, namespace: string, context?: string): string[]`
  - `buildPodNameArgs(selector: string, namespace: string, context?: string): string[]`
  - `type RunKubectl = (args: string[]) => Promise<string>`
  - `resolveSandboxConfig(env: NodeJS.ProcessEnv, headCwd: string, run?: RunKubectl): Promise<K8sSandboxConfig | null>`

- [ ] **Step 1: Write the failing test**

Create `packages/k8s-sandbox/test/resolve-pod.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSelectorArgs, buildPodNameArgs, resolveSandboxConfig } from "../src/resolve-pod.js";

describe("arg builders", () => {
  it("builds selector args with jsonpath and optional context", () => {
    expect(buildSelectorArgs("sandbox-0", "default")).toEqual(["get", "sandbox", "sandbox-0", "-n", "default", "-o", "jsonpath={.status.selector}"]);
    expect(buildSelectorArgs("s", "ns", "kind-x")).toContain("--context");
  });
  it("builds pod-name args filtered to Running", () => {
    expect(buildPodNameArgs("app=sandbox", "default")).toEqual(["get", "pod", "-n", "default", "-l", "app=sandbox", "--field-selector=status.phase=Running", "-o", "jsonpath={.items[0].metadata.name}"]);
  });
});

describe("resolveSandboxConfig", () => {
  it("short-circuits to KAGENTI_SANDBOX_POD without any kubectl call", async () => {
    let called = false;
    const cfg = await resolveSandboxConfig({ KAGENTI_SANDBOX_POD: "sbx-0" }, "/head", async () => { called = true; return ""; });
    expect(cfg?.pod).toBe("sbx-0");
    expect(called).toBe(false);
  });
  it("returns null when neither POD nor NAME is set", async () => {
    expect(await resolveSandboxConfig({}, "/head", async () => "")).toBeNull();
  });
  it("resolves the pod via selector when NAME is set", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return args[1] === "sandbox" ? "app=sandbox,agents.x-k8s.io/sandbox=s" : "s-abc123"; };
    const cfg = await resolveSandboxConfig({ KAGENTI_SANDBOX_NAME: "s", KAGENTI_SANDBOX_NAMESPACE: "team1" }, "/head", run);
    expect(cfg).toEqual({ pod: "s-abc123", namespace: "team1", context: undefined, podCwd: "/workspace", headCwd: "/head" });
    expect(calls[0]).toContain("sandbox");
    expect(calls[1]).toContain("-l");
  });
  it("throws when the Sandbox has no selector yet", async () => {
    await expect(resolveSandboxConfig({ KAGENTI_SANDBOX_NAME: "s" }, "/head", async () => "")).rejects.toThrow(/selector/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/k8s-sandbox && pnpm exec vitest run test/resolve-pod.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `resolve-pod.ts`**

```typescript
import { spawn } from "node:child_process";
import { resolveConfig, type K8sSandboxConfig } from "./config.js";

/** Pure: kubectl args to read a Sandbox's status.selector (a label-selector string). */
export function buildSelectorArgs(name: string, namespace: string, context?: string): string[] {
  const args = ["get", "sandbox", name, "-n", namespace];
  if (context) args.push("--context", context);
  args.push("-o", "jsonpath={.status.selector}");
  return args;
}

/** Pure: kubectl args to read the first Running pod name matching a label selector. */
export function buildPodNameArgs(selector: string, namespace: string, context?: string): string[] {
  const args = ["get", "pod", "-n", namespace, "-l", selector, "--field-selector=status.phase=Running"];
  if (context) args.push("--context", context);
  args.push("-o", "jsonpath={.items[0].metadata.name}");
  return args;
}

export type RunKubectl = (args: string[]) => Promise<string>;

const defaultRun: RunKubectl = (args) =>
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

/**
 * Resolve sandbox config from env. Precedence:
 *  1. KAGENTI_SANDBOX_POD (explicit pod name) — no kubectl call (fallback / tests).
 *  2. KAGENTI_SANDBOX_NAME — resolve the pod from the Sandbox CR's `.status.selector`.
 *  3. neither — null (extension stays off; local tools stand).
 * Resolution runs once per leaf-session at extension init; a sandbox restart is picked up on the
 * next invocation (design §6.2).
 */
export async function resolveSandboxConfig(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  run: RunKubectl = defaultRun,
): Promise<K8sSandboxConfig | null> {
  const direct = resolveConfig(env, headCwd);
  if (direct) return direct;

  const name = env.KAGENTI_SANDBOX_NAME;
  if (!name) return null;

  const namespace = env.KAGENTI_SANDBOX_NAMESPACE ?? "default";
  const context = env.KAGENTI_SANDBOX_CONTEXT || undefined;

  const selector = (await run(buildSelectorArgs(name, namespace, context))).trim();
  if (!selector) throw new Error(`Sandbox/${name} has no .status.selector yet`);
  const pod = (await run(buildPodNameArgs(selector, namespace, context))).trim();
  if (!pod) throw new Error(`no Running pod for selector '${selector}'`);

  return { pod, namespace, context, podCwd: env.KAGENTI_SANDBOX_CWD ?? "/workspace", headCwd };
}
```

- [ ] **Step 4: Export from `index.ts`**

Add to `packages/k8s-sandbox/src/index.ts`:

```typescript
export { buildSelectorArgs, buildPodNameArgs, resolveSandboxConfig, type RunKubectl } from "./resolve-pod.js";
```

- [ ] **Step 5: Wire into `run-leaf.ts` and `run-turn.ts`**

In `harness/src/run-leaf.ts`, change the import and the extension call. Import:

```typescript
import { k8sSandboxExtension, resolveSandboxConfig } from "@sh/k8s-sandbox";
```

In `realProduceVerdict`, just before building `resourceLoader`, resolve the config:

```typescript
  const sandboxConfig = await resolveSandboxConfig(process.env, cwd);
```

and change the extension entry from `k8sSandboxExtension(),` to:

```typescript
      k8sSandboxExtension({ config: sandboxConfig }),
```

In `harness/src/run-turn.ts`, apply the same two changes: import `resolveSandboxConfig`, resolve `const sandboxConfig = await resolveSandboxConfig(process.env, <the cwd used there>);` before the extension list, and pass `k8sSandboxExtension({ config: sandboxConfig })` at line 151. (Use the same `cwd`/head-dir variable already in scope in `run-turn.ts`.)

- [ ] **Step 6: Run tests + typecheck**

Run: `cd packages/k8s-sandbox && pnpm exec vitest run && pnpm exec tsc --noEmit`
Run: `cd harness && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/k8s-sandbox/src/resolve-pod.ts packages/k8s-sandbox/src/index.ts packages/k8s-sandbox/test/resolve-pod.test.ts harness/src/run-leaf.ts harness/src/run-turn.ts
git commit -s -m "feat(k8s-sandbox): resolve sandbox pod via Sandbox CR status.selector" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 6: Delete the dead filesystem modules

**Files:**
- Delete: `harness/src/done-marker.ts`, `harness/test/done-marker.test.ts`
- Delete: `harness/src/gate-marker.ts`, `harness/test/gate-marker.test.ts`

**Interfaces:** none produced. Verifies nothing references the deleted modules.

- [ ] **Step 1: Verify no references remain**

Run: `cd /path/to/serverless-harness && grep -rn "done-marker\|gate-marker\|writeDoneMarker\|readDoneMarker\|writeGateMarker\|readGateMarker\|deriveDoneMarkerPath\|deriveGateRef" harness packages --include="*.ts" | grep -v "test/done-marker\|test/gate-marker"`
Expected: **no output** (empty). If anything prints, fix that reference first (it belongs to Task 3 or 4).

- [ ] **Step 2: Delete the modules and their tests**

```bash
git rm harness/src/done-marker.ts harness/test/done-marker.test.ts harness/src/gate-marker.ts harness/test/gate-marker.test.ts
```

- [ ] **Step 3: Run the full harness suite + typecheck**

Run: `cd harness && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS / no errors (no import of the removed files).

- [ ] **Step 4: Commit**

```bash
git commit -s -m "chore(harness): remove filesystem done/gate marker modules (superseded by Redis)" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 7: Deploy manifests — remove `/work`, add durable Sandbox CR

**Files:**
- Modify: `deploy/knative/service.yaml`
- Modify: `deploy/knative/leaf-scaledjob.yaml`
- Modify: `deploy/knative/sandbox.yaml`
- Delete: `deploy/knative/leaf-pvc.yaml`
- Modify: the deploy driver that applies manifests + installs cluster deps (see Step 5).

**Interfaces:** cluster resources only. No code.

- [ ] **Step 1: `service.yaml` — drop `/work`, switch to sandbox NAME, add TTL + RBAC**

In `deploy/knative/service.yaml`:
- Remove the `KAGENTI_SANDBOX_POD` env entry; add:
  ```yaml
            - name: KAGENTI_SANDBOX_NAME
              value: "sandbox-0"
            - name: LEAF_RESULT_TTL_SECONDS
              value: "86400"
  ```
- Delete the `work` `volumeMount` (keep the `tmp` mount) and the `work` volume (keep the `tmp` emptyDir). Remove the multi-line `# Shared leaf-session work volume …` comment.
- In the `serverless-harness-sandbox` Role, add a rule so the harness can read the Sandbox CR:
  ```yaml
    - apiGroups: ["agents.x-k8s.io"]
      resources: ["sandboxes"]
      verbs: ["get", "list"]
  ```

- [ ] **Step 2: `leaf-scaledjob.yaml` — drop `/work`, switch env**

In `deploy/knative/leaf-scaledjob.yaml`:
- Replace the `KAGENTI_SANDBOX_POD` env with `KAGENTI_SANDBOX_NAME: "sandbox-0"` and add `LEAF_RESULT_TTL_SECONDS: "86400"`.
- Delete the `work` `volumeMount` (keep `tmp`) and the `work` volume (keep the `tmp` emptyDir).

- [ ] **Step 3: `sandbox.yaml` — convert the bare Pod to a durable `Sandbox` CR**

Replace the entire contents of `deploy/knative/sandbox.yaml`:

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
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
    spec:
      containers:
        - name: sandbox
          image: alpine:3.20
          command: ["/bin/sh", "-c", "apk add --no-cache bash coreutils findutils grep ripgrep && mkdir -p /workspace && exec sleep infinity"]
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
```

- [ ] **Step 4: Delete the shared work PVC**

```bash
git rm deploy/knative/leaf-pvc.yaml
```

- [ ] **Step 5: Install agent-sandbox as a cluster dependency**

Find the deploy driver that applies these manifests (search the smoke/deploy scripts):

Run: `grep -rn "leaf-pvc.yaml\|sandbox.yaml\|kubectl apply -f deploy/knative\|kubectl apply -k" deploy .github 2>/dev/null`

In that driver, **before** applying `sandbox.yaml`, install the agent-sandbox controller + CRDs and stop applying the deleted PVC. Add (using the pinned release manifest — confirm the current URL/tag from the agent-sandbox releases page):

```bash
# agent-sandbox controller + CRDs (kubernetes-sigs/agent-sandbox)
kubectl apply --server-side -f https://github.com/kubernetes-sigs/agent-sandbox/releases/latest/download/install.yaml
kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller-manager --timeout=180s
kubectl wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=120s
```

Remove any line that applies `deploy/knative/leaf-pvc.yaml`. Ensure `sandbox.yaml` is applied after the CRD is Established, and that the driver waits for the sandbox pod to be Running by label (not by the fixed name), e.g.:

```bash
kubectl -n default wait --for=condition=Ready pod -l app=sandbox --timeout=180s
```

- [ ] **Step 6: Render-lint the manifests**

Run: `for f in deploy/knative/service.yaml deploy/knative/leaf-scaledjob.yaml deploy/knative/sandbox.yaml; do kubectl apply --dry-run=client -f "$f" >/dev/null && echo "OK $f" || echo "BAD $f"; done`
Expected: `OK` for service and scaledjob. `sandbox.yaml` may print `BAD` if the CRD is not installed in the current context — that is acceptable at this step; it is validated live in Task 9.

- [ ] **Step 7: Commit**

```bash
git add deploy/knative/service.yaml deploy/knative/leaf-scaledjob.yaml deploy/knative/sandbox.yaml <the deploy driver file>
git commit -s -m "feat(deploy): FS-free harness pods + durable agent-sandbox Sandbox CR" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 8: Callers + smoke drivers (inline contract, red-team grep, durability)

**Files:**
- Modify: `packages/knative-server/src/cron-dispatch.ts` (+ its test if envelope-shaped)
- Modify: `deploy/knative/leaf-smoke.sh`, `deploy/knative/leaf-async-smoke.sh`, `deploy/knative/lib.sh`

**Interfaces:** the smoke drivers must construct the inline `item` envelope and read verdicts from the response / `/runs/status`.

- [ ] **Step 1: `cron-dispatch.ts`**

`dispatchAll`/`applyFire` are envelope-shape-agnostic (they operate on arbitrary string fields), so no code change is required for the mechanics. Update the doc comment near `buildPost`/`loadConfig` to note items now carry an inline `item` object rather than `inputsRef`/`resultRef`. If `cron-dispatch.test.ts` builds envelopes with `inputsRef`/`resultRef`, update those fixtures to the inline shape (`{ sessionId, item: { item_id, file, pattern } }`).

Run: `cd packages/knative-server && pnpm exec vitest run test/cron-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 2: `leaf-smoke.sh` — inline item, verdict from the response**

Rewrite `dispatch_sid`/`dispatch` to send the inline `item` and drop `inputsRef`/`resultRef`. The fixtures (`i1`/`i2`/`i3` → file+pattern) are known to the smoke, so build them inline:

```bash
# dispatch_item <sessionId> <item_id> <file> <pattern> [model] -> echoes terminal JSON from /runs
dispatch_item() {
  local sid="$1" id="$2" file="$3" pat="$4" model="${5:-$MODEL}"
  local body
  body=$(jq -nc --arg s "$sid" --arg m "$model" --arg id "$id" --arg f "$file" --arg p "$pat" --arg ws "$SBOX_REPO" \
    '{sessionId:$s, model:$m, workspaceRef:$ws, item:{item_id:$id, file:$f, pattern:$p}}')
  curl -s --max-time 240 -H "$HOST_HEADER" -H "Content-Type: application/json" -d "$body" "$BASE/runs"
}
```

Update the verdict check to read the inline response `.verdict.verdict` instead of exec-ing into the PVC to read a result file. For each item, compare `$(echo "$resp" | jq -r '.verdict.verdict')` against `${EXPECT[$id]}`. Remove all `oexec … $RES/$id.json` reads and any `seed_work_dirs`/`INPUTS`/`RES` PVC plumbing. Keep seeding the **repo into the sandbox** (`SBOX_REPO`, via `sexec`) — Claim 0 still requires the repo to exist only in the sandbox.

- [ ] **Step 3: `leaf-async-smoke.sh` — poll `/runs/status?sessionId`**

Replace the done-marker/result-file polling with status polling:

```bash
# poll_status <sessionId> -> echoes final status JSON (done|failed|aborted) or times out
poll_status() {
  local sid="$1" i=0 resp status
  while [ "$i" -lt 60 ]; do
    resp=$(curl -s -H "$HOST_HEADER" "$BASE/runs/status?sessionId=$(jq -rn --arg s "$sid" '$s|@uri')")
    status=$(echo "$resp" | jq -r '.status')
    case "$status" in done|failed|aborted) echo "$resp"; return 0;; esac
    i=$((i+1)); sleep 2
  done
  echo "$resp"; return 1
}
```

Send the async envelope with the inline `item` + `async:true`, then `poll_status "$sid"` and assert `.verdict.verdict`. Remove all `$RES/$id.json.status` and `$RES/$id.json` reads.

- [ ] **Step 4: `lib.sh` — drop `seed_work_dirs`**

Remove the `seed_work_dirs` helper (no `/work` dirs to seed). Leave the `/turn` helper (line ~56) unchanged. If other smoke scripts call `seed_work_dirs`, remove those calls.

- [ ] **Step 5: Add the red-team grep to the smoke (acceptance gate)**

Add near the top of `leaf-smoke.sh` (after `claim` is defined) a static assertion that the harness path is FS-free:

```bash
claim 0 "harness is FS-free (no /work mount, no fs writes in the envelope path)"
if grep -rqE 'mountPath:\s*/work|claimName:\s*leaf-work' deploy/knative/service.yaml deploy/knative/leaf-scaledjob.yaml; then
  echo "FAIL: a /work mount remains in the harness/worker manifests"; exit 1
fi
if grep -rqE 'writeFileSync|readFileSync|mkdirSync' harness/src/run-leaf.ts harness/src/leaf-job-runner.ts; then
  echo "FAIL: filesystem I/O remains in the leaf envelope path"; exit 1
fi
echo "PASS: no /work mount, no fs I/O in the envelope path"
```

- [ ] **Step 6: Commit**

```bash
git add packages/knative-server/src/cron-dispatch.ts deploy/knative/leaf-smoke.sh deploy/knative/leaf-async-smoke.sh deploy/knative/lib.sh
git commit -s -m "test(smoke): inline-item envelope, verdict from response/Redis, FS-free red-team grep" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Task 9: Live Kind verification (acceptance)

**Files:** none (runs the smoke on a real Kind cluster).

**Interfaces:** validates the four acceptance criteria from spec §10 end-to-end, including the real `.status.selector` shape.

- [ ] **Step 1: Deploy to Kind**

Build/push the image and apply manifests via the deploy driver (the same one edited in Task 7). Follow the repo's existing Kind deploy path (see the driver / `deploy/knative/README` if present). Confirm the controller and sandbox are up:

```bash
kubectl wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=120s
kubectl -n default get sandbox sandbox-0 -o jsonpath='{.status.selector}'; echo
kubectl -n default wait --for=condition=Ready pod -l app=sandbox --timeout=180s
```

Expected: `.status.selector` prints a non-empty **string** label selector. If it prints a JSON object instead (`{"matchLabels":…}`), adjust `buildSelectorArgs`/`resolveSandboxConfig` in Task 5 to render `-l key=value` pairs from `matchLabels`, then re-run Task 5's tests and redeploy.

- [ ] **Step 2: Run the sync smoke (Claims 0–N)**

Run the sync smoke and capture output to a log (context budget):

```bash
LOG_DIR=/tmp/sh/p1; mkdir -p $LOG_DIR
bash deploy/knative/leaf-smoke.sh > $LOG_DIR/leaf-smoke.log 2>&1; echo "EXIT:$?"
```

Expected: `EXIT:0`. Verify the red-team claim and the i1/i2/i3 verdicts passed (grep the log for `PASS`/`FAIL`).

- [ ] **Step 3: Run the async smoke**

```bash
bash deploy/knative/leaf-async-smoke.sh > $LOG_DIR/leaf-async-smoke.log 2>&1; echo "EXIT:$?"
```

Expected: `EXIT:0`; verdicts retrieved via `/runs/status?sessionId`.

- [ ] **Step 4: Durability check (sandbox PVC survives a pod restart)**

```bash
POD=$(kubectl -n default get pod -l app=sandbox -o jsonpath='{.items[0].metadata.name}')
kubectl -n default exec "$POD" -- sh -c 'echo durable-$$ > /workspace/durable-marker.txt; cat /workspace/durable-marker.txt'
kubectl -n default delete pod "$POD"
kubectl -n default wait --for=condition=Ready pod -l app=sandbox --timeout=180s
NEWPOD=$(kubectl -n default get pod -l app=sandbox -o jsonpath='{.items[0].metadata.name}')
kubectl -n default exec "$NEWPOD" -- cat /workspace/durable-marker.txt
```

Expected: the marker file survives on the recreated pod (proves `volumeClaimTemplates` durability).

- [ ] **Step 5: Confirm the harness pods mount nothing writable**

```bash
kubectl -n default get pods -o json | jq -r '.items[] | select(.metadata.labels["serving.knative.dev/service"]=="serverless-harness" or (.metadata.name|test("leaf-worker"))) | .spec.volumes[].name' | sort -u
```

Expected: only `tmp` (emptyDir) — no `work` / `leaf-work`.

- [ ] **Step 6: Final full-suite run + commit any fixups**

Run: `pnpm -r test`
Expected: all packages green.

If Step 1 forced a `buildSelectorArgs` adjustment, commit it:

```bash
git add packages/k8s-sandbox/src/resolve-pod.ts packages/k8s-sandbox/test/resolve-pod.test.ts
git commit -s -m "fix(k8s-sandbox): render matchLabels selector for the deployed Sandbox CRD" -m "Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>"
```

---

## Self-Review (completed during authoring)

**Spec coverage** — every spec section maps to a task: §3.1 inline request → T2/T4; §3.2 inline sync verdict → T2/T4; §3.3 async 202 → T4; §3.4 `/runs/status?sessionId[&tenant]` → T4; §4 Redis result store + TTL → T1 (module), T3/T4 (writers); §5 gate off FS (marker→Redis, decision→inline) → T2 (inline decision + inline gate result), T3/T4 (paused record); §6 Sandbox CR + selector exec → T5, T7; §6.3 carried scope (single Sandbox; controller as dep) → T7; §7 deploy edits → T7; §8 callers → T8; §9 testing (unit, red-team grep, durability, gate) → T1–T5 units, T8 grep, T9 durability; §10 acceptance → T9.

**Placeholder scan** — no TBD/TODO; every code step shows complete code. The one deliberately open item (whether `.status.selector` serializes as a string vs `LabelSelector` object) is handled with an explicit live-verification branch in T9 Step 1, per spec §6.2.

**Type consistency** — `LeafResult` (T2) is consumed by `toResultRecord`/`classifyOutcome` (T1/T3) with matching variants (`done.verdict`, `paused.gateId`+`paused.gate`, `failed.reason`); `leafSessionId` reused by T3/T4 for the Redis key; `RedisLike` (T1) is the injected type in T3/T4 and implemented by `RedisResultStore` (T1); `resolveSandboxConfig` (T5) returns the existing `K8sSandboxConfig` consumed unchanged by the exec transports.
