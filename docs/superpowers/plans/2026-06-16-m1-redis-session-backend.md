# M1: Redis SessionStorageBackend Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Pi persist session state to Redis instead of local JSONL, transparently, so a session can be resumed by a fresh process with no local files — proven by deterministic automated tests plus one real headless smoke.

**Architecture:** Three layers with a one-way dependency arrow. (1) `@sh/session-backend` is a generic, entry-agnostic append-only log store (`LogStore<E>`) with a Redis Streams implementation. (2) `pi-fork` core gains a `SessionStorageBackend` interface (FileEntry-facing, mirrors issue #2032) that `SessionManager` delegates to when injected; the default file path is left untouched. (3) The `harness` package holds a `BufferedRedisBackend` decorator (write-behind queue + `flush()`) that adapts the generic store to Pi's interface, plus the integration tests and the headless smoke entry. **Pi core never imports Redis or `@sh/session-backend`.**

**Tech Stack:** TypeScript (ESM), pnpm workspaces, vitest, Redis (`redis` v6 client, Streams), Pi (`@earendil-works/pi-coding-agent`) pinned at commit `406a2214`.

---

## Spec

Implements [`docs/specs/2026-06-16-m1-redis-session-backend-design.md`](../../specs/2026-06-16-m1-redis-session-backend-design.md). Discovery basis: [`packages/session-backend/NOTES-pi-sessionmanager.md`](../../../packages/session-backend/NOTES-pi-sessionmanager.md).

### Planning-time refinements to the spec (read before starting)

These resolve concrete topology issues found while reading Pi source. They preserve the spec's intent (native passthrough, upstreamable seam, one-way dependency):

1. **The interface is split, not shared.** Pi core owns a **FileEntry-facing** `SessionStorageBackend` (this is the #2032 contribution). `@sh/session-backend` stays **entry-agnostic** (`LogStore<E>`, stores opaque JSON) so it needs zero Pi types and avoids cross-submodule build coupling. The `harness` package is where the two meet — `BufferedRedisBackend` implements Pi's interface using a `LogStore`.
2. **Pi-core injection is a guarded parallel path, not a full file-I/O extraction.** When a backend is injected, `_persist`/load route to it; when absent, the existing file code runs **literally unchanged**. The regression guard is therefore "Pi's existing test suite stays green" (stronger than a new parity test). A full `FileSessionStorageBackend` extraction is deferred to upstreaming time.
3. **The SDK already injects a `SessionManager`** (`createAgentSession({ sessionManager })`), so the headless smoke needs **no `main.ts` edits** — only Tasks 3–4 touch `pi-fork`.

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `packages/session-backend/src/entry.ts` | Generic `StoredEntry<E>` envelope + `makeStoredEntry` (rewrite) | 1 |
| `packages/session-backend/src/backend.ts` | Generic `LogStore<E>` interface (rewrite) | 2 |
| `packages/session-backend/src/redis-backend.ts` | `RedisSessionBackend<E>` implements `LogStore<E>` (rewrite) | 2 |
| `packages/session-backend/src/index.ts` | Barrel export (new) | 2 |
| `pi-fork/.../core/session-storage-backend.ts` | Pi's `SessionStorageBackend` interface (new) | 3 |
| `pi-fork/.../core/session-manager.ts` | Inject backend into `SessionManager` (modify) | 4 |
| `pi-fork/.../core/index.ts` + `src/index.ts` | Export the interface + `FileEntry` (modify) | 3 |
| `pi-fork/.../test/session-backend-seam.test.ts` | Seam test with in-memory fake backend (new) | 4 |
| `harness/package.json`, `harness/vitest.config.ts` | Package scaffold (new) | 5 |
| `harness/src/buffered-redis-backend.ts` | `BufferedRedisBackend` decorator (new) | 5 |
| `harness/test/buffered-redis-backend.test.ts` | Decorator unit tests, fake store (new) | 5 |
| `harness/test/integration.test.ts` | SessionManager↔Redis parity/mobility/recovery (new) | 6 |
| `harness/src/flush-extension.ts` | Pi extension: flush on `turn_end`/`session_shutdown` (new) | 7 |
| `harness/src/cli.ts` | Headless smoke entry (new) | 7 |
| `harness/README.md`, root `README.md` | Docs (modify) | 8 |

---

## Prerequisites (do once, before Task 1)

- [ ] **P1: Create a tracked branch in the Pi fork** (so fork edits are committed, not detached)

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness/pi-fork
git checkout -b feat/session-storage-backend
git rev-parse --abbrev-ref HEAD   # expect: feat/session-storage-backend
cd ..
```

- [ ] **P2: Start a local Redis** (Tasks 2 and 6 need it)

```bash
docker run -d --rm --name sh-redis -p 6379:6379 redis:7
docker exec sh-redis redis-cli ping   # expect: PONG
```

- [ ] **P3: Confirm the workspace lists the `harness` package**

Run: `grep -A2 packages /Users/paolo/Projects/aiplatform/serverless-harness/pnpm-workspace.yaml`
Expected: output includes both `"packages/*"` and `"harness"`. (It already does — no edit needed.)

---

## Task 1: Generic storage envelope (`@sh/session-backend`)

**Files:**
- Modify: `packages/session-backend/src/entry.ts`
- Test: `packages/session-backend/test/entry.test.ts`

- [ ] **Step 1: Replace the test with envelope tests**

Replace the entire contents of `packages/session-backend/test/entry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeStoredEntry } from "../src/entry";

describe("makeStoredEntry", () => {
  it("wraps an opaque entry and hashes its JSON", () => {
    const e = makeStoredEntry({
      position: 1, session_id: "s", piType: "message",
      entry: { type: "message", x: 1 },
    });
    expect(e.position).toBe(1);
    expect(e.session_id).toBe("s");
    expect(e.piType).toBe("message");
    expect(e.entry).toEqual({ type: "message", x: 1 });
    expect(e.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.timestamp).toBe(0); // default when not provided
  });

  it("is deterministic: equal entries -> equal hash regardless of envelope fields", () => {
    const a = makeStoredEntry({ position: 1, session_id: "s", piType: "t", entry: { a: 1 } });
    const b = makeStoredEntry({ position: 9, session_id: "s2", piType: "t", entry: { a: 1 } });
    expect(a.content_sha256).toBe(b.content_sha256);
  });

  it("different entry content -> different hash", () => {
    const a = makeStoredEntry({ position: 1, session_id: "s", piType: "t", entry: { a: 1 } });
    const b = makeStoredEntry({ position: 1, session_id: "s", piType: "t", entry: { a: 2 } });
    expect(a.content_sha256).not.toBe(b.content_sha256);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/session-backend exec vitest run test/entry.test.ts`
Expected: FAIL — `makeStoredEntry` is not exported (current file exports `makeEntry`).

- [ ] **Step 3: Rewrite `entry.ts` with the generic envelope**

Replace the entire contents of `packages/session-backend/src/entry.ts`:

```ts
// packages/session-backend/src/entry.ts
import { createHash } from "node:crypto";

/**
 * A stored log record: a thin envelope around an opaque harness-native entry.
 * The store never interprets `entry` except via the denormalized `piType`.
 */
export interface StoredEntry<E = unknown> {
  position: number;        // monotonic 1-based offset; powers read(fromPosition)
  session_id: string;
  piType: string;          // denormalized copy of the entry's discriminant, for cheap filtering
  entry: E;                // harness-native entry, stored & returned verbatim
  content_sha256: string;  // integrity hash of `entry` (canonical JSON)
  timestamp: number;       // wall-clock ms; audit only, not ordering
}

export function makeStoredEntry<E>(args: {
  position: number;
  session_id: string;
  piType: string;
  entry: E;
  timestamp?: number;
}): StoredEntry<E> {
  const payload = JSON.stringify(args.entry ?? null);
  return {
    position: args.position,
    session_id: args.session_id,
    piType: args.piType,
    entry: args.entry,
    content_sha256: createHash("sha256").update(payload).digest("hex"),
    timestamp: args.timestamp ?? 0, // caller stamps real time; 0 keeps this pure/testable
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/session-backend exec vitest run test/entry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/session-backend/src/entry.ts packages/session-backend/test/entry.test.ts
git commit -m "refactor(session-backend): generic StoredEntry envelope (native passthrough)"
```

---

## Task 2: Generic `LogStore` interface + Redis implementation (`@sh/session-backend`)

**Files:**
- Modify: `packages/session-backend/src/backend.ts`
- Modify: `packages/session-backend/src/redis-backend.ts`
- Create: `packages/session-backend/src/index.ts`
- Modify: `packages/session-backend/package.json` (add `exports`)
- Test: `packages/session-backend/test/redis-backend.test.ts`

- [ ] **Step 1: Rewrite the Redis test for the new entry-agnostic signature**

Replace the entire contents of `packages/session-backend/test/redis-backend.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { RedisSessionBackend } from "../src/redis-backend";

const SID = "test-" + process.pid;
const b = new RedisSessionBackend<{ type: string; customType?: string; n?: number }>("redis://127.0.0.1:6379");

beforeEach(async () => { await b.reset(SID); });
afterAll(async () => { await b.reset(SID); await b.close(); });

describe("RedisSessionBackend (LogStore)", () => {
  it("appends opaque entries and reads them back in order with monotonic positions", async () => {
    await b.append(SID, { type: "message", n: 1 }, "message");
    await b.append(SID, { type: "message", n: 2 }, "message");
    const rows = await b.read(SID);
    expect(rows.map(r => r.position)).toEqual([1, 2]);
    expect(rows.map(r => r.entry.n)).toEqual([1, 2]);
    expect(rows[0].piType).toBe("message");
  });

  it("read(fromPosition) returns only the tail", async () => {
    await b.append(SID, { type: "message" }, "message");
    await b.append(SID, { type: "custom", customType: "checkpoint" }, "custom");
    await b.append(SID, { type: "message" }, "message");
    const tail = await b.read(SID, 2);
    expect(tail.map(r => r.position)).toEqual([2, 3]);
  });

  it("latestWhere returns the newest matching entry", async () => {
    await b.append(SID, { type: "custom", customType: "checkpoint" }, "custom"); // pos 1
    await b.append(SID, { type: "message" }, "message");                          // pos 2
    await b.append(SID, { type: "custom", customType: "checkpoint" }, "custom"); // pos 3
    const cp = await b.latestWhere(SID, e => e.type === "custom" && e.customType === "checkpoint");
    expect(cp?.position).toBe(3);
  });

  it("returns the entry verbatim (round-trip identity)", async () => {
    const entry = { type: "custom", customType: "checkpoint", n: 42 };
    await b.append(SID, entry, "custom");
    const [row] = await b.read(SID);
    expect(row.entry).toEqual(entry);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/session-backend exec vitest run test/redis-backend.test.ts`
Expected: FAIL — `append` still has the old `(NewEntry)` signature; `latestWhere`/`close` don't exist.

- [ ] **Step 3: Rewrite `backend.ts` with the generic interface**

Replace the entire contents of `packages/session-backend/src/backend.ts`:

```ts
// packages/session-backend/src/backend.ts
import type { StoredEntry } from "./entry";

/**
 * Generic append-only log store. Entry-agnostic: stores opaque `E` records keyed
 * by session_id. Shaped to upstream Pi issue #2032, but kept free of any Pi types
 * so this package has no dependency on the fork.
 */
export interface LogStore<E = unknown> {
  /** Append one entry; returns the stored envelope (with assigned position + hash). */
  append(session_id: string, entry: E, piType: string): Promise<StoredEntry<E>>;
  /** Read entries in append order, optionally from a 1-based position offset. */
  read(session_id: string, fromPosition?: number): Promise<StoredEntry<E>[]>;
  /** Most recent entry whose payload satisfies `predicate`, or null. */
  latestWhere(session_id: string, predicate: (entry: E) => boolean): Promise<StoredEntry<E> | null>;
  /** Next position index for a session (1-based; equals current count + 1). */
  nextPosition(session_id: string): Promise<number>;
  /** All known session ids. */
  list(): Promise<string[]>;
}
```

- [ ] **Step 4: Rewrite `redis-backend.ts`**

Replace the entire contents of `packages/session-backend/src/redis-backend.ts`:

```ts
// packages/session-backend/src/redis-backend.ts
import { createClient, type RedisClientType } from "redis";
import { makeStoredEntry, type StoredEntry } from "./entry";
import type { LogStore } from "./backend";

const streamKey = (sid: string) => `session:${sid}`;
const seqKey = (sid: string) => `session:${sid}:seq`;

/**
 * Redis Streams implementation of LogStore. Single-writer-per-session: a session is
 * owned by one harness instance at a time (mobility is sequential handoff, never
 * concurrent), so INCR(position) then XADD is safe without a transaction.
 */
export class RedisSessionBackend<E = unknown> implements LogStore<E> {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379") {
    this.client = createClient({ url });
    this.ready = this.client.connect().then(() => undefined);
  }

  async nextPosition(sid: string): Promise<number> {
    await this.ready;
    return this.client.incr(seqKey(sid));
  }

  async append(sid: string, entry: E, piType: string): Promise<StoredEntry<E>> {
    await this.ready;
    const position = await this.nextPosition(sid);
    const stored = makeStoredEntry({ position, session_id: sid, piType, entry, timestamp: Date.now() });
    await this.client.xAdd(streamKey(sid), "*", {
      position: String(stored.position),
      timestamp: String(stored.timestamp),
      piType: stored.piType,
      entry: JSON.stringify(stored.entry),
      content_sha256: stored.content_sha256,
    });
    return stored;
  }

  async read(sid: string, fromPosition = 1): Promise<StoredEntry<E>[]> {
    await this.ready;
    const rows = await this.client.xRange(streamKey(sid), "-", "+");
    return rows
      .map((r): StoredEntry<E> => ({
        position: Number(r.message.position),
        timestamp: Number(r.message.timestamp),
        session_id: sid,
        piType: r.message.piType,
        entry: JSON.parse(r.message.entry) as E,
        content_sha256: r.message.content_sha256,
      }))
      .filter((e) => e.position >= fromPosition);
  }

  async latestWhere(sid: string, predicate: (entry: E) => boolean): Promise<StoredEntry<E> | null> {
    const all = await this.read(sid);
    const matches = all.filter((e) => predicate(e.entry));
    return matches.length ? matches[matches.length - 1] : null;
  }

  async list(): Promise<string[]> {
    await this.ready;
    const keys = await this.client.keys("session:*");
    return keys.filter((k) => !k.endsWith(":seq")).map((k) => k.slice("session:".length));
  }

  /** Test helper: delete a session's stream + sequence counter. */
  async reset(sid: string): Promise<void> {
    await this.ready;
    await this.client.del([streamKey(sid), seqKey(sid)]);
  }

  /** Close the connection (call in test teardown). */
  async close(): Promise<void> {
    await this.ready;
    await this.client.quit();
  }
}
```

- [ ] **Step 5: Create the barrel export `src/index.ts`**

Create `packages/session-backend/src/index.ts`:

```ts
// packages/session-backend/src/index.ts
export type { StoredEntry } from "./entry";
export { makeStoredEntry } from "./entry";
export type { LogStore } from "./backend";
export { RedisSessionBackend } from "./redis-backend";
```

- [ ] **Step 6: Add an `exports` field so the `harness` package can import `@sh/session-backend`**

In `packages/session-backend/package.json`, add a top-level `"exports"` key (sibling of `"version"`):

```json
  "exports": {
    ".": "./src/index.ts"
  },
```

(Both consumers run under vitest/esbuild, which resolve the `.ts` source directly — no build step for this package.)

- [ ] **Step 7: Run the test to verify it passes** (Redis from P2 must be running)

Run: `pnpm -C packages/session-backend exec vitest run`
Expected: PASS (entry.test.ts 3 + redis-backend.test.ts 4).

- [ ] **Step 8: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/session-backend
git commit -m "refactor(session-backend): entry-agnostic LogStore + Redis impl (append/read/latestWhere)"
```

---

## Task 3: Define Pi's `SessionStorageBackend` interface (`pi-fork`)

**Files:**
- Create: `pi-fork/packages/coding-agent/src/core/session-storage-backend.ts`
- Modify: `pi-fork/packages/coding-agent/src/index.ts` (export interface + `FileEntry`)

> All `pi-fork` work happens on the `feat/session-storage-backend` branch (P1). Commits in this task and Tasks 4 & 7 are made **inside the submodule**; Task 8 bumps the parent repo's submodule pointer.

- [ ] **Step 1: Create the interface file**

Create `pi-fork/packages/coding-agent/src/core/session-storage-backend.ts`:

```ts
import type { FileEntry } from "./session-manager.ts";

/**
 * Pluggable storage backend for session persistence (mirrors issue #2032).
 *
 * The default is local-file persistence inside SessionManager. When an instance is
 * injected, SessionManager delegates persistence and load to it, externalizing the
 * session log (e.g. to Redis). The interface deals in Pi's native FileEntry — the
 * backend stores and returns entries verbatim (native passthrough).
 *
 * Writes are fire-and-forget from SessionManager's synchronous append path; the
 * caller (harness) is responsible for awaiting durability at turn boundaries.
 */
export interface SessionStorageBackend {
  /** Append one entry to the session's log. */
  append(sessionId: string, entry: FileEntry): Promise<void>;
  /** Read entries in append order, optionally from a 1-based position offset. */
  read(sessionId: string, fromPosition?: number): Promise<FileEntry[]>;
  /** Most recent checkpoint entry (a custom entry with customType "checkpoint"), or null. */
  latestCheckpoint(sessionId: string): Promise<FileEntry | null>;
  /** All known session ids. */
  list(): Promise<string[]>;
}
```

- [ ] **Step 2: Export the interface and `FileEntry` from the package index**

In `pi-fork/packages/coding-agent/src/index.ts`, find the existing block that exports from `./core/session-manager.ts` (around line 217, which already exports `SessionManager`). Immediately after that block, add:

```ts
export type { FileEntry, SessionEntry, SessionHeader } from "./core/session-manager.ts";
export type { SessionStorageBackend } from "./core/session-storage-backend.ts";
```

- [ ] **Step 3: Typecheck the fork builds**

Run: `pnpm -C pi-fork/packages/coding-agent exec tsc --noEmit`
Expected: PASS (no type errors). If `tsc` is not wired, run `pnpm -C pi-fork install` first, then retry.

- [ ] **Step 4: Commit (inside the submodule)**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness/pi-fork
git add packages/coding-agent/src/core/session-storage-backend.ts packages/coding-agent/src/index.ts
git commit -m "feat(coding-agent): add SessionStorageBackend interface (#2032 shape)"
cd ..
```

---

## Task 4: Inject the backend into `SessionManager` (`pi-fork`)

**Files:**
- Modify: `pi-fork/packages/coding-agent/src/core/session-manager.ts`
- Test: `pi-fork/packages/coding-agent/test/session-backend-seam.test.ts`

This task adds a guarded backend path. **The existing file path must remain byte-for-byte behavior-identical** (guarded by `if (this.backend)` / `if (!this.backend)`).

- [ ] **Step 1: Write the failing seam test**

Create `pi-fork/packages/coding-agent/test/session-backend-seam.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionStorageBackend } from "../src/core/session-storage-backend.ts";
import type { FileEntry } from "../src/core/session-manager.ts";

/** In-memory backend that pushes synchronously (so fire-and-forget writes are observable). */
class FakeBackend implements SessionStorageBackend {
  store = new Map<string, FileEntry[]>();
  append(sessionId: string, entry: FileEntry): Promise<void> {
    const arr = this.store.get(sessionId) ?? [];
    arr.push(entry);
    this.store.set(sessionId, arr);
    return Promise.resolve();
  }
  read(sessionId: string, fromPosition = 1): Promise<FileEntry[]> {
    return Promise.resolve((this.store.get(sessionId) ?? []).slice(fromPosition - 1));
  }
  latestCheckpoint(sessionId: string): Promise<FileEntry | null> {
    const arr = (this.store.get(sessionId) ?? []).filter(
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "checkpoint",
    );
    return Promise.resolve(arr.length ? arr[arr.length - 1] : null);
  }
  list(): Promise<string[]> {
    return Promise.resolve([...this.store.keys()]);
  }
}

describe("SessionManager backend seam", () => {
  it("persists a turn to the backend and resumes an identical tree in a fresh instance", async () => {
    const backend = new FakeBackend();
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();

    sm.appendMessage({ role: "user", content: "hello" } as never);
    sm.appendMessage({ role: "assistant", content: "hi there" } as never);
    sm.appendCustomEntry("checkpoint", { ctx: "reconstructed" });
    sm.appendMessage({ role: "user", content: "again" } as never);

    // Header + 4 entries landed in the backend, in order.
    const stored = backend.store.get(sid)!;
    expect(stored[0].type).toBe("session");
    expect(stored.map((e) => e.type)).toEqual(["session", "message", "message", "custom", "message"]);

    // Fresh instance reconstructs the identical entry list.
    const resumed = await SessionManager.openFromBackend(sid, backend, process.cwd());
    expect(resumed.getEntries().map((e) => JSON.stringify(e))).toEqual(
      sm.getEntries().map((e) => JSON.stringify(e)),
    );

    // Checkpoint is findable.
    const cp = await backend.latestCheckpoint(sid);
    expect((cp as { customType?: string }).customType).toBe("checkpoint");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C pi-fork/packages/coding-agent exec vitest run test/session-backend-seam.test.ts`
Expected: FAIL — `SessionManager.create` takes no 4th arg / `openFromBackend` does not exist.

- [ ] **Step 3: Add the import and the backend field**

In `pi-fork/packages/coding-agent/src/core/session-manager.ts`:

At the top with the other imports, add:

```ts
import type { SessionStorageBackend } from "./session-storage-backend.ts";
```

In the class field declarations (just after `private leafId: string | null = null;`), add:

```ts
	private backend?: SessionStorageBackend;
```

- [ ] **Step 4: Thread `backend` through the constructor**

Change the private constructor signature to accept a trailing `backend` param, and assign it **before** the `if (sessionFile) … else newSession()` block so `newSession` can use it. Replace:

```ts
	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
```

with:

```ts
	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		backend?: SessionStorageBackend,
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		this.backend = backend;
```

- [ ] **Step 5: Persist the header through the backend in `newSession`, and skip the file path when a backend is present**

In `newSession`, find the persistence block that begins with `if (this.persist) {` and computes `fileTimestamp` / `this.sessionFile`. Replace its guard so the file-path computation is skipped when a backend is injected, and append the header to the backend instead. Change:

```ts
		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
```

to:

```ts
		if (this.persist && this.backend) {
			void this.backend.append(this.sessionId, header);
		} else if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
```

(The rest of the original `if (this.persist)` body — the `this.sessionFile = join(...)` assignment — now lives under the `else if`, unchanged.)

- [ ] **Step 6: Route `_persist` to the backend when present**

At the very top of `_persist(entry: SessionEntry): void`, before the existing `if (!this.persist || !this.sessionFile) return;` line, add:

```ts
		if (this.backend) {
			if (this.persist) void this.backend.append(this.sessionId, entry);
			return;
		}
```

- [ ] **Step 7: Add `loadFromEntries` and the `openFromBackend` factory**

Add this private method (place it next to `setSessionFile`):

```ts
	/** Populate this manager from a backend-sourced entry list (resume path). */
	private loadFromEntries(sessionId: string, entries: FileEntry[]): void {
		this.sessionId = sessionId;
		this.fileEntries = entries;
		this.persist = true;
		this.flushed = true;
		this._buildIndex(); // rebuilds byId, labels, and leafId (= last entry)
	}
```

Add this static factory next to the other factories (`create`/`open`/…):

```ts
	/**
	 * Resume a session from an injected storage backend (Redis), keyed by session id.
	 * Constructed with persist=false so the constructor's newSession() does not append a
	 * spurious header; loadFromEntries() then re-enables persistence after loading.
	 */
	static async openFromBackend(
		sessionId: string,
		backend: SessionStorageBackend,
		cwd: string = process.cwd(),
	): Promise<SessionManager> {
		const entries = await backend.read(sessionId);
		if (entries.length === 0) {
			throw new Error(`Cannot resume: no session in backend for id ${sessionId}`);
		}
		const sm = new SessionManager(cwd, "", undefined, false, undefined, backend);
		sm.loadFromEntries(sessionId, entries);
		return sm;
	}
```

- [ ] **Step 8: Let `create` accept an injected backend**

Replace the existing `static create(...)`:

```ts
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}
```

with:

```ts
	static create(
		cwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
		backend?: SessionStorageBackend,
	): SessionManager {
		// With a backend, persistence is external — no session dir needed.
		const dir = backend ? "" : sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options, backend);
	}
```

- [ ] **Step 9: Run the seam test to verify it passes**

Run: `pnpm -C pi-fork/packages/coding-agent exec vitest run test/session-backend-seam.test.ts`
Expected: PASS (1 test).

- [ ] **Step 10: Run the existing SessionManager suite — the regression guard**

Run: `pnpm -C pi-fork/packages/coding-agent exec vitest run test/ > /tmp/sh-pi-suite.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0`. The injected-backend path is additive and guarded, so all pre-existing session-manager / file-persistence tests must stay green. If any fail, inspect `/tmp/sh-pi-suite.log` and confirm the `if (!this.backend)` guards left the file path unchanged.

- [ ] **Step 11: Commit (inside the submodule)**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness/pi-fork
git add packages/coding-agent/src/core/session-manager.ts packages/coding-agent/test/session-backend-seam.test.ts
git commit -m "feat(coding-agent): inject SessionStorageBackend into SessionManager (guarded path)"
cd ..
```

- [ ] **Step 12: Build the coding-agent package (so the `harness` package can import it in Tasks 5–6)**

Run: `pnpm -C pi-fork install && pnpm -C pi-fork --filter @earendil-works/pi-coding-agent build > /tmp/sh-pi-build.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0` and `pi-fork/packages/coding-agent/dist/index.js` exists. If the filter name differs, run `pnpm -C pi-fork/packages/coding-agent build`.

---

## Task 5: `harness` package scaffold + `BufferedRedisBackend` decorator

**Files:**
- Create: `harness/package.json`
- Create: `harness/vitest.config.ts`
- Create: `harness/src/buffered-redis-backend.ts`
- Test: `harness/test/buffered-redis-backend.test.ts`

- [ ] **Step 1: Create the package scaffold**

Create `harness/package.json`:

```json
{
  "name": "@sh/harness",
  "type": "module",
  "version": "0.0.0",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@sh/session-backend": "workspace:*",
    "@earendil-works/pi-coding-agent": "link:../pi-fork/packages/coding-agent"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Create `harness/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 2: Install so the workspace links resolve**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness && pnpm install > /tmp/sh-install.log 2>&1; echo "EXIT:$?"`
Expected: `EXIT:0`. Confirm `harness/node_modules/@earendil-works/pi-coding-agent` resolves to the submodule package and `@sh/session-backend` is linked.

- [ ] **Step 3: Write the failing decorator unit test**

Create `harness/test/buffered-redis-backend.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeStoredEntry, type LogStore, type StoredEntry } from "@sh/session-backend";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { BufferedRedisBackend } from "../src/buffered-redis-backend";

// The decorator only reads `.type` / `.customType` at runtime, so minimal cast objects
// stand in for full FileEntry values. Helpers keep the casts in one place.
const msg = (): FileEntry => ({ type: "message" }) as unknown as FileEntry;
const custom = (customType: string): FileEntry =>
  ({ type: "custom", customType }) as unknown as FileEntry;
const ct = (e: FileEntry): string | undefined => (e as { customType?: string }).customType;

/** In-memory LogStore<FileEntry> with a per-append delay to test ordering/async. */
class FakeStore implements LogStore<FileEntry> {
  rows: StoredEntry<FileEntry>[] = [];
  failNext = false;
  async append(sid: string, entry: FileEntry, piType: string): Promise<StoredEntry<FileEntry>> {
    if (this.failNext) { this.failNext = false; throw new Error("boom"); }
    await new Promise((r) => setTimeout(r, 1));
    const stored = makeStoredEntry({ position: this.rows.length + 1, session_id: sid, piType, entry });
    this.rows.push(stored);
    return stored;
  }
  async read(_sid: string, from = 1): Promise<StoredEntry<FileEntry>[]> {
    return this.rows.filter((r) => r.position >= from);
  }
  async latestWhere(_sid: string, p: (e: FileEntry) => boolean): Promise<StoredEntry<FileEntry> | null> {
    const m = this.rows.filter((r) => p(r.entry)); return m.length ? m[m.length - 1] : null;
  }
  async nextPosition(): Promise<number> { return this.rows.length + 1; }
  async list(): Promise<string[]> { return ["s"]; }
}

describe("BufferedRedisBackend", () => {
  it("append is fire-and-forget (resolves before the write completes) and preserves order on flush", async () => {
    const store = new FakeStore();
    const b = new BufferedRedisBackend(store);
    b.append("s", custom("a"));
    b.append("s", custom("b"));
    b.append("s", custom("c"));
    expect(store.rows.length).toBe(0); // nothing drained yet — writes are async
    await b.flush();
    expect(store.rows.map((r) => ct(r.entry))).toEqual(["a", "b", "c"]);
  });

  it("flush surfaces a write error from the queue", async () => {
    const store = new FakeStore();
    store.failNext = true;
    const b = new BufferedRedisBackend(store);
    b.append("s", msg());
    await expect(b.flush()).rejects.toThrow("boom");
  });

  it("read unwraps stored entries; latestCheckpoint finds the checkpoint custom entry", async () => {
    const store = new FakeStore();
    const b = new BufferedRedisBackend(store);
    b.append("s", msg());
    b.append("s", custom("checkpoint"));
    await b.flush();
    const entries = await b.read("s");
    expect(entries.map((e) => e.type)).toEqual(["message", "custom"]);
    const cp = await b.latestCheckpoint("s");
    expect(ct(cp as FileEntry)).toBe("checkpoint");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm -C harness exec vitest run`
Expected: FAIL — `BufferedRedisBackend` does not exist.

- [ ] **Step 5: Implement the decorator**

Create `harness/src/buffered-redis-backend.ts`:

```ts
import type { FileEntry, SessionStorageBackend } from "@earendil-works/pi-coding-agent";
import type { LogStore } from "@sh/session-backend";

/**
 * Write-behind decorator adapting a generic LogStore to Pi's SessionStorageBackend.
 *
 * append() enqueues and returns immediately (fire-and-forget) so Pi's synchronous
 * _persist path is never blocked. A serial promise chain drains writes to the inner
 * store in append order. The harness calls flush() at turn_end / session_shutdown to
 * make completed turns durable; flush() also surfaces any deferred write error.
 */
export class BufferedRedisBackend implements SessionStorageBackend {
  private queue: Promise<unknown> = Promise.resolve();
  private lastError: unknown = null;

  constructor(private readonly store: LogStore<FileEntry>) {}

  append(sessionId: string, entry: FileEntry): Promise<void> {
    const piType = entry.type;
    this.queue = this.queue
      .then(() => this.store.append(sessionId, entry, piType))
      .catch((err) => {
        this.lastError = err;
      });
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.lastError) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }

  async read(sessionId: string, fromPosition?: number): Promise<FileEntry[]> {
    const rows = await this.store.read(sessionId, fromPosition);
    return rows.map((r) => r.entry);
  }

  async latestCheckpoint(sessionId: string): Promise<FileEntry | null> {
    const row = await this.store.latestWhere(
      sessionId,
      (e) => e.type === "custom" && (e as { customType?: string }).customType === "checkpoint",
    );
    return row ? row.entry : null;
  }

  async list(): Promise<string[]> {
    return this.store.list();
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm -C harness exec vitest run`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add harness/package.json harness/vitest.config.ts harness/src/buffered-redis-backend.ts harness/test/buffered-redis-backend.test.ts pnpm-lock.yaml
git commit -m "feat(harness): BufferedRedisBackend write-behind decorator"
```

---

## Task 6: SessionManager ↔ Redis integration test (the M1 proof)

**Files:**
- Test: `harness/test/integration.test.ts`

This is E3 (mobility) and E4 (recovery) in miniature, against real Redis (P2), driving the real (built) `SessionManager` with the Redis-backed decorator.

- [ ] **Step 1: Write the integration test**

Create `harness/test/integration.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "../src/buffered-redis-backend";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const store = new RedisSessionBackend<FileEntry>(REDIS);
let createdSid: string | undefined;

afterAll(async () => {
  if (createdSid) await store.reset(createdSid);
  await store.close();
});

describe("SessionManager + Redis (parity / mobility / recovery)", () => {
  it("a completed turn survives process death and a fresh instance resumes it", async () => {
    const backend = new BufferedRedisBackend(store);

    // Drive a "turn": user -> assistant -> checkpoint -> user.
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    createdSid = sm.getSessionId();
    sm.appendMessage({ role: "user", content: "hello" } as never);
    sm.appendMessage({ role: "assistant", content: "hi there" } as never);
    sm.appendCustomEntry("checkpoint", { ctx: "reconstructed" });
    sm.appendMessage({ role: "user", content: "again" } as never);

    // Durability barrier (what the harness calls at turn_end).
    await backend.flush();

    // Mobility + recovery: a brand-new instance reconstructs from Redis alone.
    const resumed = await SessionManager.openFromBackend(createdSid, backend, process.cwd());

    expect(resumed.getEntries().map((e) => JSON.stringify(e))).toEqual(
      sm.getEntries().map((e) => JSON.stringify(e)),
    );

    // read(fromPosition) tail works (position 1 is the header).
    const tail = await store.read(createdSid, 4);
    expect(tail.length).toBeGreaterThan(0);

    // Checkpoint is recoverable through the decorator.
    const cp = await backend.latestCheckpoint(createdSid);
    expect((cp as { customType?: string })?.customType).toBe("checkpoint");
  });
});
```

- [ ] **Step 2: Run the integration test (Redis from P2 must be running)**

Run: `pnpm -C harness exec vitest run test/integration.test.ts`
Expected: PASS (1 test). If it fails to connect, confirm `docker exec sh-redis redis-cli ping` returns `PONG`.

- [ ] **Step 3: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add harness/test/integration.test.ts
git commit -m "test(harness): SessionManager<->Redis parity/mobility/recovery integration"
```

---

## Task 7: Headless smoke wiring (flush extension + CLI entry)

**Files:**
- Create: `harness/src/flush-extension.ts`
- Create: `harness/src/cli.ts`

This discharges the §4.1 "headless one-shot" feasibility gate. It is exercised **manually** against a real model (not in CI). The novel backend/flush wiring is given in full; the prompt-drive loop mirrors Pi's own `print-mode.ts`.

- [ ] **Step 1: Read Pi's print-mode for the exact prompt + exit pattern**

Run: `sed -n '1,90p' pi-fork/packages/coding-agent/src/modes/print-mode.ts`
Note how it calls `session.prompt(...)` and how it accesses the runtime to register events (`session.on(...)` or a returned runtime). You will mirror that exact call in Step 3. (Reading existing integration glue is expected here — this is a feasibility entry, not an automated unit.)

- [ ] **Step 2: Write the flush extension**

Create `harness/src/flush-extension.ts`:

```ts
import type { BufferedRedisBackend } from "./buffered-redis-backend";

/**
 * Returns a Pi extension factory that flushes the write-behind buffer at the two
 * durability barriers: after each completed turn, and on session shutdown (the
 * scale-to-zero exit point). Register this with the agent session's runtime.
 */
export function flushExtension(backend: BufferedRedisBackend) {
  return (pi: { on: (event: string, handler: () => void | Promise<void>) => void }) => {
    pi.on("turn_end", () => backend.flush());
    pi.on("session_shutdown", () => backend.flush());
  };
}
```

- [ ] **Step 3: Write the CLI smoke entry**

Create `harness/src/cli.ts`. The backend construction and flush are concrete; the `createAgentSession` + `prompt` call mirror `print-mode.ts` (Step 1). Adjust the extension-registration call to match the runtime object Pi exposes in your pinned commit.

```ts
import { getModel } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "./buffered-redis-backend";
import { flushExtension } from "./flush-extension";

async function main() {
  const prompt = process.argv[2];
  if (!prompt) throw new Error('usage: cli.ts "<prompt>"   (set PI_SESSION_ID to resume)');

  const store = new RedisSessionBackend<FileEntry>(process.env.REDIS_URL);
  const backend = new BufferedRedisBackend(store);
  const cwd = process.cwd();
  const resumeId = process.env.PI_SESSION_ID;

  const sessionManager = resumeId
    ? await SessionManager.openFromBackend(resumeId, backend, cwd)
    : SessionManager.create(cwd, undefined, undefined, backend);

  const model = getModel("anthropic", "claude-opus-4-8");
  const { session } = await createAgentSession({
    sessionManager,
    model,
    extensionFactories: [flushExtension(backend)],
  });

  // Mirror print-mode.ts: drive one prompt to completion.
  await session.prompt(prompt);

  await backend.flush(); // belt-and-suspenders before exit
  // eslint-disable-next-line no-console
  console.log(`SESSION_ID=${sessionManager.getSessionId()}`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

> If `createAgentSession` in the pinned commit does not accept `extensionFactories`, register the flush handlers directly on the returned `session` runtime (the object `print-mode.ts` uses), using the same `pi.on("turn_end" | "session_shutdown")` events. The flush wiring is the goal; the registration surface is whatever Step 1 reveals.

- [ ] **Step 4: Run the manual headless smoke** (requires a real Anthropic key in Pi's auth + Redis from P2)

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
# Turn 1: new session
REDIS_URL=redis://127.0.0.1:6379 pnpm -C harness exec tsx src/cli.ts "Remember the number 4242. Reply OK."
# Capture the printed SESSION_ID, then resume in a FRESH process:
REDIS_URL=redis://127.0.0.1:6379 PI_SESSION_ID=<printed-id> \
  pnpm -C harness exec tsx src/cli.ts "What number did I ask you to remember?"
```

Expected: turn 2 (a fresh process, no local session files) answers `4242`, proving the externalized log round-trips through Redis end-to-end. Confirm no JSONL was written: `find ~/.pi/agent/sessions -newermt '-5 min' 2>/dev/null` returns nothing for this run.

(If `tsx` is not present: `pnpm -C harness add -D tsx`.)

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add harness/src/flush-extension.ts harness/src/cli.ts harness/package.json pnpm-lock.yaml
git commit -m "feat(harness): headless smoke entry + flush-on-turn_end/shutdown extension"
```

---

## Task 8: Docs + final verification + submodule pointer bump

**Files:**
- Create: `harness/README.md`
- Modify: `README.md` (root)

- [ ] **Step 1: Write the harness README**

Create `harness/README.md`:

```markdown
# @sh/harness

Serverless-harness glue: adapts the generic `@sh/session-backend` log store to Pi's
`SessionStorageBackend`, with write-behind durability.

## Components
- `BufferedRedisBackend` — write-behind decorator (queue + `flush()`); implements Pi's
  `SessionStorageBackend` over a `LogStore` (`RedisSessionBackend`).
- `flushExtension` — flushes at `turn_end` and `session_shutdown`.
- `cli.ts` — headless one-shot smoke entry (resume via `PI_SESSION_ID`).

## Tests
- `pnpm -C harness test` — decorator units + the SessionManager↔Redis integration test
  (needs Redis at `REDIS_URL`, default `redis://127.0.0.1:6379`).

## Dependency direction
`harness → { pi-fork, @sh/session-backend }`. Pi core never imports Redis or
`@sh/session-backend`.
```

- [ ] **Step 2: Add a one-line pointer in the root README**

In `README.md`, append:

```markdown

## Packages
- `packages/session-backend` — generic append-only `LogStore` + Redis Streams impl.
- `harness` — Pi `SessionStorageBackend` adapter (write-behind) + headless smoke.
- `pi-fork` — pinned Pi (commit 406a2214) with the injectable `SessionStorageBackend` seam.
```

- [ ] **Step 3: Full automated verification (all packages)**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
pnpm -C packages/session-backend exec vitest run > /tmp/sh-v1.log 2>&1; echo "backend EXIT:$?"
pnpm -C harness exec vitest run > /tmp/sh-v2.log 2>&1; echo "harness EXIT:$?"
pnpm -C pi-fork/packages/coding-agent exec vitest run test/session-backend-seam.test.ts > /tmp/sh-v3.log 2>&1; echo "seam EXIT:$?"
```

Expected: three `EXIT:0` lines. If any non-zero, inspect the matching `/tmp/sh-v*.log`.

- [ ] **Step 4: Bump the submodule pointer in the parent repo**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git -C pi-fork log --oneline -3   # confirm the 2 fork commits (Tasks 3, 4) are present
git add pi-fork                    # records the new submodule SHA
git status --short                 # expect: modified pi-fork (new commit) + README files
```

- [ ] **Step 5: Commit docs + submodule bump**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add harness/README.md README.md
git commit -m "docs: document harness package + bump pi-fork to session-storage-backend branch"
```

- [ ] **Step 6: Stop the test Redis (cleanup)**

Run: `docker stop sh-redis`
Expected: `sh-redis`.

---

## Self-review notes (coverage check)

- **Spec D1 native passthrough** → Tasks 1–2 store the opaque `entry` verbatim; Task 6 asserts round-trip identity by JSON compare.
- **Spec D2 upstreamable seam** → Tasks 3–4 add the interface in Pi core; the file path is guarded and the existing suite is the regression guard (Task 4 Step 10).
- **Spec D3 write-behind + barrier flush** → Task 5 `BufferedRedisBackend`; Task 7 `flushExtension` ties flush to `turn_end`/`session_shutdown`.
- **Spec D4 envelope** → Task 1 `StoredEntry` (position + content_sha256 retained).
- **Spec D5 checkpoint = custom entry** → `latestCheckpoint`/`latestWhere` filter `type==="custom" && customType==="checkpoint"` (Tasks 2, 4, 5).
- **Spec D6 gate** → Tasks 4 (seam, deterministic) + 6 (Redis parity/mobility/recovery) + 7 (manual headless smoke).
- **Spec D7 one-way dependency** → enforced by topology: `@sh/session-backend` is Pi-free; `harness` depends on both; Pi core depends on neither.

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
