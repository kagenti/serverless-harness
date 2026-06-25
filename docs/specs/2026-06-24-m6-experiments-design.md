# M6 Design: Experiments E2 + E5

Version: 1.0 — June 24, 2026
Status: Design (approved for implementation planning)
Scope: Turn the M5 loader (`openFromCheckpoint`) and budget voter into reproducible,
asserted experiments — **E2** (local reconstruction cost) and **E5** (budget enforcement) —
in a new in-process TypeScript `experiments/` workspace.

Parent plan: [Serverless Harness (Pi Track) Implementation Plan](../../../docs/research/2026-06-10-serverless-harness-pi-track-plan.md) — experiments **E2** (Task 18) and **E5** (Task 21).
Predecessor: [M5 Design — Compaction-Checkpoint Fast Path + Budget Voter](2026-06-23-m5-compaction-checkpoint-design.md) (merged to `main`, PR #2 / `8083a27`).

> **Milestone numbering.** Following the repo convention (sequential, offset from the pi-track
> plan), this is **repo milestone M6**. It consumes what M5 built: E2 measures the
> `SessionManager.openFromCheckpoint` vs `openFromBackend` loaders; E5 drives the budget voter
> (`harness/src/budget-voter.ts`). The pi-track plan's literal E2/E5 drivers (Python, HTTP
> against a deployed Knative service, an `everyK` cadence knob) do **not** apply — see §1 and §6.

---

## 1. Goal & scope

M5 shipped two mechanisms but exercised neither beyond unit/parity tests:

1. `SessionManager.openFromCheckpoint()` — reads only the latest-compaction-forward slice, making
   cold-start local reconstruction O(tail) rather than O(total entries).
2. The budget voter — blocks a tool call and appends one `abort` once per-turn spend exceeds
   `SH_BUDGET_TOKENS`.

M6 turns each into a **reproducible experiment with a clear pass criterion**:

- **E2 — reconstruction cost.** Quantify the loader's win as the **Redis read volume** consumed
  during reconstruction (`openFromCheckpoint` vs `openFromBackend`) at increasing session lengths.
- **E5 — budget enforcement.** Prove the voter blocks a tool call and records exactly one `abort`
  past the cap, and is inert when the cap is unset.

M6 is **done** when:

1. E2 reports, across session lengths N ∈ {50, 200, 1000, 5000}, that `openFromCheckpoint`
   reconstruction reads a near-constant number of entries/bytes (bounded by the kept tail) while
   `openFromBackend` grows linearly with N — i.e. the `backend / checkpoint` read ratio strictly
   increases with N — and that both reconstruct an identical `buildSessionContext()`.
2. E5 (structural, no key, real Redis) blocks a tool call and appends **exactly one** `abort`
   entry to the Redis log when spend exceeds the cap, and produces **no** block and **no** `abort`
   when `SH_BUDGET_TOKENS` is unset.
3. E5 (live, key-gated) drives a real model past a tiny cap and observes the same block + single
   `abort` end-to-end; it skips cleanly with no key.
4. The model and provider are runtime inputs (no hardcoded model id in the production turn path,
   no secrets in the repo); E2 and E5-structural run with **no LLM key**.
5. All existing suites (harness, session-backend, k8s-sandbox) stay green; **pi-fork is
   untouched**.

### 1.1 Honest framing (inherited from M5 §1/§8)

The pi-track plan's E2 measured *end-to-end cold-start latency* (message → first token) under an
`everyK` checkpoint cadence. M5 §1 established this is the wrong instrument: Pi's native
compaction already bounds the LLM context (`buildSessionContext()` assembles only
`[summary, …kept tail, …post-compaction]`), so end-to-end latency is dominated by an
already-bounded LLM call and would show **"no effect."** The loader's real, measurable win is
**local**: the Redis read, `_buildIndex`, and the leaf→root walk. M6/E2 measures *that*, directly
and deterministically, without an LLM. The `everyK` knob does not exist (we ride Pi's native
compaction cadence — M5 D5), so it plays no part here.

### 1.2 In scope

- A new `experiments/` pnpm workspace (`@sh/experiments`), vitest-based, in-process.
- A counting `SessionStorageBackend` decorator that tallies read entries + bytes.
- A synthetic session fixture builder (length-N session that compacted once), reusing the M5
  `checkpoint.test.ts` technique.
- E2 measurement spec (no key) + results reporting to `experiments/RESULTS.md`.
- E5 structural spec (no key, real Redis) + E5 live spec (key-gated).
- One production change: make model + provider runtime inputs in `harness/src/run-turn.ts`.

### 1.3 Out of scope

- **End-to-end LLM-latency measurement** (the misleading metric — §1.1).
- **`everyK` / forced-checkpoint cadence** (deferred in M5; ride native compaction).
- **Cross-turn / cumulative budget ledger** (deferred in M5).
- **Knative/HTTP-driven experiments and a Kind cluster.** M6 is in-process + local Redis only.
- **E1, E3, E4** — these are end-to-end *cluster* experiments; see §8.1.
- **The pi-track plan's Python `experiments/` drivers** — re-targeted to in-process TS.

---

## 2. Discovery findings (the design rests on these)

| # | Finding | Evidence |
|---|---------|----------|
| F1 | M5 is merged to `main`: `openFromCheckpoint` + `markerResumePosition` (pi-fork), `RedisSessionBackend` deterministic stream ids + `positionOfId`, `checkpoint-extension.ts`, `budget-voter.ts`, wired in `run-turn.ts`. | `8083a27` (PR #2); `run-turn.ts:48` calls `openFromCheckpoint`. |
| F2 | Both loaders accept an injected `backend: SessionStorageBackend` and call `backend.read(...)`. `openFromBackend` reads **all** entries; `openFromCheckpoint` reads only `marker.resumeFromPosition`-forward. ⇒ wrapping the injected backend captures the read-volume difference with no fork change. | `session-manager.ts:1430` (`openFromBackend`), `:1457` (`openFromCheckpoint`). |
| F3 | `SessionStorageBackend` is a 4-method interface: `append`, `read(sid, fromPosition?)`, `latestCheckpoint(sid)`, `list()`. A decorator is small. | `core/session-storage-backend.ts:14–22`. |
| F4 | The M5 `checkpoint.test.ts` builds a real compacted session in Redis (append entries → `appendCompaction` → checkpoint marker) and asserts `openFromCheckpoint` parity vs `openFromBackend`. This is the template for the E2 synthetic fixture. | `harness/test/checkpoint.test.ts` (M5). |
| F5 | The budget voter meters per-turn spend = `sessionSpendTotal(ctx) − baseline` (baseline captured at `session_start`); on `tool_call` it blocks and appends one `abort` via `sm.appendCustomEntry("abort", …)`. `sessionSpendTotal` reads `ctx.sessionManager.getBranch()` assistant `usage`. Returns `0` for an empty branch, `null` only when the branch is unavailable (a missing/`null` reading ⇒ do not block). | `harness/src/budget-voter.ts` (M5). |
| F6 | The production turn path hardcodes the model: `getModel("anthropic", "claude-opus-4-8")`. Credentials already flow via `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` (+ optional `anthropicAuthToken`/`anthropicBaseUrl` on `TurnConfig`); the gateway path overrides `baseUrl` and injects `Authorization: Bearer` while nulling `x-api-key`. | `run-turn.ts:78`, `:39–42`, `:79–95`. |
| F7 | `pnpm-workspace.yaml` declares `packages/*` and `harness`. A new top-level `experiments` dir must be added to the workspace globs. | `pnpm-workspace.yaml`. |

---

## 3. Key decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | E2 session generation | **Synthetic, no LLM.** Programmatically append realistic `FileEntry` logs + a real `compaction` entry + a `checkpoint` marker to real Redis (per F4). Deterministic, scales to any N cheaply, reproducible, needs no key. A live model is needed only by E5. |
| D2 | E2 headline metric | **Entries read + bytes read** from Redis during reconstruction, via a counting backend decorator (no pi-fork change). #entries loaded is the common driver of the Redis read **and** `_buildIndex` **and** the leaf→root walk, so it faithfully proxies all three local costs. Wall-clock reconstruction time is a **secondary, illustrative** column. |
| D3 | E2 pass criterion | The `backend / checkpoint` read ratio **strictly increases with N** (checkpoint near-constant, backend linear). Concretely: assert the ratio at N=5000 is materially greater than at N=50 (and monotonic non-decreasing across the N series, within a small tolerance). Plus a `buildSessionContext()` parity re-confirmation. |
| D4 | E5 structural gate | **No key, real Redis.** Inject a synthetic over-cap spend at the voter/extension boundary; assert tool_call blocked **and** exactly one `abort` entry actually persisted in the Redis log; assert inert (no block, no `abort`) when `SH_BUDGET_TOKENS` unset. This is the M6 pass gate for E5. |
| D5 | E5 live run | **Key-gated, tiny cap.** `SH_BUDGET_TOKENS=1` + a prompt that forces a tool call ⇒ the first post-baseline `tool_call` deterministically trips the cap. Assert block + exactly one `abort` in Redis. Skips cleanly when `SH_RUN_LIVE`/key absent. |
| D6 | Experiment placement | **New `experiments/` pnpm workspace**, vitest, in-process. Mirrors the parent plan's `experiments/` intent in TypeScript. E2 + E5-structural always run (no key); E5-live is gated. |
| D7 | Model as runtime input | Env + config, defaults preserved: `getModel(provider, modelId)` where `provider = config?.provider ?? SH_MODEL_PROVIDER ?? "anthropic"` and `modelId = config?.model ?? SH_MODEL ?? "claude-opus-4-8"`. `TurnConfig` gains optional `model?` / `provider?`. No secrets in repo. |
| D8 | Provider scope | `SH_MODEL_PROVIDER` is **forward-looking** and exercised here only as `anthropic` (directly or via the litellm gateway through `ANTHROPIC_BASE_URL`). The auth-header injection (F6) is anthropic/gateway-shaped; a genuinely different provider would need its own key handling — documented limitation, not implemented. |
| D9 | Milestone scope | **One milestone, one branch** (`feat/m6-experiments`). E2 and E5 are independent experiments but small and share the workspace + model/credential config + real-Redis setup + reporting. No pi-fork edits ⇒ **no submodule branch**. |

---

## 4. Architecture

```
┌──────────────────────────── E2: reconstruction cost (no LLM) ───────────────┐
│ experiments/src/session-fixture.ts                                          │
│   buildCompactedSession(redis, sid, N)  → length-N log in Redis,            │
│     compacted once (fixed kept tail) + checkpoint marker     (per F4)       │
│ experiments/src/counting-backend.ts                                         │
│   CountingBackend implements SessionStorageBackend (F3):                    │
│     read(): delegate; tally entries.length + Σ bytes(JSON(entry))           │
│ experiments/test/e2-reconstruction-cost.test.ts                             │
│   for N in {50,200,1000,5000}:                                              │
│     reset counters; openFromBackend(sid, counting)   → record entries/bytes │
│     reset counters; openFromCheckpoint(sid, counting)→ record entries/bytes │
│     assert buildSessionContext() parity                                     │
│   assert ratio(backend/checkpoint) increases with N  → RESULTS.md           │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── E5: budget enforcement ─────────────────────────┐
│ structural (no key, real Redis):                                            │
│   register budgetVoterExtension with limit; inject synthetic over-cap spend │
│   on tool_call → assert {block:true} AND exactly one `abort` in Redis log   │
│   unset cap → assert no block, no `abort`                                   │
│ live (key-gated SH_RUN_LIVE + ANTHROPIC_AUTH_TOKEN):                        │
│   runTurn(prompt forcing a tool call) with SH_BUDGET_TOKENS=1               │
│   → assert block + exactly one `abort` in Redis                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 File layout

```
serverless-harness/
  pnpm-workspace.yaml             # edit — add "experiments" to globs (F7)
  harness/src/run-turn.ts         # edit — model + provider runtime inputs (§4.2)
  experiments/
    package.json                  # NEW — @sh/experiments (private), vitest
    tsconfig.json                 # NEW
    vitest.config.ts              # NEW
    RESULTS.md                    # NEW — committed results (E2 table; E5 outcome)
    src/
      counting-backend.ts         # NEW — SessionStorageBackend decorator (read tally)
      session-fixture.ts          # NEW — buildCompactedSession(redis, sid, N)
      report.ts                   # NEW — format results → markdown table + JSON
    test/
      counting-backend.test.ts    # NEW — unit: tallies entries/bytes correctly
      session-fixture.test.ts     # NEW — unit: produces a compacted, checkpointed session
      e2-reconstruction-cost.test.ts  # NEW — E2 measurement + ratio gate + parity (real Redis)
      e5-budget-structural.test.ts    # NEW — E5 gate: block + single abort + inert (real Redis)
      e5-budget-live.test.ts          # NEW — E5 live: tiny-cap real-model breach (key-gated)
```

### 4.2 Production change (`harness/src/run-turn.ts`)

```ts
export interface TurnConfig {
  redisUrl?: string;
  cwd?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  model?: string;      // NEW
  provider?: string;   // NEW
}

// replaces run-turn.ts:78
const provider = config?.provider ?? process.env.SH_MODEL_PROVIDER ?? "anthropic";
const modelId  = config?.model    ?? process.env.SH_MODEL          ?? "claude-opus-4-8";
const baseModel = getModel(provider, modelId);
```

Defaults preserved ⇒ M4/M5 behavior unchanged when unset. The existing gateway/auth-header
branch (F6) is unchanged and remains anthropic/gateway-shaped (D8).

### 4.3 Counting backend (`experiments/src/counting-backend.ts`)

A decorator implementing `SessionStorageBackend` (F3) around the real backend the loaders use.
It delegates every method and, on `read()`, accumulates `entriesRead += result.length` and
`bytesRead += Σ Buffer.byteLength(JSON.stringify(entry))`. Exposes `counts()` and `reset()`.
Counting at the `SessionStorageBackend` boundary is faithful for cold reconstruction: the buffer
is empty in a fresh process, so each `read()` reflects a Redis fetch. Both loaders' reads
(`openFromBackend` full read; `openFromCheckpoint` `latestCheckpoint()` + tail `read()`) are
tallied.

### 4.4 Session fixture (`experiments/src/session-fixture.ts`)

`buildCompactedSession(store, sessionId, N)` appends N realistic `FileEntry` records (a mix of
user/assistant messages so a leaf→root branch exists), then appends a real `compaction` entry
with a fixed `firstKeptEntryId` near the tail (so the kept tail is small and N-independent), then
the `checkpoint` marker pointing at the kept-tail position. Built directly through the M5
`RedisSessionBackend` / `SessionManager.appendCompaction` path used by `checkpoint.test.ts` (F4),
so the produced log is structurally identical to a genuinely compacted session.

### 4.5 E2 measurement (`experiments/test/e2-reconstruction-cost.test.ts`)

**Background — what E2 actually exercises (why `openFromCheckpoint` is O(tail), and why the
marker exists).** The measured win rests on the M5 resume mechanism; this is the thing E2
quantifies. A compacted session's log is laid out (by position) as:

```
pos 1     header
pos 2..k-1   older messages            ← summarized away
pos k     firstKeptEntryId             ◄── resume MUST start here (kept tail begins)
pos k+1.. more kept messages
pos m     compaction entry             ← appended AFTER the kept msgs (summary + firstKeptEntryId)
pos m+1.. post-compaction messages
```

Two facts make a simple "read from the compaction entry forward" insufficient, and motivate the
separate `checkpoint` marker:

1. **The kept tail sits *before* the compaction entry (F4).** Pi appends the compaction entry
   *after* the messages it retains, so reading forward from the compaction entry's position would
   drop the kept tail (positions `k..m-1`) and reconstruct the wrong context. The correct resume
   point is `firstKeptEntryId` at position `k`, which is *earlier* in the log.
2. **Redis Streams seek by position, not by content-id.** The compaction entry holds
   `firstKeptEntryId` as a string id buried in its payload. Translating that id → stream position
   requires reading entries until it is found — an O(N) scan (`positionOfId`), which is exactly the
   cost the fast path is meant to avoid.

The `checkpoint` marker resolves this: at compaction time (rare, and already expensive due to the
LLM summarization), the harness computes `positionOfId(firstKeptEntryId)` once and stores it as an
integer `resumeFromPosition`. Cold start then (a) finds the newest marker via `latestCheckpoint`
(a cheap tail-first XREVRANGE lookup) and (b) issues one positional seek
`XRANGE <resumeFromPosition> +`, returning `[firstKept … kept tail … compaction … post-compaction]`
in a single O(tail) read — no scan to locate the compaction entry, no id→position scan. The marker
is, in effect, a precomputed "seek to position P" index entry; without it, resume would still be
O(total) and the E2 win would not exist. **E2 measures precisely this:** the entries/bytes the
tail read pulls (constant, bounded by the kept tail) versus the full read (`openFromBackend`, which
pulls the whole log, ≈ N + header + compaction + marker).

For each N: build the fixture; wrap the backend in `CountingBackend`; reset and run
`openFromBackend` (record counts); reset and run `openFromCheckpoint` (record counts); assert the
two reconstructions produce a deep-equal `buildSessionContext()`. After the series, assert the
ratio gate (D3) and write the table to `RESULTS.md` (markdown) with the raw JSON echoed to stdout
(redirected to the session log per the context-budget rule).

### 4.6 E5 structural (`experiments/test/e5-budget-structural.test.ts`)

Against real Redis: create a session, register `budgetVoterExtension(sm, { limit })`, drive the
`tool_call` path with a synthetic over-baseline spend (same injection technique as M5's
`budget-voter.test.ts`, but asserting persistence). Assert: the handler returns `{ block: true }`;
exactly one `abort` custom entry is present in the Redis log after flush; and, with the cap unset,
no block and no `abort`.

### 4.7 E5 live (`experiments/test/e5-budget-live.test.ts`)

Gated on `process.env.SH_RUN_LIVE` and a key (otherwise `it.skip`). `SH_BUDGET_TOKENS=1`; call
`runTurn(promptThatForcesAToolCall, undefined, config)` with `model`/`provider` from env. The
first post-baseline `tool_call` trips the cap. Assert block (turn `stopReason`/`errorMessage`
reflects the abort path) and exactly one `abort` entry in Redis. **Open implementation detail**
(resolved in the plan, not a gate): confirm at least one tool is registered without a sandbox
pod; if none, either set `KAGENTI_SANDBOX_POD` for the live run or register a trivial no-op tool
so the model has something to call.

---

## 5. Verification gate

### Unit (no key)
- `CountingBackend`: read tallies match expected entries and byte totals; `reset()` zeroes; non-`read` methods delegate.
- `session-fixture`: produced session has N+compaction+marker; `latestCheckpoint()` returns the marker; `openFromCheckpoint` reads strictly fewer entries than `openFromBackend`.

### Integration — real Redis on `localhost:6379` (no key)
- **E2 ratio gate (primary):** across N ∈ {50,200,1000,5000}, checkpoint entries/bytes ≈ constant; backend grows ~linearly; `ratio(N=5000) ≫ ratio(N=50)` and non-decreasing across the series (tolerance documented). `buildSessionContext()` parity holds at every N.
- **E5 structural gate (primary):** over-cap spend ⇒ `{ block:true }` + exactly one persisted `abort`; unset cap ⇒ no block, no `abort`.

### Live (manual, key-gated)
- **E5 live:** tiny-cap real-model run blocks and records exactly one `abort`. Skips with no key.

### Build/regression
- `pnpm -C experiments test` green; existing harness / session-backend / k8s-sandbox suites green; pi-fork untouched (no submodule change). Analyze long logs via subagents (context-budget rule).

---

## 6. Deviations from the pi-track plan (Tasks 18, 21)

| Plan (Task 18/21) | This spec | Why |
|---|---|---|
| E2 = end-to-end cold-start **latency** (message→first-token) | E2 = **local reconstruction cost** (entries/bytes read) | Pi compaction already bounds LLM context; latency would show "no effect" (M5 §1, §1.1 here). |
| `everyK` cadence on/off | Ride Pi's native compaction; no `everyK` | The knob doesn't exist (M5 D5); fixture compacts once. |
| Python drivers, HTTP against deployed Knative service, `kubectl scale` | In-process TypeScript vitest, local Redis | E2 measures in-process Redis reads + the `buildSessionContext` walk — not observable over HTTP. E5 drives the voter directly. |
| E5: realistic 50k cap + "refactor everything", assert elapsed | E5: no-key structural gate (synthetic spend) + key-gated **tiny-cap** live run | Deterministic CI gate without a key; tiny cap makes the live breach deterministic. |
| `redis-cli XRANGE … | count "abort"` via `kubectl exec` | Assert exactly one `abort` in Redis from the test process | No cluster; direct Redis assertion is exact. |

---

## 7. Residual risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Counting at the `SessionStorageBackend` boundary measures entries/bytes returned, not raw Redis wire bytes. | Slight abstraction from true I/O. | Faithful proxy for the O(tail) vs O(total) story (the quantity that differs); documented. Wall-clock column gives a tangible secondary read. |
| Wall-clock reconstruction time is noisy on a dev box. | Secondary column varies run-to-run. | Reported as illustrative only; the gate is the deterministic entries/bytes ratio (D3). |
| Live E5 needs a tool the model will actually call without a sandbox pod. | Live breach may not fire. | Resolved in the plan (§4.7): set `KAGENTI_SANDBOX_POD` or register a trivial tool. Live run is **not** the pass gate (D4 structural gate is). |
| Synthetic fixture diverges from genuinely-compacted sessions. | E2 measures an unrealistic shape. | Built through the same `RedisSessionBackend`/`appendCompaction` path as `checkpoint.test.ts` (F4); a unit test asserts `latestCheckpoint`/parity hold on it. |
| `SH_MODEL_PROVIDER` ≠ anthropic is untested (D8). | False expectation of multi-provider support. | Documented as forward-looking; default and tests use anthropic (incl. gateway). |
| New workspace glob / cross-package deps misconfigured. | `pnpm -C experiments test` won't resolve `harness`/pi-fork. | Mirror the existing `harness` package's workspace deps; build-order gotchas from M2/M4 noted in the plan. |

---

## 8. Relationship to the parent plan

This implements the pi-track plan's experiments **E2** (Task 18) and **E5** (Task 21),
re-targeted from cluster/HTTP Python drivers to in-process TypeScript measurements, and from the
misleading latency metric to the local reconstruction cost the M5 spec mandates (§1.1). It
consumes M5 directly and adds no pi-fork code.

### 8.1 Sequel milestone — M7 (end-to-end cluster experiments E1 / E3-mobility / E4)

The remaining parent-plan experiments are a **different subsystem**, deferred to a separate
milestone (M7) with its own spec/plan/branch, gated on the M4 Knative deployment on Kind + a live
model + cluster lifecycle scripting:

- **E1** — scale-to-zero economics (idle pod-seconds, persistent vs serverless). Cluster/Knative;
  independent of M5.
- **E3 — mobility only.** Complete on instance A, kill it, fresh instance B answers from the log.
  E3's **fidelity** half ("checkpoint context ≡ full-replay context") is **already satisfied** by
  the M5 parity gate (`checkpoint.test.ts`) and re-confirmed by M6/E2's `buildSessionContext()`
  parity assertion — so M7's E3 collapses to the A→B handoff demonstration.
- **E4** — recovery: force-delete the pod mid-session, resume with zero completed-turn loss.

These share the parent plan's "HTTP driver against the deployed service + `kubectl`" shape — a
different harness, deps, and failure modes from M6's in-process measurements. **E5 is fully
covered by M6** in-process; a cluster reprise could ride M7 but is not needed for the proof.

---

## 9. Process & constraints

- Branch `feat/m6-experiments` off `origin/main` (already created). PR to `main` when green.
- DCO sign-off (`git commit -s`); trailer `Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>`;
  never `Co-Authored-By` / "Generated by".
- Real Redis on `localhost:6379` — not auto-running in this env; start with
  `docker run -d --rm --name sh-m6-redis -p 6379:6379 redis:7-alpine`.
- Context budget: redirect long output to `/tmp/kagenti/tdd/serverless-harness`; analyze big logs
  via subagents.
- Build via subagent-driven-development (fresh implementer per task + two-stage review).

### 9.1 Running the experiments

```bash
# no-key (E2 + E5 structural) — the pass gate
docker run -d --rm --name sh-m6-redis -p 6379:6379 redis:7-alpine
pnpm -C experiments test

# live E5 (real model) — manual, end-to-end optic
export SH_MODEL_PROVIDER=anthropic
export SH_MODEL=claude-opus-4-8
export ANTHROPIC_AUTH_TOKEN=…              # (+ ANTHROPIC_BASE_URL=… for the gateway)
export SH_RUN_LIVE=1 SH_BUDGET_TOKENS=1
pnpm -C experiments test e5-budget-live
```

No secrets in the repo; model + provider + key are env-only.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
