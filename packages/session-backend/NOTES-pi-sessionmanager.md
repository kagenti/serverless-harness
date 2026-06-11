# Pi SessionManager Storage Contract

Discovery notes for the session-storage backend seam.
All line references target the pinned commit `406a2214` of `pi-fork/`.

---

## 1. Class and file that own session persistence

**File:** `pi-fork/packages/coding-agent/src/core/session-manager.ts`
**Class:** `export class SessionManager` — line 757

The class is the single owner of all JSONL file I/O for session data.
It is instantiated via four static factory methods:

| Factory | Purpose | Line |
|---------|---------|------|
| `SessionManager.create(cwd, sessionDir?, options?)` | New session | 1385 |
| `SessionManager.open(path, sessionDir?, cwdOverride?)` | Open existing file | 1396 |
| `SessionManager.continueRecent(cwd, sessionDir?)` | Most-recent or new | 1412 |
| `SessionManager.inMemory(cwd?)` | No-persist (testing) | 1423 |
| `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` | Fork a session | 1434 |

---

## 2. Write methods (all delegate to `_appendEntry`)

### Private core

```
private _appendEntry(entry: SessionEntry): void   // line 937
```
Pushes to in-memory `fileEntries`, updates `byId` map, advances `leafId`,
then calls `_persist(entry)`.

```
_persist(entry: SessionEntry): void               // line 908
```
- If no assistant message has been written yet: holds in memory (lazy flush).
- On first assistant message: opens file with flag `"wx"` and rewrites ALL
  accumulated entries at once (`writeFileSync`), then sets `flushed = true`.
- Subsequent entries: `appendFileSync(this.sessionFile, ...)` — strictly
  append-only once the file is created.

### Public write methods

All return the new entry's `id: string`.

| Method | Signature | Line |
|--------|-----------|------|
| `appendMessage` | `(message: Message \| CustomMessage \| BashExecutionMessage): string` | 950 |
| `appendThinkingLevelChange` | `(thinkingLevel: string): string` | 963 |
| `appendModelChange` | `(provider: string, modelId: string): string` | 976 |
| `appendCompaction` | `(summary, firstKeptEntryId, tokensBefore, details?, fromHook?): string` | 990 |
| `appendCustomEntry` | `(customType: string, data?: unknown): string` | 1013 |
| `appendSessionInfo` | `(name: string): string` | 1027 |
| `appendCustomMessageEntry` | `(customType, content, display, details?): string` | 1061 |
| `appendLabelChange` | `(targetId, label: string \| undefined): string` | 1122 |
| `branchWithSummary` | `(branchFromId: string \| null, summary, details?, fromHook?): string` | 1262 |

### Compaction / rewrite path

`_rewriteFile(): void` — line 872 — opens the file with flag `"w"` (truncate)
and writes ALL `fileEntries` line-by-line. Called when:
- Migration is needed on load (`setSessionFile`, line 811).
- A branched session is created with an assistant message already present (`createBranchedSession`, line 1350).

**Compaction is NOT a rewrite.** The compaction flow calls
`appendCompaction(summary, firstKeptEntryId, tokensBefore, ...)` which is a
normal append. It records the summary text and the ID of the first entry to
keep; the *in-memory* tree then respects `firstKeptEntryId` when building
context, but no entries are deleted from disk. The file remains append-only.
Branching operations (`branch()`, `branchWithSummary()`) similarly only
change the in-memory `leafId` pointer and optionally append a `branch_summary`
entry — no truncation.

---

## 3. Read methods

| Method | Signature | Return shape | Line |
|--------|-----------|-------------|------|
| `getEntries()` | `(): SessionEntry[]` | All non-header entries, shallow copy | 1182 |
| `getEntry(id)` | `(id: string): SessionEntry \| undefined` | Single entry by id | 1093 |
| `getBranch(fromId?)` | `(fromId?: string): SessionEntry[]` | Path from root to leaf | 1150 |
| `getLeafEntry()` | `(): SessionEntry \| undefined` | Current leaf | 1089 |
| `getLeafId()` | `(): string \| null` | Current leaf id | 1085 |
| `getChildren(parentId)` | `(parentId: string): SessionEntry[]` | Direct children | 1100 |
| `getTree()` | `(): SessionTreeNode[]` | Full tree as nodes | 1191 |
| `getHeader()` | `(): SessionHeader \| null` | Session header record | 1172 |
| `buildSessionContext()` | `(): SessionContext` | LLM messages + model/thinking | 1165 |

`SessionEntry` union type — line 140:
```typescript
type SessionEntry =
  | SessionMessageEntry          // type: "message"
  | ThinkingLevelChangeEntry     // type: "thinking_level_change"
  | ModelChangeEntry             // type: "model_change"
  | CompactionEntry              // type: "compaction"
  | BranchSummaryEntry           // type: "branch_summary"
  | CustomEntry                  // type: "custom"
  | CustomMessageEntry           // type: "custom_message"
  | LabelEntry                   // type: "label"
  | SessionInfoEntry             // type: "session_info"
```

Every entry has `{ id: string; parentId: string | null; timestamp: string }` base fields — line 46.

Static list helpers:
- `SessionManager.list(cwd, sessionDir?, onProgress?)` — line 1493
- `SessionManager.listAll(sessionDir?, onProgress?)` — line 1508

---

## 4. File-path computation (the seam to abstract)

**Session directory path:**

```typescript
// line 438
function getDefaultSessionDirPath(cwd: string, agentDir: string): string {
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}
```

Default agent dir root: `~/.pi/agent/` (from `getAgentDir()` in `config.ts`).

So the default session dir for cwd `/home/user/project` is:
`~/.pi/agent/sessions/--home-user-project--/`

**Session file name:**

```typescript
// line 844-846 (inside newSession())
const fileTimestamp = timestamp.replace(/[:.]/g, "-");
this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
```

Pattern: `<ISO-timestamp-sanitized>_<uuid-v7>.jsonl`

**The seam:** The `sessionDir` constructor parameter and the `sessionFile` path
are the only points that reference the local filesystem. To abstract to Redis,
replace `_persist()` and `loadEntriesFromFile()` / `setSessionFile()`.
The `sessionDir` can be passed as `""` with `persist: false` to bypass the
directory creation in the constructor while still calling custom persistence.

---

## 5. Append-only nature and compaction

**Append-only:** YES. After the initial flush (triggered by the first assistant
message), all writes are `appendFileSync`. The only exception is `_rewriteFile()`
which runs on migration or branched-session creation — never during normal
conversation flow.

**Compaction recording:** A `CompactionEntry` is appended as a normal log
record (type `"compaction"`, fields `summary`, `firstKeptEntryId`,
`tokensBefore`, optional `details`/`fromHook`). It is NOT a file rewrite. The
`buildSessionContext()` method uses `firstKeptEntryId` to truncate the in-memory
context when building LLM messages, but the full history remains on disk.

**`session_before_compact` event** fires before compaction and can be cancelled
or customized by extensions (can return a custom summary). After compaction,
`session_compact` fires with the resulting `CompactionEntry`.

---

## 6. Operations interfaces for tool execution

All seven interfaces exist and are exported from
`pi-fork/packages/coding-agent/src/core/tools/index.ts` and
`pi-fork/packages/coding-agent/src/index.ts`.

### Injection pattern

Each tool has a factory function:

```typescript
createBashTool(cwd: string, options?: BashToolOptions): AgentTool<...>  // bash.ts:443
createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<...>  // read.ts:360
createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<...> // write.ts:265
createEditTool(cwd: string, options?: EditToolOptions): AgentTool<...>  // edit.ts:435
createLsTool(cwd: string, options?: LsToolOptions): AgentTool<...>      // ls.ts:223
createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<...>  // grep.ts:383
createFindTool(cwd: string, options?: FindToolOptions): AgentTool<...>  // find.ts:365
```

Each `XxxToolOptions` has `operations?: XxxOperations`. The custom backend is
injected through that `operations` field. **There is no global `spawnHook` at
the session level for filesystem ops** — each tool must be created individually
with its custom operations. For bash there is also a `spawnHook?: BashSpawnHook`
in `BashToolOptions` (bash.ts:134) that can rewrite command/cwd/env.

### Interface signatures

```typescript
// bash.ts:40
interface BashOperations {
  exec: (command: string, cwd: string, options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{ exitCode: number | null }>;
}

// read.ts:43
interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

// edit.ts:74
interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

// write.ts:25
interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

// ls.ts:32
interface LsOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}

// grep.ts:51
interface GrepOperations {
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  readFile: (absolutePath: string) => Promise<string> | string;
}

// find.ts:41
interface FindOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}
```

---

## 7. Lifecycle events (pi.on / extension runtime)

These are registered via `runtime.on(eventName, handler)` on the extension
`PiRuntime` object (types.ts:1125+). All event names are string literals.

### Events confirmed in source

| Event name | Type interface | Blockable / cancellable | Location |
|---|---|---|---|
| `session_start` | `SessionStartEvent` | No | types.ts:1127 |
| `session_before_switch` | `SessionBeforeSwitchEvent` | Yes (result) | types.ts:1129 |
| `session_before_fork` | `SessionBeforeForkEvent` | Yes (result) | types.ts:1132 |
| `session_before_compact` | `SessionBeforeCompactEvent` | Yes (result) | types.ts:1134 |
| `session_compact` | `SessionCompactEvent` | No | types.ts:1137 |
| `session_shutdown` | `SessionShutdownEvent` | No | types.ts:1138 |
| `session_before_tree` | `SessionBeforeTreeEvent` | Yes (result) | types.ts:1139 |
| `session_tree` | `SessionTreeEvent` | No | types.ts:1140 |
| `context` | `ContextEvent` | Yes (result) | types.ts:1141 |
| `before_provider_request` | `BeforeProviderRequestEvent` | Yes (result) | types.ts:1143 |
| `after_provider_response` | `AfterProviderResponseEvent` | No | types.ts:1146 |
| `before_agent_start` | `BeforeAgentStartEvent` | Yes (result) | types.ts:1147 |
| `agent_start` | `AgentStartEvent` | No | types.ts:1148 |
| `agent_end` | `AgentEndEvent` | No | types.ts:1149 |
| `turn_start` | `TurnStartEvent` | No | types.ts:1150 |
| `turn_end` | `TurnEndEvent` | No | types.ts:1151 |
| `message_start` | `MessageStartEvent` | No | types.ts:1152 |
| `message_update` | `MessageUpdateEvent` | No | types.ts:1153 |
| `message_end` | `MessageEndEvent` | Yes (result) | types.ts:1154 |
| `tool_execution_start` | `ToolExecutionStartEvent` | No | types.ts:1155 |
| `tool_execution_update` | `ToolExecutionUpdateEvent` | No | types.ts:1156 |
| `tool_execution_end` | `ToolExecutionEndEvent` | No | types.ts:1157 |
| `model_select` | `ModelSelectEvent` | No | types.ts:1158 |
| `thinking_level_select` | `ThinkingLevelSelectEvent` | No | types.ts:1159 |
| `tool_call` | `ToolCallEvent` (discriminated union by toolName) | Yes — `input` mutable | types.ts:1160 |
| `tool_result` | `ToolResultEvent` (discriminated union by toolName) | Yes (result) | types.ts:1161 |
| `user_bash` | `UserBashEvent` | Yes (result) | types.ts:1162 |
| `input` | `InputEvent` | Yes (result) | types.ts:1163 |

**Note on `tool_call` blocking:** The handler receives a mutable `event.input`
which can be patched in-place. The comment at types.ts:855 confirms: "Later
`tool_call` handlers see earlier mutations. No re-validation is performed after
mutation." This is the interception mechanism for tool calls.

---

## 8. Headless / non-interactive single-turn invocation

**Flag:** `--print` / `-p` (args.ts:14, parsed at args.ts:78)
**Also:** `--mode json` streams all events as newline-delimited JSON (args.ts:102)

Implemented in: `pi-fork/packages/coding-agent/src/modes/print-mode.ts`

```
pi --print "your prompt"          # text output, exit when done
pi --mode json "your prompt"      # NDJSON event stream, exit when done
pi --mode json                    # reads prompt from stdin when not a TTY
```

The `runPrintMode(runtimeHost, options)` function (print-mode.ts:32):
- Sends `initialMessage` via `session.prompt(...)` then any additional `messages`.
- In `text` mode: prints last assistant message's text content to stdout.
- In `json` mode: streams all `AgentSessionEvent` objects as JSON lines.
- Exits with code 0 on success, 1 on error.
- Also activates automatically when stdin or stdout is not a TTY (pipe detection,
  main.ts:105).

This mode is **confirmed** and is the gate for Task 5.

---

## 9. Proposed `SessionStorageBackend` interface

The target interface is a thin async abstraction over the append-only JSONL log.
`LogEntry` corresponds to `FileEntry` (session header or session entry).
`NewEntry` is the write payload (an already-constructed `SessionEntry` or
`SessionHeader` — Pi builds the full entry before calling `_persist`).

```typescript
/**
 * Pluggable storage backend for Pi session persistence.
 * Replaces local JSONL file I/O in SessionManager._persist() and
 * SessionManager.loadEntriesFromFile().
 *
 * Positions are 0-based integer offsets into the log (append count).
 * The first record written is at position 0.
 */
export interface SessionStorageBackend {
  /**
   * Append one entry to the named session log.
   * Returns the entry as stored (same object; backend may add storage metadata).
   */
  append(session_id: string, entry: FileEntry): Promise<FileEntry>;

  /**
   * Read entries for a session, optionally starting from a position offset.
   * fromPosition=0 returns all entries (default).
   */
  read(session_id: string, fromPosition?: number): Promise<FileEntry[]>;

  /**
   * Return the most recent compaction entry for a session, or null.
   * Used to fast-path context reconstruction on cold start.
   */
  latestCheckpoint(session_id: string): Promise<CompactionEntry | null>;

  /**
   * Return the current append-count (next position index) for a session.
   * Returns 0 if session does not exist.
   */
  nextPosition(session_id: string): Promise<number>;

  /**
   * List all session IDs known to this backend.
   */
  list(): Promise<string[]>;
}
```

**Deviation from target shape:** The original proposal used `append(entry)` with
session_id implicit. Because `SessionManager` holds `sessionId` internally and
all static factory methods accept a `sessionDir`, the backend must be keyed by
`session_id` explicitly — a backend instance is shared, not per-session. The
`append` signature is therefore `append(session_id, entry)`. Also, `LogEntry`
is renamed to `FileEntry` to match Pi's exported type directly; the `NewEntry`
type is unnecessary since Pi constructs the full entry before persistence.

---

## 10. Plan-assumption drift

| Plan identifier | Status | Real name / notes |
|---|---|---|
| `appendEntry` (on SessionManager) | DIFFERENT | Pi does NOT have a public `appendEntry` method. The public API is `appendMessage()`, `appendCompaction()`, `appendCustomEntry()`, etc. `_appendEntry` is private. The `appendEntry` that appears in extension types (types.ts:1230) is on `PiRuntime` (the extension API object) — it lets extensions append a custom entry to the session log. |
| `getEntries` (on SessionManager) | MATCH | `getEntries(): SessionEntry[]` — line 1182 |
| `ReadOperations` | MATCH | Interface exists, exported — read.ts:43 |
| `WriteOperations` | MATCH | Interface exists, exported — write.ts:25 |
| `EditOperations` | MATCH | Interface exists, exported — edit.ts:74 |
| `BashOperations` | MATCH | Interface exists, exported — bash.ts:40 |
| `LsOperations` | MATCH | Interface exists, exported — ls.ts:32 |
| `GrepOperations` | MATCH | Interface exists, exported — grep.ts:51 |
| `FindOperations` | MATCH | Interface exists, exported — find.ts:41 |
| Operations injection via `createBashTool(cwd, { operations })` | MATCH | Pattern confirmed for all seven tools |
| `tool_call` event (blockable) | MATCH | Confirmed — mutable `event.input` |
| `tool_result` event | MATCH | Confirmed |
| `turn_end` event | MATCH | Confirmed |
| `session_compact` event | MATCH | Confirmed |
| `session_before_compact` event | MATCH | Confirmed (blockable/cancellable) |
| `session_shutdown` event | MATCH | Confirmed |
| Headless flag `--print` / `-p` | MATCH | Confirmed in args.ts:14 and print-mode.ts |
| `--mode json` (NDJSON stream) | ADDITIONAL | Not in plan; exists as a second headless mode — event stream rather than final-text only. Highly useful for the HTTP turn handler. |
| `spawnHook` for operations injection | ADDITIONAL | BashToolOptions has `spawnHook?: BashSpawnHook` (bash.ts:134) — rewrites command/cwd/env before spawn. Alternative injection path for bash (no subprocess replacement needed, just command rewriting). |
| `session_start` event | ADDITIONAL | Not in plan list; fires on startup/reload/new/resume/fork — needed for cold-start reconstruction. |
| `before_agent_start` event | ADDITIONAL | Fires after user submits prompt but before agent loop — useful for budget voter. |
| `context` event | ADDITIONAL | Fires before each LLM call, can mutate messages — useful for injecting reconstructed context. |
