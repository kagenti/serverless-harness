# Human-Gate (Gate-While-Idle, Archetype B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a human-in-the-loop gate so a single leaf session can pause mid-pipeline awaiting an external human decision, park in durable state (pod → zero), and resume with the decision injected — preserving context across one or more gates before a verdict.

**Architecture:** Additive on top of the leaf-session contract + gate-7 resume + the async queue/KEDA substrate. An agent calls a `request_approval` tool (ends the turn well-formed, records a durable `gate-request` entry, parks). `runLeaf` writes an `awaiting_approval` gate marker; the session sits in Redis. An external approver writes a `decisionRef` file (echoing `gateId`) and re-invokes the same `sessionId`; `runLeaf` resumes, records a durable `gate-decision` entry, re-seeds a continuation prompt (approve/reject) or returns `aborted`, and runs to a verdict. All pure gate logic lives in `gate.ts` (fully unit-tested); `runLeaf` wiring is exercised by the live smoke. Every existing path is untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 20, vitest, pnpm workspaces (`@sh/*`), Pi coding agent (`@earendil-works/pi-coding-agent`), Redis Streams, Knative + KEDA on Kind.

## Global Constraints

- **Spec:** `docs/specs/2026-06-28-human-gate-design.md` — every task implements part of it.
- **No change to any existing path:** sync `POST /run-leaf`, async enqueue, cron-dispatch, `leaf-queue`, the KEDA `ScaledJob`, `submit_verdict`, the leaf-job runner loop, and the heartbeat/dead-letter machinery stay behavior-identical. A leaf that never calls `request_approval` behaves exactly as today.
- **Decisions (spec §1 B1–B5):** agent-declared gate, external decision authority + re-invocation (B1); continuation-prompt resume, no tool-result injection (B2); `decisionRef` file transport + re-invoke-by-`sessionId` trigger (B3); no harness-side timeout — park indefinitely (B4); actions `approve`/`reject`/`abort` (B5).
- **`gateId`** is a per-session monotonic integer = count of prior `gate-request` entries (0, 1, 2, …). A decision applies only when `decision.gateId` matches the pending gate's `gateId`.
- **Two marker kinds:** the **gate marker** (`awaiting_approval`, non-terminal) is written by **`runLeaf`** to `gateRef` (default `<resultRef>.gate`). The **terminal** marker (`done`/`failed`/`aborted`) is written by the queue runner (async) or conveyed by the HTTP response (sync), at `<resultRef>.status`. They are distinct files.
- **Auto-approve mode is NOT built** (shaped-for only).
- **TDD:** write the failing test first; pure logic in `gate.ts` is unit-tested; `realProduceVerdict` wiring is verified by the live smoke (consistent with the existing code, which carries the same note).
- **DCO:** every commit uses `git commit -s`. Conventional prefixes (`feat:`, `test:`, `docs:`). Attribution only where needed: `Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>`.
- **Branch:** `feat/human-gate` (already created; spec already committed there).
- **Run unit tests from the repo root:** `pnpm --filter @sh/harness test` (harness) / `pnpm --filter @sh/knative-server test` (server). Single file: `pnpm --filter @sh/harness exec vitest run test/<file>`.

---

## File Structure

**Create:**
- `harness/src/gate.ts` — all pure gate logic: types, `validateDecision`, `readDecision`, entry-type constants + predicates/extractors, `computeGateState`, `continuationPrompt`, `decideSeed`.
- `harness/src/request-approval-tool.ts` — `requestApprovalExtension` + `GateCapture` + `GateSink`.
- `harness/src/gate-marker.ts` — `GateMarker` type, `deriveGateRef`, `writeGateMarker`, `readGateMarker`.
- `harness/test/gate.test.ts`, `harness/test/request-approval-tool.test.ts`, `harness/test/gate-marker.test.ts`.
- `deploy/knative/leaf-gate-smoke.sh` — gated live gate.

**Modify:**
- `harness/src/run-leaf.ts` — `LeafEnvelope` (+`gateRef`/`decisionRef`), `LeafResult` (+`paused`/`aborted`), `LeafItem` (+`require_approval`), `buildLeafPrompt` (gate instruction), `LeafCapture`, `runLeaf` outer (capture → gate marker / paused / aborted), `realProduceVerdict` (gate front-end wiring).
- `harness/src/classify-outcome.ts` — `Outcome.marker` status union +`aborted`; `paused`/`aborted` branches.
- `harness/src/done-marker.ts` — `DoneMarker.status` +`aborted`.
- `packages/knative-server/src/server.ts` — status endpoint reports `awaiting_approval` from the gate marker.
- `harness/test/run-leaf.test.ts`, `harness/test/classify-outcome.test.ts`, `packages/knative-server/test/run-leaf-async-route.test.ts` — extend.

---

## Task 1: Gate types, decision validation, and entry helpers (`gate.ts` part 1)

**Files:**
- Create: `harness/src/gate.ts`
- Test: `harness/test/gate.test.ts`

**Interfaces:**
- Produces: `GateAction = "approve"|"reject"|"abort"`; `interface GateRequest { gateId: number; summary: string; proposed_action: string }`; `interface Decision { gateId: number; action: GateAction; feedback?: string }`; `interface GateDecision { gateId: number; action: GateAction; feedback?: string }`; `GATE_REQUEST_ENTRY_TYPE = "gate-request"`; `GATE_DECISION_ENTRY_TYPE = "gate-decision"`; `validateDecision(obj: unknown): { ok: true; value: Decision } | { ok: false; error: string }`; `readDecision(decisionRef: string): Decision | null`; `isGateRequestEntry(entry: unknown): boolean`; `isGateDecisionEntry(entry: unknown): boolean`; `gateRequestFromEntry(entry: unknown): GateRequest | null`; `gateDecisionFromEntry(entry: unknown): GateDecision | null`.

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/gate.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateDecision, readDecision,
  isGateRequestEntry, isGateDecisionEntry, gateRequestFromEntry, gateDecisionFromEntry,
  GATE_REQUEST_ENTRY_TYPE, GATE_DECISION_ENTRY_TYPE,
} from "../src/gate";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("validateDecision", () => {
  it("accepts approve/reject/abort with a numeric gateId", () => {
    expect(validateDecision({ gateId: 0, action: "approve" })).toEqual({
      ok: true, value: { gateId: 0, action: "approve", feedback: undefined },
    });
    expect(validateDecision({ gateId: 2, action: "reject", feedback: "do X" })).toEqual({
      ok: true, value: { gateId: 2, action: "reject", feedback: "do X" },
    });
    expect(validateDecision({ gateId: 1, action: "abort" }).ok).toBe(true);
  });
  it("rejects a bad action, missing gateId, or non-object", () => {
    expect(validateDecision({ gateId: 0, action: "maybe" }).ok).toBe(false);
    expect(validateDecision({ action: "approve" }).ok).toBe(false);
    expect(validateDecision(null).ok).toBe(false);
  });
});

describe("readDecision", () => {
  it("reads and validates a decision file; null on missing/garbled/invalid", () => {
    const p = join(dir, "d.json");
    writeFileSync(p, JSON.stringify({ gateId: 0, action: "approve" }));
    expect(readDecision(p)).toEqual({ gateId: 0, action: "approve", feedback: undefined });
    expect(readDecision(join(dir, "nope.json"))).toBeNull();
    writeFileSync(p, "{not json");
    expect(readDecision(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ gateId: 0, action: "nope" }));
    expect(readDecision(p)).toBeNull();
  });
});

describe("entry helpers", () => {
  const req = { type: "custom", customType: GATE_REQUEST_ENTRY_TYPE, data: { gateId: 0, summary: "s", proposed_action: "a" } };
  const dec = { type: "custom", customType: GATE_DECISION_ENTRY_TYPE, data: { gateId: 0, action: "approve" } };
  it("recognizes and extracts gate-request entries", () => {
    expect(isGateRequestEntry(req)).toBe(true);
    expect(isGateRequestEntry(dec)).toBe(false);
    expect(gateRequestFromEntry(req)).toEqual({ gateId: 0, summary: "s", proposed_action: "a" });
    expect(gateRequestFromEntry(dec)).toBeNull();
  });
  it("recognizes and extracts gate-decision entries", () => {
    expect(isGateDecisionEntry(dec)).toBe(true);
    expect(gateDecisionFromEntry(dec)).toEqual({ gateId: 0, action: "approve", feedback: undefined });
    expect(gateDecisionFromEntry(req)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/harness exec vitest run test/gate.test.ts`
Expected: FAIL — `Cannot find module '../src/gate'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// harness/src/gate.ts
import { readFileSync } from "node:fs";

export type GateAction = "approve" | "reject" | "abort";

export interface GateRequest {
  gateId: number;
  summary: string;
  proposed_action: string;
}

export interface Decision {
  gateId: number;
  action: GateAction;
  feedback?: string;
}

/** Same shape as Decision; persisted as a durable custom entry to mark a gate consumed. */
export type GateDecision = Decision;

export const GATE_REQUEST_ENTRY_TYPE = "gate-request";
export const GATE_DECISION_ENTRY_TYPE = "gate-decision";

export function validateDecision(
  obj: unknown,
): { ok: true; value: Decision } | { ok: false; error: string } {
  if (typeof obj !== "object" || obj === null) return { ok: false, error: "decision must be an object" };
  const o = obj as Record<string, unknown>;
  if (typeof o.gateId !== "number" || !Number.isInteger(o.gateId) || o.gateId < 0) {
    return { ok: false, error: "gateId must be a non-negative integer" };
  }
  if (o.action !== "approve" && o.action !== "reject" && o.action !== "abort") {
    return { ok: false, error: 'action must be "approve", "reject", or "abort"' };
  }
  if (o.feedback !== undefined && typeof o.feedback !== "string") {
    return { ok: false, error: "feedback must be a string when present" };
  }
  return { ok: true, value: { gateId: o.gateId, action: o.action, feedback: o.feedback as string | undefined } };
}

/** Read + validate the orchestrator-written decision file. Null on missing/garbled/invalid. */
export function readDecision(decisionRef: string): Decision | null {
  try {
    const r = validateDecision(JSON.parse(readFileSync(decisionRef, "utf8")));
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

type CustomEntry = { type?: string; customType?: string; data?: unknown };

export function isGateRequestEntry(entry: unknown): boolean {
  const e = entry as CustomEntry | null;
  return !!e && e.type === "custom" && e.customType === GATE_REQUEST_ENTRY_TYPE;
}

export function isGateDecisionEntry(entry: unknown): boolean {
  const e = entry as CustomEntry | null;
  return !!e && e.type === "custom" && e.customType === GATE_DECISION_ENTRY_TYPE;
}

export function gateRequestFromEntry(entry: unknown): GateRequest | null {
  if (!isGateRequestEntry(entry)) return null;
  const d = (entry as CustomEntry).data as Record<string, unknown> | undefined;
  if (!d || typeof d.gateId !== "number" || typeof d.summary !== "string" || typeof d.proposed_action !== "string") {
    return null;
  }
  return { gateId: d.gateId, summary: d.summary, proposed_action: d.proposed_action };
}

export function gateDecisionFromEntry(entry: unknown): GateDecision | null {
  if (!isGateDecisionEntry(entry)) return null;
  const r = validateDecision((entry as CustomEntry).data);
  return r.ok ? r.value : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sh/harness exec vitest run test/gate.test.ts`
Expected: PASS (3 describes).

- [ ] **Step 5: Commit**

```bash
git add harness/src/gate.ts harness/test/gate.test.ts
git commit -s -m "feat(gate): Add gate types, decision validation, and entry helpers"
```

---

## Task 2: Gate-state computation + continuation prompt (`gate.ts` part 2)

**Files:**
- Modify: `harness/src/gate.ts`
- Test: `harness/test/gate.test.ts` (extend)

**Interfaces:**
- Consumes: `GateRequest`, `GateDecision`, the entry helpers (Task 1).
- Produces: `interface GateState { gateRequests: GateRequest[]; gateDecisions: GateDecision[]; pendingGate: GateRequest | null; lastDecision: GateDecision | null; nextGateId: number }`; `computeGateState(entries: unknown[]): GateState`; `continuationPrompt(action: "approve" | "reject", feedback?: string): string`.

- [ ] **Step 1: Write the failing test** (append to `harness/test/gate.test.ts`)

```typescript
import { computeGateState, continuationPrompt } from "../src/gate";

function reqEntry(gateId: number) {
  return { type: "custom", customType: "gate-request", data: { gateId, summary: `s${gateId}`, proposed_action: `a${gateId}` } };
}
function decEntry(gateId: number, action = "approve", feedback?: string) {
  return { type: "custom", customType: "gate-decision", data: { gateId, action, feedback } };
}

describe("computeGateState", () => {
  it("no gates → no pending, nextGateId 0", () => {
    const s = computeGateState([{ type: "user" }]);
    expect(s.pendingGate).toBeNull();
    expect(s.lastDecision).toBeNull();
    expect(s.nextGateId).toBe(0);
  });
  it("one undecided request → it is pending, nextGateId 1", () => {
    const s = computeGateState([reqEntry(0)]);
    expect(s.pendingGate).toEqual({ gateId: 0, summary: "s0", proposed_action: "a0" });
    expect(s.nextGateId).toBe(1);
  });
  it("decided request → no pending, lastDecision set", () => {
    const s = computeGateState([reqEntry(0), decEntry(0, "approve")]);
    expect(s.pendingGate).toBeNull();
    expect(s.lastDecision).toEqual({ gateId: 0, action: "approve", feedback: undefined });
  });
  it("second request after a decided first → second is pending, nextGateId 2", () => {
    const s = computeGateState([reqEntry(0), decEntry(0), reqEntry(1)]);
    expect(s.pendingGate?.gateId).toBe(1);
    expect(s.nextGateId).toBe(2);
  });
});

describe("continuationPrompt", () => {
  it("approve mentions APPROVED and submit_verdict", () => {
    const p = continuationPrompt("approve", "looks good");
    expect(p).toContain("APPROVED");
    expect(p).toContain("looks good");
    expect(p).toContain("submit_verdict");
  });
  it("reject mentions REJECTED and revise", () => {
    const p = continuationPrompt("reject", "fix the query");
    expect(p).toContain("REJECTED");
    expect(p).toContain("fix the query");
    expect(p.toLowerCase()).toContain("revise");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/harness exec vitest run test/gate.test.ts`
Expected: FAIL — `computeGateState`/`continuationPrompt` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `harness/src/gate.ts`)

```typescript
export interface GateState {
  gateRequests: GateRequest[];
  gateDecisions: GateDecision[];
  pendingGate: GateRequest | null;
  lastDecision: GateDecision | null;
  nextGateId: number;
}

/** Derive gate state from the durable session entries (the .entry payloads from store.read). */
export function computeGateState(entries: unknown[]): GateState {
  const gateRequests = entries.map(gateRequestFromEntry).filter((r): r is GateRequest => r !== null);
  const gateDecisions = entries.map(gateDecisionFromEntry).filter((d): d is GateDecision => d !== null);
  const decidedIds = new Set(gateDecisions.map((d) => d.gateId));
  // At most one gate is unanswered at a time (gates are sequential); pick the latest undecided.
  let pendingGate: GateRequest | null = null;
  for (const r of gateRequests) {
    if (!decidedIds.has(r.gateId)) pendingGate = r;
  }
  const lastDecision = gateDecisions.length ? gateDecisions[gateDecisions.length - 1] : null;
  return { gateRequests, gateDecisions, pendingGate, lastDecision, nextGateId: gateRequests.length };
}

export function continuationPrompt(action: "approve" | "reject", feedback?: string): string {
  if (action === "approve") {
    return [
      `Human decision: APPROVED.${feedback ? ` ${feedback}` : ""}`,
      `Proceed with the proposed action. When finished, call submit_verdict exactly once, then stop.`,
    ].join("\n");
  }
  return [
    `Human decision: REJECTED. ${feedback ?? "No feedback provided."}`,
    `Revise accordingly. You may call request_approval again when ready, or call submit_verdict when done.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sh/harness exec vitest run test/gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/src/gate.ts harness/test/gate.test.ts
git commit -s -m "feat(gate): Add gate-state computation and continuation prompt"
```

---

## Task 3: The seed/decision state machine (`decideSeed`)

**Files:**
- Modify: `harness/src/gate.ts`
- Test: `harness/test/gate.test.ts` (extend)

**Interfaces:**
- Consumes: `GateState`, `Decision`, `GateDecision`, `continuationPrompt` (Tasks 1–2).
- Produces: `type SeedDecision = { kind: "paused"; gate: GateRequest } | { kind: "abort"; record: GateDecision | null } | { kind: "seed"; prompt: string; record: GateDecision | null }`; `decideSeed(state: GateState, decision: Decision | null, freshPrompt: string): SeedDecision`.

- [ ] **Step 1: Write the failing test** (append to `harness/test/gate.test.ts`)

```typescript
import { decideSeed } from "../src/gate";

const FRESH = "FRESH_PROMPT";
function state(entries: unknown[]) { return computeGateState(entries); }

describe("decideSeed", () => {
  it("fresh (no gates) → seed the fresh prompt, no record", () => {
    expect(decideSeed(state([]), null, FRESH)).toEqual({ kind: "seed", prompt: FRESH, record: null });
  });
  it("pending gate + matching approve → seed continuation + record decision", () => {
    const r = decideSeed(state([reqEntry(0)]), { gateId: 0, action: "approve" }, FRESH);
    expect(r.kind).toBe("seed");
    if (r.kind === "seed") {
      expect(r.prompt).toContain("APPROVED");
      expect(r.record).toEqual({ gateId: 0, action: "approve", feedback: undefined });
    }
  });
  it("pending gate + matching reject → seed continuation with feedback", () => {
    const r = decideSeed(state([reqEntry(0)]), { gateId: 0, action: "reject", feedback: "redo" }, FRESH);
    expect(r.kind).toBe("seed");
    if (r.kind === "seed") expect(r.prompt).toContain("redo");
  });
  it("pending gate + matching abort → abort + record", () => {
    expect(decideSeed(state([reqEntry(0)]), { gateId: 0, action: "abort" }, FRESH)).toEqual({
      kind: "abort", record: { gateId: 0, action: "abort", feedback: undefined },
    });
  });
  it("pending gate + no decision → paused", () => {
    expect(decideSeed(state([reqEntry(0)]), null, FRESH)).toEqual({
      kind: "paused", gate: { gateId: 0, summary: "s0", proposed_action: "a0" },
    });
  });
  it("pending gate + gateId mismatch → paused (stale decision ignored)", () => {
    expect(decideSeed(state([reqEntry(1)]), { gateId: 0, action: "approve" }, FRESH).kind).toBe("paused");
  });
  it("already-decided this gate (double resume) → seed continuation, record null (no re-record)", () => {
    // The decision entry for gate 0 already exists, so the gate is no longer pending.
    const r = decideSeed(state([reqEntry(0), decEntry(0, "approve")]), { gateId: 0, action: "approve" }, FRESH);
    expect(r.kind).toBe("seed");
    if (r.kind === "seed") { expect(r.prompt).toContain("APPROVED"); expect(r.record).toBeNull(); }
  });
  it("already-aborted session (no pending, last decision abort) → terminal abort, record null", () => {
    expect(decideSeed(state([reqEntry(0), decEntry(0, "abort")]), null, FRESH)).toEqual({
      kind: "abort", record: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/harness exec vitest run test/gate.test.ts`
Expected: FAIL — `decideSeed` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `harness/src/gate.ts`)

```typescript
export type SeedDecision =
  | { kind: "paused"; gate: GateRequest }
  | { kind: "abort"; record: GateDecision | null }
  | { kind: "seed"; prompt: string; record: GateDecision | null };

/**
 * Decide what a runLeaf invocation should do, given the durable gate state, the (optional) decision
 * read from decisionRef, and the fresh job-mode prompt. Pure: the caller performs the side effects
 * (append `record`, run `session.prompt(prompt)`, set capture flags). See spec §3.
 */
export function decideSeed(state: GateState, decision: Decision | null, freshPrompt: string): SeedDecision {
  const { pendingGate, lastDecision, gateDecisions } = state;
  const decidedIds = new Set(gateDecisions.map((d) => d.gateId));

  if (pendingGate) {
    if (decision && decision.gateId === pendingGate.gateId) {
      const record: GateDecision | null = decidedIds.has(pendingGate.gateId)
        ? null
        : { gateId: decision.gateId, action: decision.action, feedback: decision.feedback };
      if (decision.action === "abort") return { kind: "abort", record };
      return { kind: "seed", prompt: continuationPrompt(decision.action, decision.feedback), record };
    }
    return { kind: "paused", gate: pendingGate };
  }

  // No pending gate. A prior abort is terminal; otherwise re-derive the last continuation, else fresh.
  if (lastDecision?.action === "abort") return { kind: "abort", record: null };
  const prompt = lastDecision ? continuationPrompt(lastDecision.action, lastDecision.feedback) : freshPrompt;
  return { kind: "seed", prompt, record: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sh/harness exec vitest run test/gate.test.ts`
Expected: PASS (all gate describes).

- [ ] **Step 5: Commit**

```bash
git add harness/src/gate.ts harness/test/gate.test.ts
git commit -s -m "feat(gate): Add decideSeed state machine (pause/abort/seed + idempotency)"
```

---

## Task 4: `request_approval` tool extension

**Files:**
- Create: `harness/src/request-approval-tool.ts`
- Test: `harness/test/request-approval-tool.test.ts`

**Interfaces:**
- Consumes: `GateRequest`, `GATE_REQUEST_ENTRY_TYPE` (Task 1).
- Produces: `interface GateCapture { gate?: GateRequest; aborted?: boolean }`; `interface GateSink { appendCustomEntry(customType: string, data?: unknown): string }`; `requestApprovalExtension(capture: GateCapture, sink: GateSink | undefined, nextGateId: number): ExtensionFactory`.

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/request-approval-tool.test.ts
import { describe, it, expect } from "vitest";
import { requestApprovalExtension, type GateCapture } from "../src/request-approval-tool";

function fakePi() {
  const tools: any[] = [];
  return { api: { registerTool: (t: any) => tools.push(t), on: () => {} } as any, tools };
}

describe("requestApprovalExtension", () => {
  it("registers a request_approval tool", () => {
    const { api, tools } = fakePi();
    requestApprovalExtension({}, undefined, 0)(api);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("request_approval");
  });

  it("captures the gate (with nextGateId) and appends a durable gate-request entry", async () => {
    const capture: GateCapture = {};
    const appended: Array<{ t: string; d: unknown }> = [];
    const sink = { appendCustomEntry: (t: string, d?: unknown) => { appended.push({ t, d }); return "id"; } };
    const { api, tools } = fakePi();
    requestApprovalExtension(capture, sink, 3)(api);
    const res = await tools[0].execute("call-1", { summary: "did X", proposed_action: "do Y" }, undefined, undefined, {} as any);
    expect(capture.gate).toEqual({ gateId: 3, summary: "did X", proposed_action: "do Y" });
    expect(appended).toEqual([{ t: "gate-request", d: { gateId: 3, summary: "did X", proposed_action: "do Y" } }]);
    expect(res.isError).toBeFalsy();
  });

  it("rejects empty summary/proposed_action and does not capture or append", async () => {
    const capture: GateCapture = {};
    const appended: unknown[] = [];
    const sink = { appendCustomEntry: (t: string, d?: unknown) => { appended.push({ t, d }); return "id"; } };
    const { api, tools } = fakePi();
    requestApprovalExtension(capture, sink, 0)(api);
    const res = await tools[0].execute("c", { summary: "", proposed_action: "y" }, undefined, undefined, {} as any);
    expect(capture.gate).toBeUndefined();
    expect(appended).toHaveLength(0);
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/harness exec vitest run test/request-approval-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// harness/src/request-approval-tool.ts
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { GATE_REQUEST_ENTRY_TYPE, type GateRequest } from "./gate.js";

export interface GateCapture {
  gate?: GateRequest;
  aborted?: boolean;
}

/** Minimal slice of SessionManager the tool needs to persist the gate request durably. */
export interface GateSink {
  appendCustomEntry(customType: string, data?: unknown): string;
}

const params = {
  type: "object",
  properties: {
    summary: { type: "string", description: "A short summary of what you have done / decided so far (the human reads this)" },
    proposed_action: { type: "string", description: "The action you propose to take next, pending sign-off" },
  },
  required: ["summary", "proposed_action"],
};

/**
 * Registers the `request_approval` tool. On a valid call it (1) captures the gate in-memory with the
 * caller-supplied `nextGateId` and (2) — when a `sink` is provided — appends a durable `gate-request`
 * custom entry, so a resumed session can detect the pending gate. The tool returns a benign result so
 * the assistant turn ends well-formed (no dangling tool call); runLeaf parks at the loop boundary.
 */
export function requestApprovalExtension(
  capture: GateCapture,
  sink: GateSink | undefined,
  nextGateId: number,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "request_approval",
      label: "Request approval",
      description:
        "Request human approval before proceeding. Provide a summary of what you've done and the " +
        "action you propose. Call this at most once, then stop; the session pauses and resumes with " +
        "the human's decision.",
      parameters: params,
      async execute(_id, args) {
        const summary = (args as { summary?: unknown })?.summary;
        const proposed_action = (args as { proposed_action?: unknown })?.proposed_action;
        if (typeof summary !== "string" || summary.length === 0 ||
            typeof proposed_action !== "string" || proposed_action.length === 0) {
          return { isError: true, content: [{ type: "text", text: "Invalid request_approval: summary and proposed_action must be non-empty strings" }] };
        }
        const gate: GateRequest = { gateId: nextGateId, summary, proposed_action };
        capture.gate = gate;
        sink?.appendCustomEntry(GATE_REQUEST_ENTRY_TYPE, gate);
        return { content: [{ type: "text", text: "Approval requested; the session will pause and resume with the human decision." }] };
      },
    } as any);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sh/harness exec vitest run test/request-approval-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/src/request-approval-tool.ts harness/test/request-approval-tool.test.ts
git commit -s -m "feat(gate): Add request_approval tool extension"
```

---

## Task 5: Gate marker I/O (`gate-marker.ts`)

**Files:**
- Create: `harness/src/gate-marker.ts`
- Test: `harness/test/gate-marker.test.ts`

**Interfaces:**
- Produces: `interface GateMarker { status: "awaiting_approval"; sessionId: string; gateId: number; gate: { summary: string; proposed_action: string }; ts: string }`; `deriveGateRef(resultRef: string, override?: string): string`; `writeGateMarker(path: string, marker: GateMarker): void`; `readGateMarker(path: string): GateMarker | null`.

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/gate-marker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveGateRef, writeGateMarker, readGateMarker, type GateMarker } from "../src/gate-marker";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gatemk-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("deriveGateRef", () => {
  it("defaults to <resultRef>.gate and honors an override", () => {
    expect(deriveGateRef("/work/r/out.json")).toBe("/work/r/out.json.gate");
    expect(deriveGateRef("/work/r/out.json", "/work/r/custom.gate")).toBe("/work/r/custom.gate");
  });
});

describe("gate marker write/read", () => {
  it("round-trips an awaiting_approval marker (and creates parent dirs)", () => {
    const p = join(dir, "nested", "out.json.gate");
    const m: GateMarker = {
      status: "awaiting_approval", sessionId: "run/i1", gateId: 0,
      gate: { summary: "s", proposed_action: "a" }, ts: "2026-06-28T00:00:00.000Z",
    };
    writeGateMarker(p, m);
    expect(existsSync(p)).toBe(true);
    expect(readGateMarker(p)).toEqual(m);
  });
  it("returns null for a missing/garbled file", () => {
    expect(readGateMarker(join(dir, "nope.gate"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/harness exec vitest run test/gate-marker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// harness/src/gate-marker.ts
import { writeFileSync, renameSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface GateMarker {
  status: "awaiting_approval";
  sessionId: string;
  gateId: number;
  gate: { summary: string; proposed_action: string };
  ts: string;
}

export function deriveGateRef(resultRef: string, override?: string): string {
  return override && override.length > 0 ? override : `${resultRef}.gate`;
}

/** Write atomically (temp + rename) so a reader never observes a partial marker. */
export function writeGateMarker(path: string, marker: GateMarker): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(marker));
  renameSync(tmp, path);
}

export function readGateMarker(path: string): GateMarker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as GateMarker;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sh/harness exec vitest run test/gate-marker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/src/gate-marker.ts harness/test/gate-marker.test.ts
git commit -s -m "feat(gate): Add awaiting_approval gate marker I/O"
```

---

## Task 6: `classifyOutcome` + `DoneMarker` for paused/aborted

**Files:**
- Modify: `harness/src/classify-outcome.ts`, `harness/src/done-marker.ts`
- Test: `harness/test/classify-outcome.test.ts` (extend)

**Interfaces:**
- Consumes: `LeafResult` (extended in Task 7 with `paused`/`aborted` — this task references those statuses; if Task 7 has not run yet, add the two `LeafResult` variants to `run-leaf.ts` as the first step here so the types compile, then Task 7 builds on them).
- Produces: `Outcome.marker` status union becomes `"done" | "failed" | "aborted"`; `classifyOutcome` handles `paused` (`{ ack: true, marker: null, retryable: false }`) and `aborted` (`{ ack: true, marker: { status: "aborted", reason: null }, retryable: false }`). `DoneMarker.status` becomes `"done" | "failed" | "aborted"`.

> **Ordering note:** This task depends on `LeafResult` having `paused`/`aborted`. Do Task 7 Step 3's `LeafResult` edit first, OR add those two variants here before editing `classify-outcome.ts`. The plan assumes Task 7 runs before Task 6 is reviewed; if executing strictly in order, add the `LeafResult` variants as Step 0 here.

- [ ] **Step 1: Write the failing test** (append to `harness/test/classify-outcome.test.ts`)

```typescript
  it("paused → ack, no terminal marker (runLeaf wrote the gate marker)", () => {
    expect(classifyOutcome({ status: "paused", gateRef: "/out.gate", gateId: 0 })).toEqual({
      ack: true, marker: null, retryable: false,
    });
  });
  it("aborted → ack + aborted terminal marker", () => {
    expect(classifyOutcome({ status: "aborted" })).toEqual({
      ack: true, marker: { status: "aborted", reason: null }, retryable: false,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/harness exec vitest run test/classify-outcome.test.ts`
Expected: FAIL — type error / branch missing (`paused`/`aborted` not handled).

- [ ] **Step 3: Edit `done-marker.ts` (status union)**

```typescript
export interface DoneMarker {
  status: "done" | "failed" | "aborted";
  sessionId: string;
  reason: string | null;
  ts: string;
}
```

- [ ] **Step 4: Edit `classify-outcome.ts`**

```typescript
import type { LeafResult } from "./run-leaf.js";

export interface Outcome {
  ack: boolean;
  marker: { status: "done" | "failed" | "aborted"; reason: string | null } | null;
  retryable: boolean;
}

/**
 * Decide what the leaf-job does with a queue entry given the leaf's terminal result.
 * - done / aborted / deterministic failures → ack (write a terminal marker where applicable).
 * - paused → ack with NO terminal marker (runLeaf already wrote the awaiting_approval gate marker;
 *   resume is a fresh re-invocation, not a redelivery).
 * - "error" (possibly transient) → no marker, no ack, retryable (reclaim).
 *   (A process crash never returns here at all → entry stays pending → reclaimed.)
 */
export function classifyOutcome(result: LeafResult): Outcome {
  if (result.status === "done") {
    return { ack: true, marker: { status: "done", reason: null }, retryable: false };
  }
  if (result.status === "paused") {
    return { ack: true, marker: null, retryable: false };
  }
  if (result.status === "aborted") {
    return { ack: true, marker: { status: "aborted", reason: null }, retryable: false };
  }
  if (result.reason === "error") {
    return { ack: false, marker: null, retryable: true };
  }
  return { ack: true, marker: { status: "failed", reason: result.reason }, retryable: false };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sh/harness exec vitest run test/classify-outcome.test.ts`
Expected: PASS (existing rows + the two new ones).

- [ ] **Step 6: Commit**

```bash
git add harness/src/classify-outcome.ts harness/src/done-marker.ts harness/test/classify-outcome.test.ts
git commit -s -m "feat(gate): classifyOutcome handles paused (ack, no marker) and aborted"
```

---

## Task 7: `run-leaf.ts` — envelope/result/capture/prompt + outer capture handling

**Files:**
- Modify: `harness/src/run-leaf.ts`
- Test: `harness/test/run-leaf.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveGateRef`, `writeGateMarker` (Task 5); `GateCapture` (Task 4); `validateVerdict` (existing).
- Produces: `LeafEnvelope` gains `gateRef?: string` + `decisionRef?: string`; `LeafItem` gains `require_approval?: boolean`; `LeafResult` gains `{ status: "paused"; gateRef: string; gateId: number }` and `{ status: "aborted" }`; `LeafCapture = VerdictCapture & GateCapture`; `ProduceVerdict`'s capture param becomes `LeafCapture`; `buildLeafPrompt(item, workspaceRef?)` appends a gate instruction when `item.require_approval`.

- [ ] **Step 1: Write the failing test** (append to `harness/test/run-leaf.test.ts`)

```typescript
import { existsSync, readFileSync as rf } from "node:fs";

describe("runLeaf gate outcomes", () => {
  it("capture.gate → writes the awaiting_approval gate marker and returns paused", async () => {
    const env = envelope();
    const produceVerdict = async (_i, _e, _c, capture) => {
      capture.gate = { gateId: 0, summary: "did X", proposed_action: "do Y" };
    };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toEqual({ status: "paused", gateRef: `${env.resultRef}.gate`, gateId: 0 });
    expect(existsSync(env.resultRef)).toBe(false); // no verdict written
    const m = JSON.parse(rf(`${env.resultRef}.gate`, "utf8"));
    expect(m).toMatchObject({ status: "awaiting_approval", gateId: 0, gate: { summary: "did X", proposed_action: "do Y" } });
  });

  it("capture.aborted → returns aborted, writes no verdict and no gate marker", async () => {
    const env = envelope();
    const produceVerdict = async (_i, _e, _c, capture) => { capture.aborted = true; };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toEqual({ status: "aborted" });
    expect(existsSync(env.resultRef)).toBe(false);
    expect(existsSync(`${env.resultRef}.gate`)).toBe(false);
  });

  it("honors an explicit gateRef override", async () => {
    const env = { ...envelope(), gateRef: join(dir, "custom.gate") };
    const produceVerdict = async (_i, _e, _c, capture) => {
      capture.gate = { gateId: 1, summary: "s", proposed_action: "a" };
    };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toEqual({ status: "paused", gateRef: env.gateRef, gateId: 1 });
    expect(existsSync(env.gateRef)).toBe(true);
  });
});

describe("buildLeafPrompt with require_approval", () => {
  it("adds a request_approval instruction when the item requires approval", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(", require_approval: true });
    expect(p).toContain("request_approval");
  });
  it("omits the gate instruction by default", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(" });
    expect(p).not.toContain("request_approval");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/harness exec vitest run test/run-leaf.test.ts`
Expected: FAIL — `paused`/`aborted` not in `LeafResult`; `runLeaf` does not write a gate marker; `require_approval` not handled.

- [ ] **Step 3: Edit `run-leaf.ts` — imports, types, capture, prompt, outer handling**

Add imports near the top (after the existing imports):

```typescript
import { deriveGateRef, writeGateMarker } from "./gate-marker.js";
import type { GateCapture } from "./request-approval-tool.js";
```

Replace the `LeafItem` interface:

```typescript
export interface LeafItem { item_id: string; file: string; pattern: string; require_approval?: boolean }
```

Add the optional envelope fields to `LeafEnvelope` (after `tenant?`):

```typescript
  gateRef?: string;           // overrides the derived <resultRef>.gate marker path (design §2.4)
  decisionRef?: string;       // present on a resume invocation; the decision file to apply (design §2.3)
```

Replace the `LeafResult` type:

```typescript
export type LeafResult =
  | { status: "done"; resultRef: string }
  | { status: "paused"; gateRef: string; gateId: number }
  | { status: "aborted" }
  | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error"; message?: string };
```

Add the combined capture type and update `ProduceVerdict` (after `LeafResult`):

```typescript
export type LeafCapture = VerdictCapture & GateCapture;

export type ProduceVerdict = (
  item: LeafItem,
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: LeafCapture,
) => Promise<void>;
```

(`VerdictCapture` is already imported from `./submit-verdict-tool.js`.)

Replace `buildLeafPrompt` to append the gate instruction conditionally:

```typescript
export function buildLeafPrompt(item: LeafItem, workspaceRef?: string): string {
  const filePath = workspaceRef ? `${workspaceRef.replace(/\/+$/, "")}/${item.file}` : item.file;
  const lines = [
    `You are reviewing one candidate finding in a sandboxed workspace.`,
    `Item id: ${item.item_id}`,
    `File (read this exact absolute path with the read tool): ${filePath}`,
    `Pattern of interest: ${item.pattern}`,
    `Read the file, decide whether the pattern is present and relevant.`,
  ];
  if (item.require_approval) {
    lines.push(
      `Before reporting, you MUST call the request_approval tool exactly once with a short summary`,
      `of what you found and the proposed_action ("submit verdict <X>"); then stop and wait.`,
    );
  }
  lines.push(
    `Report by calling the submit_verdict tool exactly once with item_id="${item.item_id}". Do not do anything else.`,
  );
  return lines.join("\n");
}
```

Replace the body of `runLeaf` between the `produce(...)` call and the verdict handling:

```typescript
export async function runLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceVerdict?: ProduceVerdict },
): Promise<LeafResult> {
  const item = readItem(env.inputsRef);
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
    const gateRef = deriveGateRef(env.resultRef, env.gateRef);
    writeGateMarker(gateRef, {
      status: "awaiting_approval",
      sessionId: env.sessionId,
      gateId: capture.gate.gateId,
      gate: { summary: capture.gate.summary, proposed_action: capture.gate.proposed_action },
      ts: new Date().toISOString(),
    });
    return { status: "paused", gateRef, gateId: capture.gate.gateId };
  }

  if (!capture.verdict) return { status: "failed", reason: "no_verdict" };
  const v = validateVerdict(capture.verdict);
  if (!v.ok) return { status: "failed", reason: "invalid_verdict", message: v.error };

  mkdirSync(dirname(env.resultRef), { recursive: true });
  writeFileSync(env.resultRef, JSON.stringify(v.value));
  return { status: "done", resultRef: env.resultRef };
}
```

Update `readItem` to carry `require_approval` through:

```typescript
function readItem(inputsRef: string): LeafItem | null {
  try {
    const o = JSON.parse(readFileSync(inputsRef, "utf8"));
    if (o && typeof o.item_id === "string" && typeof o.file === "string" && typeof o.pattern === "string") {
      return { item_id: o.item_id, file: o.file, pattern: o.pattern, require_approval: o.require_approval === true };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sh/harness exec vitest run test/run-leaf.test.ts`
Expected: PASS (existing verdict tests + the new gate/abort/prompt tests).

- [ ] **Step 5: Run the full harness suite (regression)**

Run: `pnpm --filter @sh/harness test`
Expected: PASS (Task 6 classify tests now compile against the new `LeafResult`).

- [ ] **Step 6: Commit**

```bash
git add harness/src/run-leaf.ts harness/test/run-leaf.test.ts
git commit -s -m "feat(gate): runLeaf writes the gate marker, returns paused/aborted; prompt gate instruction"
```

---

## Task 8: `realProduceVerdict` gate front-end wiring

**Files:**
- Modify: `harness/src/run-leaf.ts`

**Interfaces:**
- Consumes: `computeGateState`, `decideSeed`, `readDecision`, `GATE_DECISION_ENTRY_TYPE` (Tasks 1–3); `requestApprovalExtension` (Task 4).
- Produces: no new exports — `realProduceVerdict` now applies the gate state machine. **Not unit-tested** (it builds a real Redis-backed session); verified by the live smoke (Task 10), consistent with the existing "Exercised by the Kind smoke" note.

- [ ] **Step 1: Add imports**

```typescript
import { computeGateState, decideSeed, readDecision, GATE_DECISION_ENTRY_TYPE } from "./gate.js";
import { requestApprovalExtension } from "./request-approval-tool.js";
```

- [ ] **Step 2: Rewrite `realProduceVerdict` to apply the gate front-end**

Replace the existing `realProduceVerdict` body. The change inserts the gate front-end after the verdict fast-path and before wiring the agent session; it computes `seedPrompt` via `decideSeed`, short-circuits on paused/abort, appends the gate-decision record when present, and seeds the chosen prompt.

```typescript
export const realProduceVerdict: ProduceVerdict = async (item, env, config, capture) => {
  const cwd = config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  const sid = leafSessionId(env);
  const store = new RedisSessionBackend<FileEntry>(config?.redisUrl ?? "redis://localhost:6379");
  const backend = new BufferedRedisBackend(store);
  const isVerdictEntry = (e: unknown) =>
    (e as { type?: string }).type === "custom" &&
    (e as { customType?: string }).customType === VERDICT_ENTRY_TYPE;

  const prior = await store.read(sid);
  const resuming = prior.length > 0;
  const sessionManager = resuming
    ? await SessionManager.openFromCheckpoint(sid, backend, cwd)
    : SessionManager.create(cwd, undefined, { id: sid }, backend);

  // Verdict fast-path (unchanged): recover a previously-submitted verdict on resume.
  if (resuming) {
    const row = await store.latestWhere(sid, isVerdictEntry);
    const recovered = verdictFromCustomEntry(row?.entry);
    if (recovered) {
      capture.verdict = recovered;
      await backend.flush();
      return;
    }
  }

  // Gate front-end (design §3): decide whether to pause, abort, or seed a prompt.
  const gateState = computeGateState(prior.map((p) => p.entry));
  const decision = env.decisionRef ? readDecision(env.decisionRef) : null;
  const seed = decideSeed(gateState, decision, buildLeafPrompt(item, env.workspaceRef));

  if (seed.kind === "abort") {
    if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);
    capture.aborted = true;
    await backend.flush();
    return;
  }
  if (seed.kind === "paused") {
    capture.gate = seed.gate; // re-report the pending gate; runLeaf (re)writes the marker
    await backend.flush();
    return;
  }
  // seed.kind === "seed": record the decision (once) before running the continuation/fresh turn.
  if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      submitVerdictExtension(capture, sessionManager),
      requestApprovalExtension(capture, sessionManager, gateState.nextGateId),
      k8sSandboxExtension(),
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
};
```

- [ ] **Step 3: Typecheck + full harness suite (no behavior regression)**

Run: `pnpm --filter @sh/harness test`
Expected: PASS — all existing tests green (the gate front-end is inert when no gate entries/decision exist: `decideSeed` returns `{ kind: "seed", prompt: buildLeafPrompt(...) }`, reproducing today's behavior).

- [ ] **Step 4: Build the package (catch type errors in the real wiring)**

Run: `pnpm --filter @sh/harness build` (or the repo's typecheck: `pnpm -r exec tsc --noEmit` if `build` is absent)
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add harness/src/run-leaf.ts
git commit -s -m "feat(gate): wire gate front-end into realProduceVerdict (pause/abort/continue)"
```

---

## Task 9: Status endpoint reports `awaiting_approval`

**Files:**
- Modify: `packages/knative-server/src/server.ts`
- Test: `packages/knative-server/test/run-leaf-async-route.test.ts` (extend)

**Interfaces:**
- Consumes: `readGateMarker`, `deriveGateRef` (Task 5).
- Produces: `GET /run-leaf/status` — when no terminal marker is present and a `gateMarker` query param is supplied (and within the work root), returns `{ status: "awaiting_approval", gateId }`; otherwise unchanged (`done`/`failed`/`aborted` from the terminal marker, else `queued`).

- [ ] **Step 1: Write the failing test** (append to `packages/knative-server/test/run-leaf-async-route.test.ts`)

First, extend the existing `vi.mock("@sh/harness/done-marker", …)` block's sibling: add a mock for the gate marker module near the other mocks at the top of the file:

```typescript
vi.mock("@sh/harness/gate-marker", () => ({
  readGateMarker: vi.fn(),
  deriveGateRef: (r: string, o?: string) => o ?? `${r}.gate`,
}));
import { readGateMarker } from "@sh/harness/gate-marker";
const mockedReadGate = vi.mocked(readGateMarker);
```

Then add the test cases:

```typescript
  it("status returns awaiting_approval from the gate marker when no terminal marker yet", async () => {
    readDoneMarker.mockReturnValue(null);
    mockedReadGate.mockReturnValue({
      status: "awaiting_approval", sessionId: "run/i1", gateId: 0,
      gate: { summary: "s", proposed_action: "a" }, ts: "t",
    });
    const r = await req("GET", "/run-leaf/status?doneMarker=/work/out.status&gateMarker=/work/out.json.gate");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "awaiting_approval", gateId: 0 });
  });

  it("status rejects a gateMarker outside the work root (path traversal)", async () => {
    readDoneMarker.mockReturnValue(null);
    const r = await req("GET", "/run-leaf/status?doneMarker=/work/out.status&gateMarker=/etc/shadow");
    expect(r.status).toBe(403);
  });

  it("status still returns queued when neither terminal nor gate marker is present", async () => {
    readDoneMarker.mockReturnValue(null);
    mockedReadGate.mockReturnValue(null);
    const r = await req("GET", "/run-leaf/status?doneMarker=/work/out.status&gateMarker=/work/out.json.gate");
    expect(r.json).toMatchObject({ status: "queued" });
  });
```

> Adapt the mock declarations to the file's existing structure (it already mocks `@sh/harness/done-marker` and imports `readDoneMarker`). Place the new `vi.mock` beside it, before `startServer` is imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sh/knative-server exec vitest run test/run-leaf-async-route.test.ts`
Expected: FAIL — status returns `queued` (not `awaiting_approval`); no path guard on `gateMarker`.

- [ ] **Step 3: Edit `server.ts`**

Add the import (beside the existing done-marker import):

```typescript
import { readGateMarker } from "@sh/harness/gate-marker";
```

Add a small confinement helper and extend `handleLeafStatus`:

```typescript
// Confine an untrusted marker path to the work root (path-traversal guard). Returns null if outside.
function confineToWorkRoot(p: string): string | null {
  const resolved = resolvePath(p);
  if (resolved !== WORK_ROOT && !resolved.startsWith(`${WORK_ROOT}/`)) return null;
  return resolved;
}

function handleLeafStatus(url: URL, res: ServerResponse): void {
  const doneMarker = url.searchParams.get("doneMarker");
  if (!doneMarker) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "doneMarker_required" })); return; }
  const resolved = confineToWorkRoot(doneMarker);
  if (!resolved) { res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ error: "doneMarker_forbidden" })); return; }

  const marker = readDoneMarker(resolved);
  if (marker) {
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: marker.status, reason: marker.reason ?? undefined }));
    return;
  }

  // No terminal marker yet — if a gate marker path is supplied, report awaiting_approval.
  const gateMarker = url.searchParams.get("gateMarker");
  if (gateMarker) {
    const g = confineToWorkRoot(gateMarker);
    if (!g) { res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ error: "gateMarker_forbidden" })); return; }
    const gm = readGateMarker(g);
    if (gm) {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: gm.status, gateId: gm.gateId }));
      return;
    }
  }

  // Best-effort non-terminal state for visibility.
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "queued" }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sh/knative-server exec vitest run test/run-leaf-async-route.test.ts`
Expected: PASS (existing status tests + the three new ones).

- [ ] **Step 5: Full server suite (regression)**

Run: `pnpm --filter @sh/knative-server test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/knative-server/src/server.ts packages/knative-server/test/run-leaf-async-route.test.ts
git commit -s -m "feat(gate): status endpoint reports awaiting_approval from the gate marker"
```

---

## Task 10: Live gate smoke (`leaf-gate-smoke.sh`)

**Files:**
- Create: `deploy/knative/leaf-gate-smoke.sh`

**Interfaces:**
- Consumes: the async deploy (KEDA + `leaf-scaledjob.yaml`, Redis, sandbox-0, `/work` PVC, ksvc), `deploy/knative/lib.sh` (provides `$NS`, `$BASE`, `$HOST_HEADER`), the leaf-orchestrator pod for in-cluster `kubectl exec` writes to `/work`. The `controller` (not a subagent) runs this gate.
- Produces: a gated end-to-end proof of pause → scale-to-zero → resume-approve → reject-then-approve → abort → idempotent resume (spec §7.2).

> This task's deliverable is verified by **running the script on the Kind `sh-knative` cluster**, not by a unit test. The image must be rebuilt + kind-loaded + pods recreated so the new gate code runs in-cluster (see the run note below). Per CLAUDE.md context budget, the controller redirects verbose `kubectl`/build output to `/tmp/kagenti/human-gate/` and analyzes logs in subagents.

- [ ] **Step 1: Create the smoke script**

```bash
#!/usr/bin/env bash
# deploy/knative/leaf-gate-smoke.sh
# Gated Kind smoke for the human-gate (design §7.2). Proves: pause (awaiting_approval marker),
# scale-to-zero while parked, resume-approve to verdict, reject-then-approve, abort, idempotent resume.
# Prereq: setup-kind.sh (incl. KEDA) done; image rebuilt with the gate code; leaf-pvc.yaml +
#   leaf-orchestrator.yaml + leaf-scaledjob.yaml applied; sandbox-0 up.
# Usage: GATE_LIVE_SMOKE=1 bash deploy/knative/leaf-gate-smoke.sh
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

[ "${GATE_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set GATE_LIVE_SMOKE=1)"; exit 0; }

ORCH=leaf-orchestrator; SBOX="${KAGENTI_SANDBOX_POD:-sandbox-0}"
RUN="grun-$$"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
MODEL="${SH_MODEL:-claude-haiku-4-5}"
trap 'kubectl -n "$NS" exec "$SBOX" -- sh -c "rm -rf /workspace/$RUN" 2>/dev/null || true' EXIT
claim() { echo ""; echo "--- Claim $1: $2 ---"; }
oexec() { kubectl -n "$NS" exec "$ORCH" -- "$@"; }
leaf_job_pods() { kubectl get pods -n "$NS" -l scaledjob.keda.sh/name=leaf-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' '; }

# Seed one gated item (require_approval:true) and the fixture repo file.
oexec mkdir -p "$INPUTS" "$RES"
oexec sh -c "cat > $INPUTS/i1.json" <<JSON
{ "item_id": "i1", "file": "a.py", "pattern": "eval(", "require_approval": true }
JSON
kubectl -n "$NS" exec "$SBOX" -- sh -c "mkdir -p $SBOX_REPO && printf 'x = eval(\"1+1\")\n' > $SBOX_REPO/a.py"

# Dispatch async; substitute resume fields per call.
dispatch() { # $1=extra-json
  jq -nc --arg s "$RUN/i1" --arg m "$MODEL" --arg in "$INPUTS/i1.json" --arg out "$RES/i1.json" --arg ws "$SBOX_REPO" \
    --argjson extra "${1:-{}}" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws, async:true} + $extra' \
  | curl -s --max-time 30 -H "$HOST_HEADER" -H "Content-Type: application/json" -d @- "$BASE/run-leaf"
}
write_decision() { # $1=action $2=feedback?
  jq -nc --argjson g 0 --arg a "$1" --arg f "${2:-}" '{gateId:$g, action:$a} + (if $f=="" then {} else {feedback:$f} end)' \
  | oexec sh -c "cat > $RES/i1.json.decision"
}
gate_marker() { oexec sh -c "cat $RES/i1.json.gate 2>/dev/null || true"; }
result() { oexec sh -c "cat $RES/i1.json 2>/dev/null || true"; }
done_marker() { oexec sh -c "cat $RES/i1.json.status 2>/dev/null || true"; }
wait_for() { local f="$1" n=0; until oexec sh -c "test -f $f"; do n=$((n+1)); [ $n -gt 60 ] && { echo "TIMEOUT $f"; exit 1; }; sleep 2; done; }

claim 1 "Pause: dispatch a gated leaf -> awaiting_approval gate marker, no result"
dispatch >/dev/null
wait_for "$RES/i1.json.gate"
gate_marker | grep -q '"status":"awaiting_approval"' || { echo "FAIL: no awaiting_approval marker"; exit 1; }
gate_marker | grep -q '"gateId":0' || { echo "FAIL: gateId 0 expected"; exit 1; }
oexec sh -c "test ! -f $RES/i1.json" || { echo "FAIL: result written before approval"; exit 1; }
echo "OK gate marker present, no verdict"

claim 2 "Scale-to-zero while parked"
n=0; until [ "$(leaf_job_pods)" = "0" ]; do n=$((n+1)); [ $n -gt 60 ] && { echo "FAIL: pods did not scale to zero"; exit 1; }; sleep 5; done
echo "OK leaf-job pods at zero while gate pending"

claim 3 "Resume-approve -> verdict"
write_decision approve
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
result | grep -q '"verdict":"FLAGGED"' || { echo "FAIL: expected FLAGGED verdict after approve"; exit 1; }
done_marker | grep -q '"status":"done"' || { echo "FAIL: expected done marker"; exit 1; }
echo "OK approved -> FLAGGED verdict, done"

claim 4 "Idempotent resume: re-invoke with the same consumed decision -> still done, no change"
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
done_marker | grep -q '"status":"done"' || { echo "FAIL: terminal state changed on re-invoke"; exit 1; }
echo "OK idempotent re-invoke stable"

# Abort scenario on a fresh run id.
RUN="grun-abort-$$"; INPUTS="/work/$RUN/inputs"; RES="/work/$RUN/results"; SBOX_REPO="/workspace/$RUN/repo"
oexec mkdir -p "$INPUTS" "$RES"
oexec sh -c "cat > $INPUTS/i1.json" <<JSON
{ "item_id": "i1", "file": "a.py", "pattern": "eval(", "require_approval": true }
JSON
kubectl -n "$NS" exec "$SBOX" -- sh -c "mkdir -p $SBOX_REPO && printf 'x = eval(\"1+1\")\n' > $SBOX_REPO/a.py"

claim 5 "Abort -> aborted marker, no verdict"
dispatch >/dev/null
wait_for "$RES/i1.json.gate"
write_decision abort
dispatch '{"decisionRef":"'"$RES"'/i1.json.decision"}' >/dev/null
wait_for "$RES/i1.json.status"
done_marker | grep -q '"status":"aborted"' || { echo "FAIL: expected aborted marker"; exit 1; }
oexec sh -c "test ! -f $RES/i1.json" || { echo "FAIL: verdict written on abort"; exit 1; }
echo "OK aborted, no verdict"

echo ""; echo "ALL GATE SMOKE CLAIMS PASSED"
```

- [ ] **Step 2: Make it executable and commit (the run is the verification, performed by the controller)**

```bash
chmod +x deploy/knative/leaf-gate-smoke.sh
git add deploy/knative/leaf-gate-smoke.sh
git commit -s -m "test(gate): Add gated live human-gate smoke (pause/approve/reject/abort/idempotent)"
```

- [ ] **Step 3: (Controller-run) Rebuild image, reload, run the smoke**

> Run by the controller, NOT a subagent (long live gate). Redirect to `/tmp/kagenti/human-gate/`.

```bash
mkdir -p /tmp/kagenti/human-gate
# Rebuild + load the image so the new gate code runs in-cluster (IfNotPresent → must recreate pods):
docker build -t dev.local/serverless-harness:local . > /tmp/kagenti/human-gate/build.log 2>&1; echo "EXIT:$?"
kind load docker-image dev.local/serverless-harness:local --name sh-knative > /tmp/kagenti/human-gate/load.log 2>&1; echo "EXIT:$?"
kubectl delete pod -n default -l serving.knative.dev/service=serverless-harness --ignore-not-found > /dev/null 2>&1
# Run the gate (cap the duration; analyze the log in a subagent):
GATE_LIVE_SMOKE=1 bash deploy/knative/leaf-gate-smoke.sh > /tmp/kagenti/human-gate/smoke.log 2>&1; echo "EXIT:$?"
grep -E "ALL GATE SMOKE|FAIL|TIMEOUT" /tmp/kagenti/human-gate/smoke.log
```

Expected: `ALL GATE SMOKE CLAIMS PASSED`, exit 0.

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §2.1 `request_approval` tool + durable gate-request + benign result | T4 |
| §2.2 `awaiting_approval` gate marker (atomic, gateRef) | T5; written by T7 |
| §2.3 decision file + `gateId` echo + ignore-on-mismatch | T1 (`readDecision`/`validateDecision`), T3 (mismatch → paused) |
| §2.4 envelope `gateRef`/`decisionRef` | T7 |
| §2.5 resume trigger = re-invoke by `sessionId` (sync/async) | existing path; exercised T10 |
| §2.6 `LeafResult` `paused`/`aborted`; gate marker by `runLeaf`; sync prompt return | T7 |
| §3 resume state machine (branches a/b/c, gateId idempotency) | T2 (`computeGateState`), T3 (`decideSeed`), T8 (wiring) |
| §3.1 continuation re-seed + crash-mid-resume safety | T2 (`continuationPrompt`), T3, T8 |
| §4 `classifyOutcome` paused→ack/no-marker, aborted→ack+marker; two-marker model | T6 |
| §4 status endpoint reports `awaiting_approval` | T9 |
| §5 failure modes / idempotency / no timeout | T3 (already-aborted terminal, double-resume), T8, T10 |
| §6 components 1–11 | T1–T10 |
| §7.1 unit tests | T1–T7, T9 |
| §7.2 live gate (6 scenarios) | T10 |
| §8 nothing-else-changes (auto-approve not built, no watcher) | enforced across tasks (no new endpoint, leaf-job-runner untouched) |

No gaps. Auto-approve and harness timeout are correctly absent (spec defers them).

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to". Every code step shows full code. The two non-unit-tested deliverables (T8 wiring, T10 smoke) are explicitly verified by the live gate, matching the existing `realProduceVerdict` convention.

**3. Type consistency:**
- `GateRequest`/`Decision`/`GateDecision`/`GateAction` defined in T1, consumed unchanged in T2/T3/T4/T8.
- `GATE_REQUEST_ENTRY_TYPE`/`GATE_DECISION_ENTRY_TYPE` defined T1, used T4 (request) and T8 (decision).
- `GateCapture` defined T4, intersected into `LeafCapture` T7, set by `requestApprovalExtension` (T4) and read by `runLeaf` (T7).
- `SeedDecision` kinds (`paused`/`abort`/`seed`) produced T3, consumed T8.
- `LeafResult` `paused`/`aborted` added T7, consumed by `classifyOutcome` T6 (ordering note in T6 covers the dependency).
- `deriveGateRef`/`writeGateMarker`/`readGateMarker`/`GateMarker` defined T5, used by `runLeaf` (T7) and `server.ts` (T9).
- `computeGateState` returns `nextGateId` (T2), passed to `requestApprovalExtension` (T8).

Consistent end-to-end.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
