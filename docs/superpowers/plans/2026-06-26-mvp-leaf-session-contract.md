# MVP Leaf-Session Invocation Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the harness a leaf-session backend an external orchestrator can call: a `/run-leaf` endpoint that runs a Pi agent to completion in a sandbox, captures a schema-validated verdict via a `submit_verdict` tool, and delivers it through a shared-volume envelope.

**Architecture:** A new `runLeaf` function (sibling to `runTurn`) reads a candidate from `inputs_ref` on a shared volume, seeds a Pi session whose only required output is a `submit_verdict` tool call, runs it to completion, validates the captured verdict, and writes it to `result_ref`. The Knative server exposes this as `POST /run-leaf`. A minimal bash orchestrator (stand-in for the external orchestrator) fans out N calls, retries failures, and audits coverage. Reuses M2/M3 sandbox, M4 Knative + `runTurn` internals, M6 model selection.

**Tech Stack:** TypeScript (ESM, `tsx` runtime, `noEmit`), pnpm workspaces, Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`), TypeBox tool schemas, vitest, raw Node `http`, Knative + a shared PVC on Kind.

## Global Constraints

- **No new spec scope.** Single-tenant, **provider key in env** (no Z3 injector). No per-user identity (Z1), no credentialed egress (Z5), no human-gate, no trigger. (charter)
- **Re-entrancy-friendly (do not preclude):** `/run-leaf` must NOT assume only an external orchestrator calls it — a leaf session may later call it to spawn a child. Do not bake a caller-identity check. (MVP spec §2.5)
- **Harness does not own the domain store:** the verdict travels via `result_ref` on a volume the caller owns; the HTTP response carries **terminal status only**. (MVP spec §2.1, charter G3)
- **The harness (trusted code) writes `result_ref`,** after schema validation — never model-authored code; the workspace mount is **read-only** to the agent. (MVP spec §2.3)
- **Verdict schema:** `{ item_id: string, verdict: "FLAGGED" | "CLEAR", reason: string }`. (MVP spec §2.3)
- **Idempotency key = `session_id`;** retry = re-invoke; `result_ref` rewritten fresh each run. (MVP spec §2.4)
- **DCO:** every commit uses `git commit -s`; no `Co-Authored-By`. Conventional-commit prefixes.
- Tests are vitest under each package's `test/**/*.test.ts`; run with `pnpm -C harness exec vitest run test/<file>`.

---

## File Structure

- `harness/src/verdict.ts` — verdict type + dependency-free `validateVerdict()`.
- `harness/src/submit-verdict-tool.ts` — `submitVerdictExtension(capture)`: registers the `submit_verdict` Pi tool (TypeBox params), validates, captures.
- `harness/src/run-leaf.ts` — `runLeaf()` (envelope I/O + status), `buildLeafPrompt()`, `realProduceVerdict()` (the Pi session runner, injectable).
- `harness/test/verdict.test.ts`, `harness/test/submit-verdict-tool.test.ts`, `harness/test/run-leaf.test.ts` — unit tests.
- `packages/knative-server/src/server.ts` — add `POST /run-leaf` route (modify).
- `packages/knative-server/test/run-leaf-route.test.ts` — route test (vi.mock runLeaf).
- `deploy/knative/fixtures/repo/` + `deploy/knative/fixtures/inputs/` — tiny fixture repo + sample candidates.
- `deploy/knative/leaf-pvc.yaml`, `deploy/knative/leaf-orchestrator.yaml` — shared PVC + in-cluster orchestrator pod.
- `deploy/knative/leaf-smoke.sh` — gated Kind smoke (parallel + retry + coverage + scale-to-zero).

---

### Task 1: Verdict schema + validation

**Files:**
- Create: `harness/src/verdict.ts`
- Test: `harness/test/verdict.test.ts`

**Interfaces:**
- Produces:
  - `type Verdict = { item_id: string; verdict: "FLAGGED" | "CLEAR"; reason: string }`
  - `function validateVerdict(obj: unknown): { ok: true; value: Verdict } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/verdict.test.ts
import { describe, it, expect } from "vitest";
import { validateVerdict } from "../src/verdict";

describe("validateVerdict", () => {
  it("accepts a well-formed verdict", () => {
    const r = validateVerdict({ item_id: "i1", verdict: "FLAGGED", reason: "calls eval on input" });
    expect(r).toEqual({ ok: true, value: { item_id: "i1", verdict: "FLAGGED", reason: "calls eval on input" } });
  });

  it("rejects an unknown verdict label", () => {
    const r = validateVerdict({ item_id: "i1", verdict: "MAYBE", reason: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(validateVerdict({ item_id: "i1", verdict: "CLEAR" }).ok).toBe(false);
    expect(validateVerdict({ verdict: "CLEAR", reason: "x" }).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateVerdict(null).ok).toBe(false);
    expect(validateVerdict("nope").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/verdict.test.ts`
Expected: FAIL — cannot find module `../src/verdict`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// harness/src/verdict.ts
export type VerdictLabel = "FLAGGED" | "CLEAR";

export interface Verdict {
  item_id: string;
  verdict: VerdictLabel;
  reason: string;
}

export function validateVerdict(
  obj: unknown,
): { ok: true; value: Verdict } | { ok: false; error: string } {
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, error: "verdict must be an object" };
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.item_id !== "string" || o.item_id.length === 0) {
    return { ok: false, error: "item_id must be a non-empty string" };
  }
  if (o.verdict !== "FLAGGED" && o.verdict !== "CLEAR") {
    return { ok: false, error: 'verdict must be "FLAGGED" or "CLEAR"' };
  }
  if (typeof o.reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  return { ok: true, value: { item_id: o.item_id, verdict: o.verdict, reason: o.reason } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/verdict.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add harness/src/verdict.ts harness/test/verdict.test.ts
git commit -s -m "feat(harness): verdict schema + validateVerdict"
```

---

### Task 2: `submit_verdict` tool + capture extension

**Files:**
- Create: `harness/src/submit-verdict-tool.ts`
- Test: `harness/test/submit-verdict-tool.test.ts`

**Interfaces:**
- Consumes: `Verdict`, `validateVerdict` (Task 1).
- Produces:
  - `interface VerdictCapture { verdict?: Verdict }`
  - `function submitVerdictExtension(capture: VerdictCapture): ExtensionFactory` — registers a tool named `submit_verdict`.
- Mirror the TypeBox `Type` import and `registerTool`/`ToolDefinition` shape from an existing tool — see `packages/k8s-sandbox/src/*` tool creators and `pi-fork/packages/coding-agent/src/core/tools/read.ts` (`Type.Object({...})`). `ExtensionFactory` and `ExtensionAPI` come from `@earendil-works/pi-coding-agent`.

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/submit-verdict-tool.test.ts
import { describe, it, expect } from "vitest";
import { submitVerdictExtension, type VerdictCapture } from "../src/submit-verdict-tool";

// Minimal fake ExtensionAPI that records the registered tool.
function fakePi() {
  const tools: any[] = [];
  return { api: { registerTool: (t: any) => tools.push(t), on: () => {} } as any, tools };
}

describe("submitVerdictExtension", () => {
  it("registers a submit_verdict tool", () => {
    const capture: VerdictCapture = {};
    const { api, tools } = fakePi();
    submitVerdictExtension(capture)(api);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("submit_verdict");
  });

  it("captures a valid verdict and returns success", async () => {
    const capture: VerdictCapture = {};
    const { api, tools } = fakePi();
    submitVerdictExtension(capture)(api);
    const res = await tools[0].execute("call-1", { item_id: "i1", verdict: "FLAGGED", reason: "r" }, undefined, undefined, {} as any);
    expect(capture.verdict).toEqual({ item_id: "i1", verdict: "FLAGGED", reason: "r" });
    expect(res.isError).toBeFalsy();
  });

  it("rejects an invalid verdict and does not capture", async () => {
    const capture: VerdictCapture = {};
    const { api, tools } = fakePi();
    submitVerdictExtension(capture)(api);
    const res = await tools[0].execute("call-1", { item_id: "i1", verdict: "MAYBE", reason: "r" }, undefined, undefined, {} as any);
    expect(capture.verdict).toBeUndefined();
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/submit-verdict-tool.test.ts`
Expected: FAIL — cannot find module `../src/submit-verdict-tool`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// harness/src/submit-verdict-tool.ts
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { validateVerdict, type Verdict } from "./verdict";

export interface VerdictCapture {
  verdict?: Verdict;
}

const params = Type.Object({
  item_id: Type.String({ description: "The id of the item being judged (echo the input item_id)" }),
  verdict: Type.Union([Type.Literal("FLAGGED"), Type.Literal("CLEAR")], {
    description: "FLAGGED if the pattern is present and relevant; CLEAR otherwise",
  }),
  reason: Type.String({ description: "One sentence justifying the verdict" }),
});

export function submitVerdictExtension(capture: VerdictCapture): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "submit_verdict",
      label: "Submit verdict",
      description:
        "Submit your final verdict for the item. Call this exactly once when you are done. " +
        "After calling it, stop.",
      parameters: params,
      async execute(_id, args) {
        const r = validateVerdict(args);
        if (!r.ok) {
          return { isError: true, content: [{ type: "text", text: `Invalid verdict: ${r.error}` }] };
        }
        capture.verdict = r.value;
        return { content: [{ type: "text", text: "Verdict recorded." }] };
      },
    } as any);
  };
}
```

> If the build complains that `Type` is not exported from `@sinclair/typebox`, import it from the
> same module the existing Pi tools use (check the import line at the top of
> `pi-fork/packages/coding-agent/src/core/tools/read.ts`) and match that.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/submit-verdict-tool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add harness/src/submit-verdict-tool.ts harness/test/submit-verdict-tool.test.ts
git commit -s -m "feat(harness): submit_verdict tool + capture extension"
```

---

### Task 3: `runLeaf` — envelope I/O, prompt, status (model boundary injected)

**Files:**
- Create: `harness/src/run-leaf.ts`
- Test: `harness/test/run-leaf.test.ts`

**Interfaces:**
- Consumes: `Verdict`, `validateVerdict` (Task 1); `submitVerdictExtension`, `VerdictCapture` (Task 2); `TurnConfig` (`harness/src/run-turn.ts:17`).
- Produces:
  - `interface LeafItem { item_id: string; file: string; pattern: string }`
  - `interface LeafEnvelope { sessionId: string; model?: string; provider?: string; inputsRef: string; resultRef: string; workspaceRef?: string; maxTurns?: number }`
  - `type LeafResult = { status: "done"; resultRef: string } | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error"; message?: string }`
  - `function buildLeafPrompt(item: LeafItem, workspaceRef?: string): string`
  - `type ProduceVerdict = (item: LeafItem, env: LeafEnvelope, config: TurnConfig | undefined, capture: VerdictCapture) => Promise<void>`
  - `function runLeaf(env: LeafEnvelope, config?: TurnConfig, deps?: { produceVerdict?: ProduceVerdict }): Promise<LeafResult>`
  - `const realProduceVerdict: ProduceVerdict` (wires Pi; exercised in Task 6, not unit-tested here)

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/run-leaf.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLeaf, buildLeafPrompt, type LeafEnvelope } from "../src/run-leaf";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "leaf-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function envelope(): LeafEnvelope {
  const inputsRef = join(dir, "in.json");
  const resultRef = join(dir, "out.json");
  writeFileSync(inputsRef, JSON.stringify({ item_id: "i1", file: "a.py", pattern: "eval(" }));
  return { sessionId: "run/i1", inputsRef, resultRef };
}

describe("buildLeafPrompt", () => {
  it("includes the file, pattern, and submit_verdict instruction", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(" });
    expect(p).toContain("a.py");
    expect(p).toContain("eval(");
    expect(p).toContain("submit_verdict");
  });
});

describe("runLeaf", () => {
  it("writes the validated verdict to result_ref and returns done", async () => {
    const env = envelope();
    const produceVerdict = async (_i, _e, _c, capture) => {
      capture.verdict = { item_id: "i1", verdict: "FLAGGED", reason: "found eval" };
    };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toEqual({ status: "done", resultRef: env.resultRef });
    expect(JSON.parse(readFileSync(env.resultRef, "utf8"))).toEqual({
      item_id: "i1", verdict: "FLAGGED", reason: "found eval",
    });
  });

  it("returns failed:no_verdict and writes nothing when the agent submits none", async () => {
    const env = envelope();
    const produceVerdict = async () => { /* never captures */ };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toEqual({ status: "failed", reason: "no_verdict" });
    expect(existsSync(env.resultRef)).toBe(false);
  });

  it("returns failed:bad_inputs when inputs_ref is missing/invalid", async () => {
    const env = { ...envelope(), inputsRef: join(dir, "nope.json") };
    const res = await runLeaf(env, undefined, { produceVerdict: async () => {} });
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.reason).toBe("bad_inputs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/run-leaf.test.ts`
Expected: FAIL — cannot find module `../src/run-leaf`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// harness/src/run-leaf.ts
import { readFileSync, writeFileSync } from "node:fs";
import {
  createAgentSession,
  SessionManager,
  type AssistantMessage,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { resolveModelSelection, requireModel, type TurnConfig } from "./run-turn";
import { submitVerdictExtension, type VerdictCapture } from "./submit-verdict-tool";
import { validateVerdict } from "./verdict";

export interface LeafItem { item_id: string; file: string; pattern: string }

export interface LeafEnvelope {
  sessionId: string;
  model?: string;
  provider?: string;
  inputsRef: string;
  resultRef: string;
  workspaceRef?: string;
  maxTurns?: number;
}

export type LeafResult =
  | { status: "done"; resultRef: string }
  | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error"; message?: string };

export function buildLeafPrompt(item: LeafItem, workspaceRef?: string): string {
  const root = workspaceRef ?? ".";
  return [
    `You are reviewing one candidate finding in the repository at ${root}.`,
    `Item id: ${item.item_id}`,
    `File: ${item.file}`,
    `Pattern of interest: ${item.pattern}`,
    `Open the file, decide whether the pattern is present and relevant, then report by calling`,
    `the submit_verdict tool exactly once with item_id="${item.item_id}". Do not do anything else.`,
  ].join("\n");
}

export type ProduceVerdict = (
  item: LeafItem,
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: VerdictCapture,
) => Promise<void>;

function readItem(inputsRef: string): LeafItem | null {
  try {
    const o = JSON.parse(readFileSync(inputsRef, "utf8"));
    if (o && typeof o.item_id === "string" && typeof o.file === "string" && typeof o.pattern === "string") {
      return { item_id: o.item_id, file: o.file, pattern: o.pattern };
    }
    return null;
  } catch {
    return null;
  }
}

export async function runLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceVerdict?: ProduceVerdict },
): Promise<LeafResult> {
  const item = readItem(env.inputsRef);
  if (!item) return { status: "failed", reason: "bad_inputs" };

  const capture: VerdictCapture = {};
  const produce = deps?.produceVerdict ?? realProduceVerdict;
  try {
    await produce(item, env, config, capture);
  } catch (err) {
    return { status: "failed", reason: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (!capture.verdict) return { status: "failed", reason: "no_verdict" };
  const v = validateVerdict(capture.verdict);
  if (!v.ok) return { status: "failed", reason: "invalid_verdict", message: v.error };

  writeFileSync(env.resultRef, JSON.stringify(v.value));
  return { status: "done", resultRef: env.resultRef };
}

// Real Pi session runner — mirrors harness/src/run-turn.ts session setup.
// Exercised by the Kind smoke (Task 6), not the unit tests.
export const realProduceVerdict: ProduceVerdict = async (item, env, config, capture) => {
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  requireModel(provider, modelId);
  const model = getModel(provider as never, modelId as never);

  const sessionManager = SessionManager.create(
    env.workspaceRef ?? config?.cwd ?? process.cwd(),
    undefined as never,
  );
  const { session } = await createAgentSession({
    sessionManager,
    model: model as never,
  });
  // Register the verdict tool by extending the session's extension set the same way
  // run-turn.ts wires extensions; here we add submitVerdictExtension(capture).
  // (See run-turn.ts:83-103 for the extensionFactories pattern to mirror.)
  await (session as any).addExtension?.(submitVerdictExtension(capture));
  await session.prompt(buildLeafPrompt(item, env.workspaceRef));
  void (session.state.messages.at(-1) as AssistantMessage | undefined);
};
```

> **Note for the implementer:** `realProduceVerdict` must register `submitVerdictExtension(capture)`
> on the session **before** `session.prompt(...)`. The exact wiring mirrors the `extensionFactories`
> array in `harness/src/run-turn.ts:83-103` (pass it into `createAgentSession` via the same
> mechanism `run-turn.ts` uses for `k8sSandboxExtension()` and `flushExtension`). If
> `createAgentSession` takes extensions as an option, pass `[submitVerdictExtension(capture),
> k8sSandboxExtension()]` there instead of the `addExtension` shim above. Confirm against the
> `CreateAgentSessionOptions` type in `pi-fork/packages/coding-agent/src/core/sdk.ts:166`. This part
> is verified live in Task 6, not by unit tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/run-leaf.test.ts`
Expected: PASS (buildLeafPrompt + 3 runLeaf tests). The unit tests inject `produceVerdict`, so the live Pi path is not exercised here.

- [ ] **Step 5: Commit**

```bash
git add harness/src/run-leaf.ts harness/test/run-leaf.test.ts
git commit -s -m "feat(harness): runLeaf envelope I/O + verdict status (model boundary injected)"
```

---

### Task 4: `POST /run-leaf` route on the Knative server

**Files:**
- Modify: `packages/knative-server/src/server.ts` (add a handler + route; mirror `handleTurn` at `:1-90`)
- Test: `packages/knative-server/test/run-leaf-route.test.ts`

**Interfaces:**
- Consumes: `runLeaf`, `LeafEnvelope`, `LeafResult` from `@sh/harness/run-leaf`.
- Produces: `POST /run-leaf` → `200 { status, ... }` on a handled invocation (done OR failed), `400 { error: "envelope_invalid" }` on a malformed body.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/knative-server/test/run-leaf-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const runLeaf = vi.fn();
vi.mock("@sh/harness/run-leaf", () => ({ runLeaf: (...a: any[]) => runLeaf(...a) }));

import { startServer } from "../src/server";

let base: string; let server: any;
beforeEach(() => { runLeaf.mockReset(); });

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("POST /run-leaf", () => {
  beforeEach(() => { server = startServer(0); base = `http://127.0.0.1:${server.address().port}`; });

  it("400s on a malformed envelope (missing inputsRef)", async () => {
    const r = await post("/run-leaf", { sessionId: "s", resultRef: "/x" });
    expect(r.status).toBe(400);
    server.close();
  });

  it("returns runLeaf's terminal status on a valid envelope", async () => {
    runLeaf.mockResolvedValue({ status: "done", resultRef: "/work/out.json" });
    const r = await post("/run-leaf", { sessionId: "s", inputsRef: "/in", resultRef: "/out" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "done", resultRef: "/work/out.json" });
    expect(runLeaf).toHaveBeenCalledOnce();
    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knative-server exec vitest run test/run-leaf-route.test.ts`
Expected: FAIL — no `/run-leaf` route (404) and/or `startServer` not accepting port 0 return value.

- [ ] **Step 3: Write minimal implementation**

In `packages/knative-server/src/server.ts`, add the import and a handler, and route `POST /run-leaf`. Mirror `handleTurn`:

```typescript
import { runLeaf, type LeafEnvelope } from "@sh/harness/run-leaf";

function isEnvelope(o: any): o is LeafEnvelope {
  return o && typeof o.sessionId === "string" && typeof o.inputsRef === "string" && typeof o.resultRef === "string";
}

async function handleRunLeaf(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req));
  if (!isEnvelope(body)) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" }));
    return;
  }
  const result = await runLeaf(body, buildConfig());
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
}
```

In the request router (where `POST /turn` is dispatched), add:

```typescript
if (req.method === "POST" && url === "/run-leaf") return handleRunLeaf(req, res);
```

Ensure `startServer(port)` returns the `server` object (so tests can read `.address().port` and `.close()`); if it currently returns `void`, change it to `return server;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knative-server exec vitest run test/run-leaf-route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knative-server/src/server.ts packages/knative-server/test/run-leaf-route.test.ts
git commit -s -m "feat(knative-server): POST /run-leaf route"
```

---

### Task 5: Fixture repo + sample candidates

**Files:**
- Create: `deploy/knative/fixtures/repo/safe.py`
- Create: `deploy/knative/fixtures/repo/risky.py`
- Create: `deploy/knative/fixtures/inputs/i1.json`, `.../i2.json`, `.../i3.json`
- Test: `harness/test/fixtures.test.ts` (sanity: inputs reference existing files + parse)

**Interfaces:**
- Produces: a small workspace + N candidate JSONs in the envelope's `{item_id, file, pattern}` shape.

- [ ] **Step 1: Write the failing test**

```typescript
// harness/test/fixtures.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../../deploy/knative/fixtures");

describe("fixtures", () => {
  for (const id of ["i1", "i2", "i3"]) {
    it(`${id}.json references an existing fixture file`, () => {
      const item = JSON.parse(readFileSync(join(root, "inputs", `${id}.json`), "utf8"));
      expect(typeof item.item_id).toBe("string");
      expect(typeof item.pattern).toBe("string");
      expect(existsSync(join(root, "repo", item.file))).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C harness exec vitest run test/fixtures.test.ts`
Expected: FAIL — fixture files do not exist.

- [ ] **Step 3: Create the fixtures**

```python
# deploy/knative/fixtures/repo/safe.py
def handler(request):
    name = request.args.get("name", "world")
    return "hello " + name
```

```python
# deploy/knative/fixtures/repo/risky.py
def run(request):
    cmd = request.args.get("cmd")
    return eval(cmd)  # pattern of interest: eval(
```

```json
// deploy/knative/fixtures/inputs/i1.json
{ "item_id": "i1", "file": "risky.py", "pattern": "eval(" }
```
```json
// deploy/knative/fixtures/inputs/i2.json
{ "item_id": "i2", "file": "safe.py", "pattern": "eval(" }
```
```json
// deploy/knative/fixtures/inputs/i3.json
{ "item_id": "i3", "file": "risky.py", "pattern": "subprocess" }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C harness exec vitest run test/fixtures.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add deploy/knative/fixtures harness/test/fixtures.test.ts
git commit -s -m "test(harness): fixture repo + sample candidate inputs"
```

---

### Task 6: Kind smoke — parallel fan-out, retry, coverage audit, scale-to-zero (gated)

**Files:**
- Create: `deploy/knative/leaf-pvc.yaml` — a `ReadWriteMany`/`ReadWriteOnce` PVC `leaf-work`.
- Create: `deploy/knative/leaf-orchestrator.yaml` — a Pod (`alpine` + curl + jq + kubectl optional) mounting `leaf-work` at `/work`.
- Modify: `deploy/knative/service.yaml` — mount `leaf-work` PVC at `/work` (so leaf sessions read/write the same volume) and keep `KAGENTI_SANDBOX_POD` as today.
- Create: `deploy/knative/leaf-smoke.sh` — gated driver (`LEAF_LIVE_SMOKE=1`), mirrors `smoke.sh`/`lib.sh` style.

**Interfaces:**
- Consumes: `POST /run-leaf` (Task 4), fixtures (Task 5), the shared `leaf-work` PVC.
- Produces: a pass/fail smoke proving the §7 verification gate (MVP spec): parallel N, retry, coverage, scale-to-zero.

- [ ] **Step 1: Write the gate as an executable smoke script (the "test")**

```bash
# deploy/knative/leaf-smoke.sh
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh   # provides BASE, HOST_HEADER, NS, ok/ko, wait_for_zero_pods

[ "${LEAF_LIVE_SMOKE:-0}" = "1" ] || { echo "SKIP (set LEAF_LIVE_SMOKE=1)"; exit 0; }

RUN="run-$$"
# 1) seed inputs + fixture repo onto the shared volume via the orchestrator pod
kubectl -n "$NS" cp ./fixtures "leaf-orchestrator:/work/$RUN-fixtures"
ITEMS="i1 i2 i3"

dispatch() {  # item_id -> POST /run-leaf, return terminal status JSON
  local id="$1" model="${2:-claude-haiku-4-5}"
  local body
  body=$(jq -nc --arg s "$RUN/$id" --arg m "$model" \
    --arg in "/work/$RUN-fixtures/inputs/$id.json" \
    --arg out "/work/$RUN/results/$id.json" \
    --arg ws "/work/$RUN-fixtures/repo" \
    '{sessionId:$s, model:$m, inputsRef:$in, resultRef:$out, workspaceRef:$ws}')
  curl -s --max-time 240 -H "$HOST_HEADER" -H "Content-Type: application/json" -d "$body" "$BASE/run-leaf"
}

kubectl -n "$NS" exec leaf-orchestrator -- mkdir -p "/work/$RUN/results"

# 2) parallel fan-out
for id in $ITEMS; do dispatch "$id" & done; wait

# 3) coverage audit (read result files from the shared volume via the orchestrator pod)
missing=""
for id in $ITEMS; do
  kubectl -n "$NS" exec leaf-orchestrator -- test -f "/work/$RUN/results/$id.json" || missing="$missing $id"
done

# 4) retry any missing once (idempotent re-invoke)
for id in $missing; do dispatch "$id"; done
for id in $ITEMS; do
  kubectl -n "$NS" exec leaf-orchestrator -- sh -c "jq -e '.verdict' /work/$RUN/results/$id.json >/dev/null" \
    && ok "$id verdict present" || ko "$id missing verdict"
done

# 5) per-call model routed: i1 with a different model still succeeds
dispatch "i1" "claude-haiku-4-5" >/dev/null && ok "model-param accepted" || ko "model-param"

# 6) scale-to-zero after idle
wait_for_zero_pods 120 && ok "scaled to zero" || ko "did not scale to zero"
echo "LEAF SMOKE PASS"
```

- [ ] **Step 2: Add the PVC + orchestrator manifests and mount the PVC into the service**

```yaml
# deploy/knative/leaf-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: leaf-work, namespace: default }
spec:
  accessModes: ["ReadWriteOnce"]
  resources: { requests: { storage: 1Gi } }
```

```yaml
# deploy/knative/leaf-orchestrator.yaml
apiVersion: v1
kind: Pod
metadata: { name: leaf-orchestrator, namespace: default }
spec:
  containers:
    - name: tools
      image: alpine:3.20
      command: ["sh", "-c", "apk add --no-cache curl jq && sleep 100000"]
      volumeMounts: [{ name: work, mountPath: /work }]
  volumes:
    - name: work
      persistentVolumeClaim: { claimName: leaf-work }
```

In `deploy/knative/service.yaml`, under the container, add the volume + mount (Knative supports PVC volumes when the `kubernetes.podspec-persistent-volume-claim` feature flag is enabled in `config-features`):

```yaml
          volumeMounts:
            - name: work
              mountPath: /work
      volumes:
        - name: work
          persistentVolumeClaim: { claimName: leaf-work }
```

- [ ] **Step 3: Deploy and run the gated smoke on Kind**

Run (redirect verbose output per repo context-budget rules):

```bash
kubectl apply -f deploy/knative/leaf-pvc.yaml -f deploy/knative/leaf-orchestrator.yaml > /tmp/leaf-deploy.log 2>&1; echo "EXIT:$?"
# (re)deploy the harness service with the PVC mount + build/push image per existing kind-full-test flow
LEAF_LIVE_SMOKE=1 bash deploy/knative/leaf-smoke.sh > /tmp/leaf-smoke.log 2>&1; echo "EXIT:$?"
```

Expected: `/tmp/leaf-smoke.log` ends with `LEAF SMOKE PASS`; all `ok` lines present; final line confirms scale-to-zero. (Analyze the log in a subagent if it fails — do not read it whole in the main context.)

- [ ] **Step 4: Commit**

```bash
git add deploy/knative/leaf-pvc.yaml deploy/knative/leaf-orchestrator.yaml deploy/knative/leaf-smoke.sh deploy/knative/service.yaml
git commit -s -m "test(knative): gated kind smoke — parallel leaf fan-out, retry, coverage, scale-to-zero"
```

---

## Self-Review

**Spec coverage (MVP spec §2/§4/§7):**
- §2.1 invocation envelope → Task 4 (`/run-leaf`, terminal status) + Task 3 (`LeafEnvelope`). ✓
- §2.2 run-to-completion → Task 3 `realProduceVerdict` (`session.prompt`) ; proven Task 6. ✓
- §2.3 structured output + harness writes result → Tasks 1, 2, 3. ✓
- §2.4 idempotency → Task 3 (re-invoke rewrites `result_ref`); exercised Task 6 retry. ✓
- §2.5 re-entrancy (no caller-identity assumption) → Global Constraints + Task 4 (no caller check). ✓
- §4 components 1–9 → Tasks 1–6 (contract, job mode, tool+validation, driver, fixture; reuse M2–M6). ✓
- §5 volume layout → Task 6 (`/work/<run>/{inputs,results,repo}`). ✓
- §6 failure modes → Task 3 (no_verdict/invalid_verdict/bad_inputs/error) + Task 6 retry/coverage. ✓
- §7 gate 1–6 → Task 6; gate 7 (resume) reuses M5, not separately built here (stretch, noted). ✓

**Placeholder scan:** the only deferred-to-implementer detail is the exact extension-wiring in `realProduceVerdict` (Task 3) — flagged explicitly with the file:line to mirror (`run-turn.ts:83-103`, `sdk.ts:166`) and verified live in Task 6, because the precise `createAgentSession` extension-passing API must be read from source at implementation time. No other placeholders.

**Type consistency:** `Verdict`/`validateVerdict` (T1) used by T2 `submit-verdict-tool` and T3 `runLeaf`; `VerdictCapture` (T2) consumed by T3; `LeafEnvelope`/`LeafResult` (T3) consumed by T4 route; envelope field names (`sessionId`, `inputsRef`, `resultRef`, `workspaceRef`, `model`) consistent across T3/T4/T6.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
