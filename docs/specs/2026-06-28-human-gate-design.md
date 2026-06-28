# Human-Gate — "Gate-While-Idle" (Archetype B) — Design

Version: 1.0 — June 28, 2026
Status: Design (approved for implementation planning)
Scope: The **human-in-the-loop gate** primitive for the leaf-session backend — the last unbuilt
archetype. A single logical leaf session **pauses mid-pipeline awaiting an external human decision,
parks in durable state with the pod scaled to zero, and resumes with the decision injected**,
preserving full context across one or more gates before reaching a verdict. This is the canonical
**async + scale-to-zero + durable-resume** case (archetypes [§7.6](2026-06-26-pipeline-archetypes-requirements.md),
charter [§8.3](2026-06-26-leaf-session-backend-capability-charter.md)).
Realizes: [Archetypes & Requirements §7.6](2026-06-26-pipeline-archetypes-requirements.md) (gate primitive; gate-while-idle) + [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) G8 ("promote post-MVP: human-gate"). Single-tenant, key-in-env.
Builds on (reuse, no redesign): the leaf-session contract + `runLeaf` (MVP/PR #10), gate-7 durable
resume (PR #11), async leaf completion (`POST /run-leaf {async:true}` + `leaf-queue` + KEDA
`ScaledJob`, [async design](2026-06-27-async-leaf-completion-design.md)), M2/M3 sandbox, M4 Knative
scale-to-zero, M5 checkpoint/resume, M6 model selection.
Defers (per charter): auto-approve mode (§1, non-precluding); harness-side timeout/TTL (§5);
multi-tenancy & per-user identity (Z1), credential plane (Z3/Z5), event-driven gates (Archetype C).

> **One-line finding.** The gate is not new machinery — it is **a structured-output terminal plus a
> decision-seeded continuation**, both of which the substrate already does. A leaf reaching a gate
> ends a turn *well-formed* and parks (its session log is durable, the pod scales to zero); an
> external approver writes a decision file and re-invokes the same `sessionId`; `runLeaf` resumes
> from the log, applies the decision, and continues with full context. No always-on component, no Pi
> internals dependency, no change to any existing path.

---

## 1. Goal & scope

### Proves (the capability, end to end)

> A leaf session calls a `request_approval` tool, **pauses** with a structured summary on the
> orchestrator's volume, and the service **scales to zero** while parked; an **external** approver
> writes a decision (approve / reject / abort) and **re-invokes the same `sessionId`**; the session
> **resumes from durable state with full prior context**, applies the decision, and runs to a
> verdict — surviving multiple gates and mid-park crashes, **idempotently**.

### In scope

- A **`request_approval` structured-input tool** (job-mode), parallel to `submit_verdict`.
- A durable **gate-request** custom entry + a monotonic **`gateId`** per session.
- An **`awaiting_approval` gate marker** on the volume (parallel to the done-marker).
- A **`decisionRef`** decision-file contract (approve / reject / abort + optional feedback).
- A **resume state machine** in `runLeaf`: pending-gate detection, `gateId`-keyed idempotency,
  decision application, continuation-prompt seeding (approve/reject), abort.
- **Async + sync integration**: a `paused` `LeafResult`/marker that **acks** the queue (parked work),
  extended `classifyOutcome`.
- Unit tests + a gated **live gate** smoke (`leaf-gate-smoke.sh`).

### Out of scope (YAGNI / deferred)

- **Auto-approve mode** ([§7.6](2026-06-26-pipeline-archetypes-requirements.md) "auto-mode gated by
  safety preconditions"). The tool and envelope are shaped so an `autoApprove` policy can be added
  later (a flag that makes `request_approval` return `approved` inline without parking), but building
  the safety-precondition surface now is unneeded for the first slice. **Non-precluding, not built.**
- **Harness-side timeout / TTL** on a parked gate — the orchestrator owns deadlines (§5, Q4).
- Multi-tenancy, per-user identity (Z1), credential plane (Z3/Z5), event-driven gates (C).
- Any change to the synchronous `POST /run-leaf`, async enqueue, cron-dispatch, `leaf-queue`, the
  KEDA `ScaledJob`, or `submit_verdict` — all **unchanged**. A leaf that never calls
  `request_approval` behaves exactly as today.

### Design decisions (resolved with the stakeholder)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| B1 | Who decides **where** a gate happens | **Agent-declared** via a tool; **decision + resume external** (charter-aligned "Option C") | Builds the novel single-session pause/resume primitive while decision authority and re-invocation stay external (G1/G2). |
| B2 | How the agent **continues** after a decision | **Continuation prompt** (not tool-result injection) | Turn ends well-formed (no dangling tool call); reuses the proven seed-prompt + M5 resume path; survives mid-park crashes; no Pi-internals dependency. |
| B3 | **Decision transport** + resume trigger | **`decisionRef` file** on the volume; resume = **re-invoke `POST /run-leaf` by `sessionId`** (sync or `async:true`) | Symmetric with `inputsRef`/`resultRef`; keeps decision content off the HTTP channel (G3); no harness-side watcher (preserves scale-to-zero + G1/G2). |
| B4 | **Timeout** of a parked gate | **None in the harness**; park indefinitely | Charter §8.3 ("sleep indefinitely"); a timer/sweeper would reintroduce an always-on component. Deadlines are the orchestrator's concern (re-invoke with `abort`). |
| B5 | **Decision actions** | `approve` \| `reject` \| `abort` | Matches archetype B's approve / reject→loop / abort. |

---

## 2. The gate contract

### 2.1 `request_approval` tool (job-mode, alongside `submit_verdict`)

```
request_approval({
  summary:         string,   // what was done / decided so far (the human reads this)
  proposed_action: string    // what the agent intends to do next, pending sign-off
})
```

On call the harness:

1. Validates args (both non-empty strings); on mismatch → tool error back into the session (the
   agent can retry, exactly like `submit_verdict`).
2. Appends a durable **gate-request** custom entry: `{ gateId, summary, proposed_action }`, where
   `gateId` = the count of prior gate-request entries in this session (0, 1, 2, …).
3. Returns a **benign synchronous result**: *"Approval requested; the session will pause and resume
   with the human decision."* — so the assistant turn ends **well-formed** (no dangling `tool_use`;
   this is what makes resume robust, B2).

The tool sets a capture flag (`gateRequested`, with the new `gateId`) that `runLeaf` inspects after
the loop (§3). The agent is expected to stop after calling it; if it continues, the turn still ends
normally and `runLeaf` parks at the loop boundary.

### 2.2 `awaiting_approval` gate marker

Written **atomically** (temp + rename) to a derived `gateRef` (default `<resultRef>.gate`, override
via `envelope.gateRef`), on the **orchestrator-owned** volume:

```json
{
  "status": "awaiting_approval",
  "sessionId": "<sid>",
  "gateId": 0,
  "gate": { "summary": "…", "proposed_action": "…" },
  "ts": "<iso8601>"
}
```

The `gateRef` lives in the orchestrator's directory (charter G3) — the harness is **not** on the
approval critical path. The marker advertises the **current** `gateId` the approver must answer.

### 2.3 Decision file (`decisionRef`)

The external approver writes this file (on the volume) and then re-invokes (§2.5):

```json
{ "gateId": 0, "action": "approve" | "reject" | "abort", "feedback": "<optional>" }
```

- `gateId` **must** echo the marker's `gateId`; a decision whose `gateId` does not match the pending
  gate is **ignored** (§3, §5 — prevents a stale decision answering a later gate).
- `feedback` is used by `reject` (and may accompany `approve`); ignored by `abort`.

### 2.4 Envelope additions (optional, backward-compatible)

`LeafEnvelope` gains two optional fields; defaults preserve today's behavior exactly:

- `gateRef?: string` — override the derived gate-marker path (default `<resultRef>.gate`).
- `decisionRef?: string` — present on a **resume** invocation; the harness reads the decision here.
  Absent on the first (gating) invocation.

No other field changes. `async`, `doneMarkerRef`, `tenant`, `model`, `maxTurns`, etc. are untouched.

### 2.5 Resume trigger

Resume is an **ordinary re-invocation** of `POST /run-leaf` with the **same `sessionId`** plus
`decisionRef` (and `async` honored as usual):

```
POST /run-leaf { sessionId: "<same>", inputsRef, resultRef, decisionRef, workspaceRef?, model?, async? }
  → sync:  200 { status: "done" | "paused" | "aborted" | "failed", … }
  → async: 202 { status: "accepted", sessionId, resultRef, doneMarker }
```

No new endpoint, no watcher. The orchestrator/human is the caller (G1/G2).

### 2.6 `LeafResult` + marker status additions

- `LeafResult` gains:
  - `{ status: "paused"; gateRef: string; gateId: number }`
  - `{ status: "aborted" }`
- Marker `status` enums extend: the **gate marker** adds `awaiting_approval`; the **terminal**
  done-marker adds `aborted` (alongside `done | failed`). The two are distinct files (§4).

**`runLeaf` writes the gate marker.** In **both** sync and async modes, whenever a leaf parks,
`runLeaf` itself writes the `awaiting_approval` gate marker to `gateRef` — because the summary it
carries comes from the session log, which only `runLeaf` has (the queue runner sees only the
`LeafResult`). **Sync path:** the call returns promptly `200 { status: "paused", gateRef, gateId,
sessionId }` (gate marker already on the volume); the caller is **not** blocked and the pod scales to
zero. **Async path:** the leaf-job's `runLeaf` writes the gate marker, then `classifyOutcome` **acks**
the entry (§4).

---

## 3. The resume state machine (inside `runLeaf`)

A front-end runs on **every** invocation (fresh or resume), before the agent loop:

```
1. open session
     prior   = store.read(sid)
     resuming = prior.length > 0
     sm = resuming ? openFromCheckpoint(sid) : create(sid)

2. verdict fast-path (UNCHANGED, M5)
     if a verdict custom entry exists → recover it → return { status: "done" }

3. pending-gate detection
     pendingGate = the latest gate-request entry whose gateId has NO matching gate-decision entry
                   (null if none)

4. branch
   (a) pendingGate AND decisionRef provided AND decision.gateId == pendingGate.gateId:
         if a gate-decision entry for this gateId ALREADY exists:
             skip BOTH recording and re-seeding (idempotent — the decision was applied and the
             continuation turn is already durable in the log) → go (c)
         else (first application of this decision):
             action == "abort"   → append gate-decision entry {gateId, abort} → write `aborted`
                                    marker → return { status: "aborted" }   (no agent run)
             action == "approve" → append gate-decision entry + a DURABLE continuation user-turn:
                                    "Human decision: APPROVED. <feedback?> Proceed."
             action == "reject"  → append gate-decision entry + a DURABLE continuation user-turn:
                                    "Human decision: REJECTED: <feedback>. Revise; you may request
                                    approval again when ready."
         → run the agent loop (step 5)

   (b) pendingGate AND (no decisionRef OR decision.gateId != pendingGate.gateId):
         duplicate / early / stale resume → ensure the `awaiting_approval` marker is present →
         return { status: "paused", gateRef, gateId }   (NO agent run — idempotent no-op)

   (c) no pendingGate:
         fresh start    → seed the initial job-mode prompt (UNCHANGED)
         resumed-past   → the durable continuation turn (or initial prompt) is replayed by
                          openFromCheckpoint; just run the loop against the pending turn
         → run the agent loop (step 5)

5. after the loop (inspect capture flags)
     submit_verdict called    → write `done` marker, return { status: "done", resultRef }
     request_approval called  → write `awaiting_approval` marker (the new gateId), return
                                { status: "paused", gateRef, gateId }
     neither                  → return { status: "failed", reason: "no_verdict" }
```

**`gateId` is the idempotency spine.** A session may pass several gates; the marker advertises the
*current* `gateId` and the decision file must echo it. A resume applies a decision **only** when its
`gateId` matches the pending gate, so:

- a **stale/replayed** decision (answering an already-consumed gate) is **ignored**;
- a **double-resume** with the same decision is a **no-op continuation** (the gate-decision entry
  already exists → branch (a) "skip" → (c) continue from current state).

This is the gate analogue of the verdict fast-path: **durable custom entries make replay safe.**

### 3.1 Continuation seeding (B2 in practice)

On resume, `openFromCheckpoint` replays the full prior context (including the `request_approval`
exchange). The harness then appends a **new user turn** carrying the decision — the same mechanism
job-mode uses to seed its initial prompt. No `tool_use`/`tool_result` surgery; the transcript stays
well-formed across the park.

**Durability ordering (crash-mid-resume safety).** The gate-decision entry **and** the continuation
user-turn are both appended to the durable session log (through `BufferedRedisBackend`, flushed
before the agent loop starts its first model call). So if the pod crashes after the decision is
applied but before a verdict, the reclaim/re-invoke finds the gate already consumed (branch (a)
"skip") and the continuation turn already in the log, and simply **continues** (branch (c)) — the
decision is never applied or seeded twice. The gate-decision entry is the idempotency guard that
prevents a second continuation turn from being appended on redelivery.

---

## 4. Async integration (`classifyOutcome` + KEDA)

**Two marker kinds, two writers.** The async substrate already has a *terminal* done-marker at
`<resultRef>.status` written by the **queue runner** (via `classifyOutcome.marker`), absent in sync
mode (the HTTP response conveys the terminal status). The gate adds a distinct *non-terminal* **gate
marker** at `gateRef` (`<resultRef>.gate`) that carries the session-derived summary — so **`runLeaf`
writes it directly, in both sync and async modes** (the queue runner only has the `LeafResult`, not
the summary). `classifyOutcome` therefore returns **no terminal marker** for `paused` (runLeaf
already wrote the gate marker); it only decides the ack:

| `runLeaf` outcome | gate marker (`gateRef`, by `runLeaf`) | terminal marker (`<resultRef>.status`, by runner/async) | queue action | rationale |
|---|---|---|---|---|
| `done` | — | `done` | **XACK** | success (unchanged) |
| **`paused`** | **`awaiting_approval`** (written by `runLeaf`) | — (none; not terminal) | **XACK** | parked; resume is a *new* invocation, not a redelivery |
| **`aborted`** | — | **`aborted`** | **XACK** | terminal by human decision |
| `failed: bad_inputs \| no_verdict \| invalid_verdict` | — | `failed` | **XACK** | deterministic (unchanged) |
| `failed: error` | — | none | **no ack → reclaim** | transient (unchanged) |
| process **crash** | — | none | **no ack → reclaim → gate-7 resume** | unchanged |

So `classifyOutcome`'s new branches are: `paused` → `{ ack: true, marker: null }`; `aborted` →
`{ ack: true, marker: { status: "aborted" } }`. The resume invocation is an ordinary sync POST or
async enqueue with the same `sessionId` + `decisionRef`. On the async path it `XADD`s a fresh entry
→ KEDA spawns a leaf-job → `runLeaf` resumes from the log, applies the decision, continues.
**Nothing** in the `WorkQueue`, `ScaledJob`, heartbeat, or dead-letter machinery changes.

> **Status endpoint visibility.** `GET /run-leaf/status` is extended so that, when no terminal
> marker is present, it also checks the sibling gate marker and reports `awaiting_approval` (with
> `gateId`) instead of defaulting to `queued`. The **primary** completion signal stays the
> orchestrator polling the gate / terminal markers on its own volume (G3); the endpoint is the
> secondary convenience path (async §3.4).

> **Marker overwrite across gates.** A second gate in the same session overwrites the
> `awaiting_approval` gate marker with the new `gateId`. The orchestrator detects a *new* gate by the
> changed `gateId` (and, if it wants history, can snapshot markers — its concern, G3).

---

## 5. Failure modes, idempotency, timeout

- **Crash while parked, before the gate marker is written:** the gate-request entry is already
  durable, so on reclaim/re-invoke `runLeaf` detects the pending gate and (no `decisionRef` yet)
  takes branch (b) — **writes the missing `awaiting_approval` marker without re-running the agent**
  and returns `paused`. The `gateId` is unchanged (derived from the durable entry). (Sync caller sees
  a connection drop → re-invokes → same result. Async: entry unacked → reclaimed.)
- **Crash mid-resume (decision recorded, no verdict yet):** the gate-decision entry is durable →
  reclaim/re-invoke resumes **past** the gate (branch (a) "skip" → (c) continue) → runs to verdict.
  No re-prompt, no double-apply.
- **Double / conflicting decision (approve-then-reject):** the **first** matching-`gateId` decision
  is recorded durably and wins; later decisions for a consumed `gateId` are ignored. If two decision
  files race **before** any resume reads one, last-writer-on-the-file wins — documented; the
  orchestrator owns not racing itself (it is the single approving authority, G1/G2).
- **Stale decision applied to a new gate:** prevented by `gateId` matching (§3).
- **`decisionRef` missing/garbled on resume:** treated as "no decision" → branch (b) → stays
  `paused` (no agent run). Safe no-op; the approver re-writes and re-invokes.
- **Timeout:** **none in the harness** (B4). A parked session waits indefinitely; the orchestrator
  enforces deadlines by re-invoking with `abort`. *(Non-precluding future: an envelope `gateTTL` +
  a KEDA-cron sweeper that writes `aborted` markers — not built; see §7.)*
- **Re-entrancy preserved:** the gate adds no caller-identity assumption, so a child leaf could
  itself gate. Non-precluding, untested (consistent with MVP §2.5).

**Effectively-once outcome:** at-least-once delivery × idempotent `runLeaf` (durable gate-request /
gate-decision / verdict entries + overwrite) = the same terminal state regardless of redelivery or
double-resume.

---

## 6. Components

| # | Unit | Responsibility | Lives in | New / reuse |
|---|---|---|---|---|
| 1 | `request_approval` tool | validate → append gate-request entry → benign result; set capture flag | `harness/src/request-approval-tool.ts` | ⭐ new |
| 2 | gate types + validation | `GateRequest`, `Decision`, `validateDecision`, `gateId` derivation | `harness/src/gate.ts` | ⭐ new |
| 3 | gate marker I/O | atomic write/read of the `awaiting_approval` gate marker; `deriveGateRef` (`<resultRef>.gate`) | `harness/src/gate-marker.ts` (mirrors `done-marker.ts`) | ⭐ new |
| 4 | resume state machine | pending-gate detection, decision application, continuation seeding, abort, **gate-marker write on park** | extend `harness/src/run-leaf.ts` | ⭐ new front-end; loop reused |
| 5 | `LeafResult` + envelope additions | `paused`/`aborted`; `gateRef`/`decisionRef` | extend `harness/src/run-leaf.ts` | ⭐ new fields |
| 6 | `classifyOutcome` | `paused`→`{ack:true, marker:null}` (gate marker already written by `runLeaf`); `aborted`→`{ack:true, marker:aborted}` | extend `harness/src/classify-outcome.ts` | ⭐ new branches |
| 7 | server handlers | serialize `paused`/`aborted` on sync `200`; `decisionRef`/`gateRef` through `isLeafEnvelope`; status endpoint reports `awaiting_approval` from the gate marker | `packages/knative-server/src/server.ts` | ♻️ minimal |
| 8 | leaf-job runner | unchanged loop; new outcomes ack via `classifyOutcome` | `harness/src/leaf-job-runner.ts` | ♻️ unchanged |
| 9 | session durability / resume | gate entries through `BufferedRedisBackend`; `openFromCheckpoint` | M1/M5 | ♻️ reuse |
| 10 | live gate smoke | `GATE_LIVE_SMOKE=1` end-to-end on Kind | `deploy/knative/leaf-gate-smoke.sh` | ⭐ new |
| 11 | fixture gating prompt | a prompt that requests approval once before verdict | test fixtures | ⭐ new (small) |

---

## 7. Testing & verification gate

### 7.1 Unit (vitest, fast — pure / injected fakes)

| Unit | Coverage |
|---|---|
| `request_approval` tool | valid args → gate-request entry with correct `gateId` + benign result; invalid (empty `summary`/`proposed_action`) → tool error, no entry. |
| gate types | `validateDecision` accepts `approve`/`reject`/`abort` + optional feedback; rejects bad action / missing `gateId`. |
| gate marker I/O | atomic temp+rename for the `awaiting_approval` gate marker; `deriveGateRef` default (`<resultRef>.gate`) + override. |
| resume state machine (injected store / loop / clock) | pending-gate detection; **approve**→durable gate-decision entry + continuation seed + run + gate-marker on a follow-on gate; **reject**→feedback seed + run; **abort**→aborted (terminal), **no** agent run; **gateId mismatch**→ignored (stays paused); **duplicate decision**→no-op continuation (no second seed); **no decisionRef**→paused; **fresh**→initial seed. |
| `classifyOutcome` | `paused`→`{ack:true, marker:null}`; `aborted`→`{ack:true, marker:aborted}`; existing rows unchanged (regression). |
| multi-gate sequence | gate#0 → approve → gate#1 → approve → verdict, single `sessionId`, correct `gateId` progression. |
| server | `paused`/`aborted` serialize correctly on sync `200`; `decisionRef` passes through `isLeafEnvelope`; async-omitted path unchanged (regression). |

Redis-backed assertions are **gated** like existing `redis-backend` tests (skip when no `REDIS_URL`).

### 7.2 Live gate — `deploy/knative/leaf-gate-smoke.sh` (gated `GATE_LIVE_SMOKE=1`)

On the Kind `sh-knative` cluster (async path already deployed: KEDA + `ScaledJob`, Redis, sandbox-0,
`/work` PVC, ksvc). A fixture prompt deterministically requests approval once before its verdict.
**The controller runs this live gate directly — never a subagent.**

1. **Pause:** dispatch a gated leaf → `awaiting_approval` marker appears on `/work` with `gateId:0`
   + summary; **no** `result_ref`; session parked.
2. **Scale-to-zero while parked:** with the gate pending and no other work, leaf-job pods reach
   **zero** (KEDA acked the parked entry).
3. **Resume-approve:** write `decisionRef {gateId:0, approve}` → re-invoke same `sessionId` → leaf
   resumes, runs to **verdict** → `done` marker + correct verdict.
4. **Resume-reject-then-approve:** reject with feedback → agent revises, gates again (`gateId:1`) →
   approve → completes with verdict.
5. **Abort:** write `{abort}` → `aborted` marker, **no** verdict, entry acked.
6. **Idempotent resume:** re-invoke with an already-consumed decision (and a stale `gateId`) → **no**
   duplicate continuation; terminal state stable.

`setup-kind.sh` needs **nothing new** (no new cluster prereq — gate reuses the async path). Verbose
`kubectl`/build output redirects to `/tmp/kagenti/human-gate/` logs, analyzed in subagents
(CLAUDE.md context budget).

---

## 8. Scope / YAGNI — explicitly NOT building

- **Auto-approve mode** (the safety-precondition surface) — shaped-for, not built (§1).
- **Harness-side timeout / TTL** + any sweeper — orchestrator owns deadlines (§5).
- **Tool-result injection** resume style (B2 chose continuation-prompt).
- **Harness-side decision watcher / auto-resume** — resume is an external re-invocation (B3).
- Multi-tenancy, per-user identity (Z1), credential plane (Z3/Z5), event-driven gates (C).
- Any change to sync `POST /run-leaf`, async enqueue, cron-dispatch, `leaf-queue`, the KEDA
  `ScaledJob`, `submit_verdict`, or the heartbeat/dead-letter machinery — all **unchanged**.
- A new container image — the gate reuses the harness image and existing entrypoints.

**Substrate-agnostic seam:** the gate *contract* (gate tool → `awaiting_approval` marker → external
`decisionRef` → re-invoke-by-`sessionId` → continuation) depends only on `runLeaf`'s durable session
log + the marker convention, **not** on KEDA or Knative. A KEDA-less or always-on deployment drives
the identical contract.

---

## 9. Cluster prerequisites

- Everything the async path already needs (KEDA, `leaf-queue`/group, the `leaf-work` `/work` PVC,
  `sandbox-0`, `llm-credentials`, the Knative service). **No new prerequisite.**
- The new `deploy/knative/leaf-gate-smoke.sh` is a test script, not a deployed component.

---

## 10. References

- [Archetypes & Requirements](2026-06-26-pipeline-archetypes-requirements.md) — §3 (Archetype B), §7.6 (human-in-the-loop: gate primitive, auto-mode, gate-while-idle).
- [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) — G1/G2 (harness invoked, not orchestrator), G3 (orchestrator owns the store), G8 (promote human-gate post-MVP), §8.3 (human-gate vs scale-to-zero).
- [MVP Thin Slice](2026-06-26-mvp-leaf-session-contract-design.md) — §2.4 idempotency (new `sessionId` = fresh run), §2.5 re-entrancy, the `submit_verdict` pattern this mirrors.
- [Async Leaf Completion](2026-06-27-async-leaf-completion-design.md) — the queue / done-marker / KEDA / `classifyOutcome` substrate this extends; §3.5 idempotency & delivery semantics.
- [Scheduled Leaf Dispatch](2026-06-28-scheduled-leaf-dispatch-design.md) — sibling reuse of the async contract; idempotency-by-`sessionId`.
- [Milestone Registry](README.md) — Phase-1/Phase-2 numbering.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
