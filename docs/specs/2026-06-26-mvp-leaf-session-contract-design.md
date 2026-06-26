# MVP Thin Slice — Leaf-Session Invocation Contract (Archetype A)

Version: 1.0 — June 26, 2026
Status: Design (approved for implementation planning) — **the first buildable milestone**
Scope: The thinnest vertical slice that proves the harness can serve as a **leaf-session backend
for an external deterministic orchestrator**, using the parallel-fan-out archetype (A). It proves
the **leaf-session invocation contract** — parameterized, run-to-completion, structured-output,
workspace-isolated, on scale-to-zero infra — and nothing domain-specific.
Realizes: [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) §5 (MVP core)
+ §7 (G1, G6). Single-tenant, key-in-env.
Builds on (reuse, no new design): M2/M3 (sandbox), M4 (Knative scale-to-zero), M5 (checkpoint/resume), M6 (runtime model selection).
Defers (per charter): Z1 identity, Z3 injector, Z5 egress, Z6 subagents; human-gates; triggers; real candidate-generation and PoC/exploit stages.

> **What this slice is NOT.** It is not the real analysis pipeline. The agentic task is a
> representative **stub** (flag a pattern in a file) so the slice measures *the contract and the
> integration seam*, not domain logic. The real candidate-generation and validation stages plug into
> the same contract later.

---

## 1. Goal & scope

### Proves (the contract, end to end)

> An **external** deterministic orchestrator dispatches **N parallel, parameterized leaf-session
> invocations**; each runs **to completion** in a tooled sandbox with an **isolated, read-only
> workspace** and a **per-call model**, emits a **schema-validated structured result** via the
> volume envelope; the orchestrator **collects all N, retries a failure, and audits coverage** — and
> the service **scales to zero** when idle.

### In scope

- The **leaf-session invocation contract** (§2): envelope, run-to-completion semantics, structured
  output, volume-based result delivery.
- A harness **job-mode entrypoint** (run agent autonomously to a verdict).
- A **`submit_verdict` structured-output tool** + schema validation at the harness boundary.
- A **minimal external orchestrator driver** (stand-in): fan-out, collect, retry, coverage audit.
- A small **fixture repo** + a generic verdict schema.

### Out of scope

- Real candidate generation (stage 1) and PoC/exploit validation (stage 3); rule engines; batching
  sophistication.
- Per-user identity (Z1), provider-key injector (Z3 — key in env), credentialed egress (Z5).
- Human-gate and trigger/cron primitives.
- CoW/worktree workspace seeding (workspace = a read-only mount in this slice).
- Async completion signalling (this slice blocks per invocation; async is the scale extension §9).

---

## 2. The leaf-session invocation contract

### 2.1 Invocation envelope

The orchestrator invokes one leaf session per work item (HTTP request to the harness Knative
endpoint):

```
POST /run-leaf
{
  "session_id":   "<run_id>/<item_id>",   // unique; idempotency key
  "model":        "<provider/model>",     // per-call tier (M6)
  "inputs_ref":   "/work/<run_id>/inputs/<item_id>.json",   // shared volume
  "result_ref":   "/work/<run_id>/results/<item_id>.json",  // shared volume
  "workspace_ref":"/work/<run_id>/repo",  // read-only target/fixture repo
  "max_turns":    <int>                   // run-to-completion bound
}
→ 200 { "status": "done",   "result_ref": "..." }     // verdict written to result_ref
→ 200 { "status": "failed", "reason": "no_verdict|invalid_verdict|timeout|error" }
```

The response is a **terminal status only** — the **verdict travels via `result_ref`**, not the HTTP
body (charter G3: don't put domain artifacts in the harness's channel; keeps the body tiny). The
request **blocks until the session reaches a terminal state**; the orchestrator then reads
`result_ref`. (Async completion is the scale extension, §9.)

### 2.2 Run-to-completion ("job mode")

Distinct from the interactive `runTurn`: the harness seeds the agent with a fixed prompt —
*"process the item in `inputs_ref` against the repo at `workspace_ref`; emit your verdict by calling
`submit_verdict`"* — and runs the agent loop **autonomously to completion** (until `submit_verdict`
is called, or `max_turns`/timeout). Reuses `runTurn` internals; adds the completion loop.

### 2.3 Structured output (the verdict)

The agent emits its result **only** by calling a harness-registered **`submit_verdict` tool** whose
args must match the schema:

```
verdict = {
  "item_id":  string,
  "verdict":  "FLAGGED" | "CLEAR",
  "reason":   string
}
```

The **harness** validates the tool args against the schema and **writes `result_ref`** (trusted
code writes the result, not model-authored code — the workspace mount is read-only to the agent).
On schema mismatch the tool errors back into the session so the agent can retry; if the session ends
with no valid `submit_verdict`, the invocation is `failed`.

### 2.4 Idempotency

`session_id` is the idempotency key. Re-invoking with the same `session_id`/`result_ref` re-runs and
overwrites — so **retry = re-invoke**. The harness writes `result_ref` fresh each run.

---

## 3. Architecture & request path

```
external orchestrator driver (deterministic; brings its own logic)
  │  for each of N items: POST /run-leaf {session_id, model, inputs_ref, result_ref, workspace_ref}
  ▼  (N concurrent requests)
Knative harness service  ── scales out to N pods, scales to zero when idle (M4)
  │  job-mode: seed prompt → run agent to completion (M6 model) 
  ▼
sandbox (M2/M3): read workspace_ref (RO), use tools (read/grep), reason with model
  │  agent calls submit_verdict(args)
  ▼
harness validates args vs schema → writes result_ref on the shared volume → returns terminal status
  │
  ▼
orchestrator: read all result_refs → retry any failed/missing (re-invoke) → coverage audit (all N valid)
```

---

## 4. Components

| # | Component | New / reuse |
|---|---|---|
| 1 | **Invocation contract + `/run-leaf` endpoint** | ⭐ new (the core) |
| 2 | **Job-mode completion loop** (autonomous run to verdict) | ⭐ new (wraps `runTurn`) |
| 3 | **`submit_verdict` tool + schema validation + result_ref write** | ⭐ new |
| 4 | **Minimal orchestrator driver** (fan-out / collect / retry / coverage audit) | ⭐ new (test stand-in) |
| 5 | **Fixture repo + verdict schema** | ⭐ new (small) |
| 6 | Sandbox tool execution | ♻️ M2/M3 |
| 7 | Knative parallel + scale-to-zero | ♻️ M4 |
| 8 | Per-call model selection | ♻️ M6 |
| 9 | Checkpoint/resume (verify a restarted session resumes) | ♻️ M5 |

---

## 5. Volume layout (the minimal envelope)

```
/work/<run_id>/
  repo/                     # read-only workspace (fixture repo) — workspace_ref
  inputs/<item_id>.json     # { item_id, file, pattern }            — inputs_ref
  results/<item_id>.json    # { item_id, verdict, reason }  (written by harness) — result_ref
```

A single shared volume (PVC). The harness mounts `repo/` read-only into the sandbox; reads
`inputs_ref`; writes `results/<item_id>.json`. The orchestrator owns the directory and reads results
— **the harness does not own the domain store** (charter G3).

---

## 6. Failure modes & retry

- **No verdict** (agent ended without `submit_verdict`) → `failed: no_verdict` → orchestrator
  re-invokes.
- **Invalid verdict** (schema mismatch) → tool errors back into the session (in-session retry); if
  still unresolved at session end → `failed: invalid_verdict`.
- **Timeout / max_turns** → `failed: timeout` → orchestrator re-invokes (idempotent).
- **Pod crash / no result_ref** → orchestrator detects missing result on collect → re-invokes.
- **Coverage audit** → orchestrator asserts every item has a valid `result_ref`; any gap is retried
  (bounded) then reported. This is the slice's analogue of the archetype's completion audit.

---

## 7. Verification gate

The slice passes when, on a Kind cluster with the harness deployed as a Knative service + a shared
PVC + the fixture repo:

1. **Fan-out:** the driver dispatches N (e.g. 10) items; **N leaf sessions run in parallel** (Knative
   scales out) and each writes a schema-valid `result_ref`.
2. **Parameterized model:** items dispatched with a different `model` value demonstrably route to
   that model (observable in the session/inference path).
3. **Structured output enforced:** a session whose agent fails to call `submit_verdict` (or emits an
   off-schema arg) ends `failed` and writes **no** invalid `result_ref`.
4. **Retry:** one induced failure (e.g. a forced bad item) is **re-invoked and succeeds**;
   idempotency holds (same `session_id`/`result_ref`).
5. **Coverage audit:** after collection + retries, the driver confirms **all N items have a valid
   verdict**.
6. **Scale-to-zero:** with no work in flight, the harness service **scales to zero**; a new dispatch
   cold-starts it.
7. **(Stretch) Resume:** a leaf session killed mid-run **resumes via checkpoint** (M5) and still
   produces its verdict.

---

## 8. What this buys / honest notes

- It establishes the **reusable seam**: any external orchestrator (the real pipeline's, a state
  machine, a cron driver) can target `/run-leaf`. The real analysis stages plug into the same
  contract by changing only the seed prompt + schema + sandbox tooling.
- **Honest:** for the bare slice, the harness's edge over running workers as plain K8s Jobs is
  incremental (turn-level durability, the brain/hands split, the on-ramp to later hardening). The
  slice's value is proving the **contract**, not out-performing a Job.
- The **stub task** deliberately under-tests sandbox tooling depth; adopting the real tooled image is
  a follow-on, not part of proving the contract.

---

## 9. Open questions / next increments

1. **Async completion.** This slice blocks per invocation (fine for short tasks). Real multi-minute
   work wants **async**: invoke returns immediately, the session writes `result_ref` + a done-marker,
   the orchestrator polls/!is-notified. Natural fit for scale-to-zero + durable resume; design when
   tasks get long.
2. **Adopt the real tooled sandbox image** + a real candidate schema (still domain-generic).
3. **Workspace seeding** beyond a read-only mount (CoW/worktree) when workers must mutate.
4. **Promote** the human-gate and trigger primitives (Archetypes B/C) once the contract is proven.

---

## 10. References

- [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) — §5 MVP core, §7 G1/G3/G6 this slice realizes; §8 open questions it answers (Archetype A, volume envelope).
- [Milestone Registry](README.md).
- Built base reused: [M2](2026-06-17-m2-k8s-sandbox-client-design.md) / [M3](2026-06-17-m3-persistent-channel-design.md) / [M4](2026-06-17-m4-knative-serverless-wrapper-design.md) / [M5](2026-06-23-m5-compaction-checkpoint-design.md) / [M6](2026-06-24-m6-experiments-design.md).

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
