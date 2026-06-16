# M1 Design: Complete the Redis `SessionStorageBackend` Integration

Version: 1.0 — June 16, 2026
Status: Design (approved for implementation planning)
Scope: Milestone 1 of the serverless harness — externalize Pi session state to Redis
Parent plan: [Serverless Harness: Revised Plan](../../../docs/research/2026-06-10-serverless-harness-revised-plan.md) §4, §6 (M1)
Discovery basis: [`NOTES-pi-sessionmanager.md`](../../packages/session-backend/NOTES-pi-sessionmanager.md) (pinned Pi commit `406a2214`)

---

## 1. Goal & scope

Make the serverless harness's hard dependency real: Pi persists session state to
**Redis instead of local JSONL**, transparently, so a session can be resumed by a
*fresh process* with no local files.

M1 is **done** when a turn round-trips through Redis and survives process death,
proven by an automated deterministic test (faux provider) plus one real headless
smoke run.

### In scope

- A `SessionStorageBackend` seam inside `pi-fork` (upstreamable, mirrors issue #2032).
- The Redis backend wired through that seam.
- Resume **by `session_id`** (no local file path).
- Write-behind durability with barrier flush.
- The checkpoint **read** path (`latestCheckpoint`).

### Out of scope (later milestones / tracks)

- Knative serverless wrapper + `user_message` trigger (M3).
- Checkpoint **write** / compaction-checkpoint logic (M4).
- K8sSandboxClient (M2).
- The semantic event-log schema (`intention`/`vote`/`commit`/…) as an analytics or
  cross-harness translation layer — explicitly deferred (see §4.4).

---

## 2. Key decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Entry representation | **Native passthrough** — store Pi's `FileEntry` verbatim; backend never reshapes it. |
| D2 | Fork invasiveness | **Upstreamable refactor** — introduce `SessionStorageBackend` in Pi core + `FileSessionStorageBackend` default + factory injection. |
| D3 | Sync→async bridge | **Write-behind + barrier flush** — keep Pi's sync append API; drain to Redis async; `await flush()` at `turn_end` and `session_shutdown`. |
| D4 | Storage envelope | **Thin envelope** around the opaque Pi entry, keeping `position` + `content_sha256`. |
| D5 | Checkpoint representation | Pi **`custom` entry** with `customType: "checkpoint"` (distinct from native `compaction`). |
| D6 | M1 gate | **Deterministic integration test** (faux provider + disposable Redis) **+ one real headless smoke**. |
| D7 | Ownership split | Generic seam in `pi-fork`; Redis specifics in `@sh/session-backend` + `harness`. Dependency arrow points one way only. |

---

## 3. The fork: `SessionStorageBackend` in Pi core

Mirror issue [earendil-works/pi#2032](https://github.com/badlogic/pi-mono/issues/2032).
All edits in `pi-fork/packages/coding-agent/src/core/session-manager.ts`, on a tracked
branch based on the pinned commit `406a2214` (not detached HEAD), shaped to read like
the PR that would eventually be opened upstream.

Three changes:

1. **Define the interface** `SessionStorageBackend` (async), identical to the one already
   built in `@sh/session-backend`:

   ```ts
   export interface SessionStorageBackend {
     append(entry: NewEntry): Promise<LogEntry>;
     read(session_id: string, fromPosition?: number): Promise<LogEntry[]>;
     latestCheckpoint(session_id: string): Promise<LogEntry | null>;
     nextPosition(session_id: string): Promise<number>;
     list(): Promise<string[]>;
   }
   ```

   Plus a `flush(): Promise<void>` method required by the async backend — see §4.1
   (no-op for the file backend).

2. **Extract today's file I/O into `FileSessionStorageBackend`.** The current
   `_persist` / `_rewriteFile` / `loadEntriesFromFile` / `setSessionFile` logic moves
   behind the interface, **unchanged in behavior**. This is the default backend, so all
   of Pi's existing tests stay green — it is the regression guard for the refactor.

3. **Inject the backend through the factories** (`create` / `open` / `continueRecent` /
   `forkFrom` / `inMemory`), defaulting to `FileSessionStorageBackend`. Resume becomes
   **by `session_id`** (the Redis stream key) rather than by file path:
   `open(session_id, { backend })` calls `await backend.read(session_id, fromCheckpoint)`
   to rebuild the in-memory tree.

The Redis backend is **injected**, never imported by Pi core.

### Behavior-preserving constraint

The file backend must reproduce Pi's existing persistence semantics exactly, including:
- **Lazy flush** — entries held in memory until the first assistant message, then the
  whole prefix written with flag `"wx"`, `flushed = true`, append-only thereafter.
- **`_rewriteFile`** (flag `"w"`) on migration and branched-session creation only —
  never during normal conversation flow.
- **Compaction is an append**, not a rewrite (`appendCompaction` records summary +
  `firstKeptEntryId`; disk history is preserved).

---

## 4. Storage model

### 4.1 Sync→async bridge (write-behind + barrier flush)

Pi's public append API stays **synchronous** — no blast radius into the agent loop.

- **Live reads**: unchanged — served from Pi's in-memory tree (`fileEntries` / `byId`),
  which remains authoritative for the duration of a live session.
- **Cold-start read**: async, once, before the agent loop — `await backend.read(...)`
  from the latest checkpoint forward.
- **Writes**: `_persist(entry)` → `makeEntry()` (stamps `position` from `nextPosition`,
  computes `content_sha256`) → **enqueue** to an in-order buffer → return sync. A
  background worker drains the queue to Redis preserving append order.
- **Durability barriers**: the harness `await`s `backend.flush()` at **`turn_end`** and
  **`session_shutdown`** (both confirmed Pi hooks). A *completed turn* is therefore always
  durable (satisfies experiment E4); only an in-flight turn can be lost on a hard kill.

`FileSessionStorageBackend.flush()` is a **no-op** (its writes are already synchronous
`appendFileSync`), so the file path is unchanged.

> **Note:** `flush()` is an addition to the interface beyond #2032's original shape. It is
> required by the async (Redis) backend and harmless (no-op) for the file backend. Flag
> this when upstreaming.

### 4.2 The storage envelope

`@sh/session-backend/src/entry.ts` is refactored from the semantic enum to a thin
envelope wrapping Pi's opaque native entry:

```ts
export interface LogEntry {
  position: number;       // monotonic offset (Redis INCR); powers read(fromPosition)
  session_id: string;
  piType: string;         // denormalized copy of the Pi entry's `type`, for cheap filtering
  entry: FileEntry;       // Pi's native entry/header, stored & returned VERBATIM
  content_sha256: string; // integrity; makes E3/E4 fidelity provable by hash
  timestamp: number;      // wall-clock ms; audit only, not ordering
}
```

- `position` and `content_sha256` are retained from the current implementation.
- `entry` is opaque to the backend — the backend never interprets it except via the
  denormalized `piType`.
- The previous semantic `ENTRY_TYPES` enum is **removed from the critical path**.

### 4.3 `redis-backend.ts` updates

- `append`: store the opaque `entry` (JSON) + the denormalized `piType`; keep the
  `position` (`INCR`) and `content_sha256` columns.
- `read`: return `entry` verbatim; `fromPosition` filter unchanged.
- `latestCheckpoint`: filter `piType === "custom"` **and**
  `entry.customType === "checkpoint"`, return the newest.

### 4.4 Checkpoint = Pi `custom` entry

The checkpoint (the reconstructed, post-compaction context window from the parent plan
§3.2) is **richer than** Pi's built-in `compaction` summary, so it is represented as a Pi
**`custom` entry** (`customType: "checkpoint"`, `data` = serialized reconstructed context
window) — distinct from Pi's native `compaction`, leaving Pi's tree logic untouched.

M1 implements only the **read** side (`latestCheckpoint`). Writing checkpoints is M4.

### 4.5 Session-id mapping

Pi's internal `sessionId` (uuid-v7) maps directly to the Redis stream key
`session:<sessionId>` (as already implemented). No filename/timestamp scheme is used in
the Redis backend.

---

## 5. Ownership split (the dependency arrow points one way)

**Governing principle: Pi core never depends on Redis or on `@sh/session-backend`.**
Anything Redis-flavored lives in `harness` or the backend package. This keeps the fork
diff a clean, self-contained refactor that could be opened as a PR, and isolates the
experiment's glue from the contribution.

| Lives in | What | Why |
|----------|------|-----|
| **`pi-fork` core** | `SessionStorageBackend` interface + `FileSessionStorageBackend` (extraction) + factory injection | The upstreamable slice; Pi core owns the interface and its default. |
| **`pi-fork` test dir** | Backend **contract/parity** test parametrized over `InMemory` + `File` (no Redis dependency) | Proves the extraction is behavior-preserving; ships *with* the #2032 contribution; runs in Pi's own suite. |
| **`@sh/session-backend`** | `RedisSessionBackend` + the envelope refactor (`entry.ts`) | Our code, injected — Pi never imports it. |
| **`harness` package** | The wiring (inject Redis into Pi's factory; `flush()` at `turn_end` / `session_shutdown` via extension hooks; headless entry wrapper) **+ the Redis integration / mobility / recovery tests + the headless smoke** | Depends on *both* `pi-fork` and `@sh/session-backend`; keeps that dependency out of Pi core. |

The `harness` package is already declared in `pnpm-workspace.yaml` but does not yet exist;
M1 creates it.

---

## 6. M1 acceptance gate (the proof)

### 6.1 Automated, deterministic (`harness` package, vitest, faux provider + disposable Redis)

Pi ships a real faux provider (`pi-fork/packages/ai/src/providers/faux.ts`:
`registerFauxProvider`, `fauxAssistantMessage`, `fauxText`, `fauxToolCall`,
`FauxResponseFactory` for scripted multi-step turns *including tool calls*). The gate
rests on this shipped seam, not on a live model.

1. **Storage-swap parity** — drive a scripted turn (faux assistant message + a tool call)
   through `SessionManager` with the Redis backend; assert entries land in Redis and
   `read(fromPosition)` tail works.
2. **Mobility (E3-in-miniature)** — open a **fresh** `SessionManager` by `session_id`,
   reconstruct the tree, assert it is identical to the original by comparing
   `content_sha256` per position.
3. **Recovery (E4-in-miniature)** — append a completed turn, `await flush()`, drop the
   instance, cold-start a new one, assert zero completed-turn loss.

### 6.2 Regression guard (`pi-fork` test dir)

4. The backend **contract/parity** test parametrized over `InMemory` + `File` backends
   must stay green — proving the extraction is behavior-preserving, independent of Redis.

### 6.3 Manual smoke (feasibility gate, parent plan §4.1)

One real `pi --print "…"` / `--mode json` run with the Redis backend against a live model,
confirming the headless one-shot entry point drives the externalized store end-to-end.

### 6.4 Exit criteria

- All automated tests green on **both** backends (Redis via `harness`, File/InMemory via
  `pi-fork`).
- The headless smoke round-trips a turn through Redis and a fresh process resumes it.

---

## 7. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Fork diff diverges from upstream as Pi evolves | Maintenance burden | Keep the diff minimal + behavior-preserving; shape to #2032; pin to `406a2214`; branch (not detached HEAD). |
| Write-behind loses an in-flight turn on hard kill | Sub-turn data loss | Acceptable by design — durability boundary is the *completed turn* (E4). Flush at `turn_end` + `session_shutdown`. |
| Lazy-flush / `_rewriteFile` semantics subtly broken in extraction | Pi behavior regression | The parametrized parity test over `File` + `InMemory` is the guard; extract behavior unchanged. |
| `flush()` not in #2032's interface | Upstreaming friction | Documented as a required, no-op-for-file addition; raise explicitly in the PR. |
| Resume-by-`session_id` changes the factory contract | Breaks callers expecting a path | Default factory behavior (file, path-based) preserved; `session_id` resume is the injected-backend path. |

---

## 8. References

- Parent plan: [Serverless Harness: Revised Plan](../../../docs/research/2026-06-10-serverless-harness-revised-plan.md)
- Discovery: [`NOTES-pi-sessionmanager.md`](../../packages/session-backend/NOTES-pi-sessionmanager.md)
- Pi session-storage proposal: [earendil-works/pi#2032](https://github.com/badlogic/pi-mono/issues/2032)
- Pi faux provider: `pi-fork/packages/ai/src/providers/faux.ts`

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
