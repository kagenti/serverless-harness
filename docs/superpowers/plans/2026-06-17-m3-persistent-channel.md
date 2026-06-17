# M3 Persistent Channel + Env Injection + Find Ignore-list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut per-operation `kubectl exec` latency with a persistent in-pod bash channel for fast request/response ops, inject Pi's per-command `env`, and make find honour the ignore list + `.gitignore` — all harness-side, `pi-fork` untouched.

**Architecture:** A new `persistentExecInPod` transport implements the existing M2 `ExecInPod` type, holding one long-lived `kubectl exec -i … -- bash` open and multiplexing commands over it via a base64-framed, nonce-bracketed protocol with a one-in-flight queue and transparent fallback to per-call exec. The extension routes the small request/response ops (read/write/edit/ls/find) to this channel and keeps bash/grep/`user_bash` on M2's per-call `kubectl exec`. Env injection happens at the bash-ops layer; find switches to `rg --files`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `child_process`, vitest, ripgrep (already in the pod image), `kubectl`.

**Spec:** `docs/specs/2026-06-17-m3-persistent-channel-design.md`

**Conventions (from M2):**
- Package: `packages/k8s-sandbox/`. Tests: vitest in `test/`, imports use `.js` extensions.
- Run one test file: `pnpm -C packages/k8s-sandbox exec vitest run test/<file>.test.ts`
- Run all package tests: `pnpm -C packages/k8s-sandbox test`
- Commits: conventional + **DCO sign-off** (`git commit -s`). No `Co-Authored-By` (use `Assisted-By` only in PR/whole-impl). Shell cwd resets between commands → use absolute paths or `git -C`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/k8s-sandbox/src/framing.ts` | **new (pure).** `wrapCommand(nonce, command, stdin?)` builds the bash stdin line(s); `FrameParser` consumes stdout chunks → `{nonce, stdout, exitCode}` frames. No process/cluster deps. |
| `packages/k8s-sandbox/src/persistent-exec.ts` | **new.** `buildPersistentKubectlArgs(config)` + `persistentExecInPod(config, {fallback, spawn?})` → `ExecInPod & {dispose}`. Owns the long-lived child, the queue, timeout/abort, fallback. |
| `packages/k8s-sandbox/src/operations.ts` | **edit.** `createPodBashOps`: env prefix. `createPodFindOps.glob`: `rg --files`. |
| `packages/k8s-sandbox/src/extension.ts` | **edit.** Two-tier routing (`fastExec`/`streamExec`) + dispose on `session_shutdown`. |
| `packages/k8s-sandbox/src/index.ts` | **edit.** Export `persistentExecInPod`. |
| `packages/k8s-sandbox/test/framing.test.ts` | **new.** wrapCommand + FrameParser tests. |
| `packages/k8s-sandbox/test/persistent-exec.test.ts` | **new.** Fake-`spawn` transport tests. |
| `packages/k8s-sandbox/test/operations.test.ts` | **edit.** Add env cases; rewrite the find case for `rg --files`. |
| `packages/k8s-sandbox/test/extension.test.ts` | **new.** Registration count + dispose-on-shutdown + inert-when-null. |
| `packages/k8s-sandbox/SMOKE.md` | **append.** M3 smoke results. |

`deploy/sandbox.yaml`, `config.ts`, `exec.ts`, `paths.ts`, `grep-tool.ts` are **unchanged**.

---

## Task 1: Framing protocol (`framing.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/framing.ts`
- Test: `packages/k8s-sandbox/test/framing.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/k8s-sandbox/test/framing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FrameParser, wrapCommand } from "../src/framing.js";

const SOH = "\x01";

describe("wrapCommand", () => {
  it("brackets base64 output with nonce markers and reports the command's exit code", () => {
    const line = wrapCommand("n1", "cat '/workspace/a.txt'");
    expect(line).toBe(
      `printf '${SOH}B%s\\n' n1; { cat '/workspace/a.txt'; } | base64; ` +
        `printf '${SOH}E%s %d\\n' n1 "\${PIPESTATUS[0]}"\n`,
    );
  });

  it("delivers stdin to the command via a nonce-delimited heredoc", () => {
    const line = wrapCommand("n2", "base64 -d > '/workspace/a.txt'", Buffer.from("aGk="));
    expect(line).toBe(
      `printf '${SOH}B%s\\n' n2; { base64 -d > '/workspace/a.txt' <<'${SOH}Hn2'\n` +
        `aGk=\n${SOH}Hn2\n} | base64; ` +
        `printf '${SOH}E%s %d\\n' n2 "\${PIPESTATUS[0]}"\n`,
    );
  });
});

describe("FrameParser", () => {
  const SOHb = SOH;
  function frame(nonce: string, payload: string, code: number): string {
    const b64 = Buffer.from(payload).toString("base64");
    return `${SOHb}B${nonce}\n${b64}\n${SOHb}E${nonce} ${code}\n`;
  }

  it("emits a complete frame in one chunk, base64-decoded", () => {
    const p = new FrameParser();
    const frames = p.push(Buffer.from(frame("n1", "hello", 0)));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ nonce: "n1", exitCode: 0 });
    expect(frames[0].stdout.toString()).toBe("hello");
  });

  it("waits for the end marker (no emit on a partial frame)", () => {
    const p = new FrameParser();
    const full = frame("n1", "hello", 0);
    expect(p.push(Buffer.from(full.slice(0, 10)))).toHaveLength(0);
    const rest = p.push(Buffer.from(full.slice(10)));
    expect(rest).toHaveLength(1);
    expect(rest[0].stdout.toString()).toBe("hello");
  });

  it("handles a split in the middle of the begin marker", () => {
    const p = new FrameParser();
    const full = frame("n7", "x", 0);
    const cut = 1; // mid "\x01B..."
    expect(p.push(Buffer.from(full.slice(0, cut)))).toHaveLength(0);
    expect(p.push(Buffer.from(full.slice(cut)))).toHaveLength(1);
  });

  it("emits multiple frames present in one chunk, preserving exit codes", () => {
    const p = new FrameParser();
    const frames = p.push(Buffer.from(frame("a", "one", 0) + frame("b", "two", 2)));
    expect(frames.map((f) => [f.nonce, f.stdout.toString(), f.exitCode])).toEqual([
      ["a", "one", 0],
      ["b", "two", 2],
    ]);
  });

  it("round-trips binary payloads (NUL and high bytes)", () => {
    const p = new FrameParser();
    const bin = Buffer.from([0x00, 0xff, 0x01, 0x42, 0x0a]);
    const b64 = bin.toString("base64");
    const frames = p.push(Buffer.from(`${SOHb}Bn1\n${b64}\n${SOHb}En1 0\n`));
    expect(frames[0].stdout.equals(bin)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/framing.test.ts`
Expected: FAIL — `Failed to resolve import "../src/framing.js"`.

- [ ] **Step 3: Implement `framing.ts`**

Create `packages/k8s-sandbox/src/framing.ts`:

```ts
// Wire protocol for the persistent in-pod bash channel. One long-lived `bash`
// reads commands from stdin and writes every command's output to one stdout
// stream, so each command's output is bracketed by nonce markers and
// base64-encoded. base64's alphabet ([A-Za-z0-9+/=] + "\n") cannot contain the
// \x01-prefixed markers, so framing is collision-proof and binary-safe.

const SOH = "\x01"; // marker lead byte; never appears in base64 output

export interface Frame {
  nonce: string;
  stdout: Buffer; // base64-decoded command stdout
  exitCode: number;
}

/**
 * Build the line(s) written to the session's stdin for one command.
 *
 * `command` is run verbatim; its stdout is base64-encoded between
 * `\x01B<nonce>` and `\x01E<nonce> <exit>` markers. The reported exit code is
 * the COMMAND's (`${PIPESTATUS[0]}`) — NOT base64's `$?`, which is ~always 0.
 *
 * When `stdin` is provided it is delivered to the command via a nonce-delimited
 * heredoc (a shared-stdin session can't pipe separate per-command stdin). The
 * command must be a single pipeline whose first stage consumes stdin (holds for
 * `base64 -d > <path>`).
 */
export function wrapCommand(nonce: string, command: string, stdin?: Buffer): string {
  const begin = `printf '${SOH}B%s\\n' ${nonce}; `;
  const end = `printf '${SOH}E%s %d\\n' ${nonce} "\${PIPESTATUS[0]}"\n`;
  if (stdin) {
    const h = `${SOH}H${nonce}`;
    return `${begin}{ ${command} <<'${h}'\n${stdin.toString()}\n${h}\n} | base64; ${end}`;
  }
  return `${begin}{ ${command}; } | base64; ${end}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chunk-fed parser that emits complete frames as bytes arrive. */
export class FrameParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      // latin1 keeps bytes 1:1 for the marker scan; payload is ASCII base64.
      const text = this.buf.toString("latin1");
      const begin = text.match(/\x01B(\S+)\n/);
      if (!begin) break;
      const nonce = begin[1];
      const bodyStart = begin.index! + begin[0].length;
      const endRe = new RegExp(`\\x01E${escapeRe(nonce)} (-?\\d+)\\n`);
      const after = text.slice(bodyStart);
      const end = after.match(endRe);
      if (!end) break; // frame not complete yet
      const b64 = after.slice(0, end.index!);
      frames.push({
        nonce,
        stdout: Buffer.from(b64.replace(/\s/g, ""), "base64"),
        exitCode: parseInt(end[1], 10),
      });
      this.buf = this.buf.subarray(bodyStart + end.index! + end[0].length);
    }
    return frames;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/framing.test.ts`
Expected: PASS (2 wrapCommand + 5 FrameParser).

- [ ] **Step 5: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/k8s-sandbox/src/framing.ts packages/k8s-sandbox/test/framing.test.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "feat(k8s-sandbox): add persistent-channel wire protocol (framing)"
```

---

## Task 2: Persistent transport (`persistent-exec.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/persistent-exec.ts`
- Test: `packages/k8s-sandbox/test/persistent-exec.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/k8s-sandbox/test/persistent-exec.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { K8sSandboxConfig } from "../src/config.js";
import type { ExecInPod } from "../src/exec.js";
import { buildPersistentKubectlArgs, persistentExecInPod } from "../src/persistent-exec.js";

const cfg: K8sSandboxConfig = {
  pod: "sbx-0",
  namespace: "team1",
  context: undefined,
  podCwd: "/workspace",
  headCwd: "/head",
};

const SOH = "\x01";
function frameFor(nonce: string, payload: string, code = 0): Buffer {
  const b64 = Buffer.from(payload).toString("base64");
  return Buffer.from(`${SOH}B${nonce}\n${b64}\n${SOH}E${nonce} ${code}\n`);
}

/** A fake ChildProcess: records stdin writes, lets the test push stdout/events. */
function makeFakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes: string[] = [];
  child.stdin = { write: (s: string) => (writes.push(s), true), end: vi.fn() };
  child.kill = vi.fn(() => child.emit("close", null));
  return { child, writes };
}

/** A spawn stub returning queued fake children and recording argv. */
function fakeSpawn(children: any[]) {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return children.shift();
  }) as any;
  return { spawn, calls };
}

function recordingFallback(result = { stdout: Buffer.from("FB"), exitCode: 7 }) {
  const calls: string[] = [];
  const fallback: ExecInPod = async (command) => (calls.push(command), result);
  return { fallback, calls };
}

afterEach(() => vi.useRealTimers());

describe("buildPersistentKubectlArgs", () => {
  it("execs a bare interactive bash (no -c) with namespace", () => {
    expect(buildPersistentKubectlArgs(cfg)).toEqual([
      "exec", "-i", "-n", "team1", "sbx-0", "--", "bash",
    ]);
  });
  it("includes --context when set", () => {
    expect(buildPersistentKubectlArgs({ ...cfg, context: "kind-x" })).toEqual([
      "exec", "-i", "-n", "team1", "--context", "kind-x", "sbx-0", "--", "bash",
    ]);
  });
});

describe("persistentExecInPod", () => {
  it("spawns once, writes the framed command, resolves from the matching frame", async () => {
    const { child, writes } = makeFakeChild();
    const { spawn, calls } = fakeSpawn([child]);
    const { fallback } = recordingFallback();
    const exec = persistentExecInPod(cfg, { fallback, spawn });

    const p = exec("cat '/workspace/a.txt'");
    expect(calls).toHaveLength(1); // lazy spawn happened
    expect(writes[0]).toContain("cat '/workspace/a.txt'");
    const nonce = writes[0].match(/\x01B(\S+)\\n/) ? "" : ""; // nonce read below
    child.stdout.emit("data", frameFor("n1", "hello", 0));
    expect(await p).toEqual({ stdout: Buffer.from("hello"), exitCode: 0 });
  });

  it("reuses one child across sequential calls (no second spawn)", async () => {
    const { child } = makeFakeChild();
    const { spawn, calls } = fakeSpawn([child]);
    const exec = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });

    const p1 = exec("echo a");
    child.stdout.emit("data", frameFor("n1", "a", 0));
    await p1;
    const p2 = exec("echo b");
    child.stdout.emit("data", frameFor("n2", "b", 0));
    await p2;
    expect(calls).toHaveLength(1);
  });

  it("serializes: the second command is not written until the first frame arrives", async () => {
    const { child, writes } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const exec = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });

    const p1 = exec("first");
    const p2 = exec("second");
    expect(writes).toHaveLength(1); // only first in flight
    child.stdout.emit("data", frameFor("n1", "", 0));
    await p1;
    expect(writes).toHaveLength(2); // second now written
    child.stdout.emit("data", frameFor("n2", "", 0));
    await p2;
  });

  it("falls back when the session dies mid-command", async () => {
    const { child } = makeFakeChild();
    const { spawn } = fakeSpawn([child, makeFakeChild().child]);
    const { fallback, calls } = recordingFallback();
    const exec = persistentExecInPod(cfg, { fallback, spawn });

    const p = exec("cat '/workspace/a.txt'");
    child.emit("error", new Error("broken pipe"));
    expect(await p).toEqual({ stdout: Buffer.from("FB"), exitCode: 7 });
    expect(calls).toEqual(["cat '/workspace/a.txt'"]);
  });

  it("times out: kills the child and rejects with timeout:<n>", async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const exec = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });

    const p = exec("sleep 999", { timeout: 2 });
    const assertion = expect(p).rejects.toThrow("timeout:2");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
  });

  it("aborts: kills the child and rejects with 'aborted'", async () => {
    const { child } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const exec = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });
    const ac = new AbortController();

    const p = exec("sleep 999", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(child.kill).toHaveBeenCalled();
  });

  it("dispose() kills the child and routes later calls to the fallback", async () => {
    const { child } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const { fallback, calls } = recordingFallback();
    const exec = persistentExecInPod(cfg, { fallback, spawn });

    const p1 = exec("echo a");
    child.stdout.emit("data", frameFor("n1", "a", 0));
    await p1;
    exec.dispose();
    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
    expect(await exec("echo later")).toEqual({ stdout: Buffer.from("FB"), exitCode: 7 });
    expect(calls).toEqual(["echo later"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/persistent-exec.test.ts`
Expected: FAIL — `Failed to resolve import "../src/persistent-exec.js"`.

- [ ] **Step 3: Implement `persistent-exec.ts`**

Create `packages/k8s-sandbox/src/persistent-exec.ts`:

```ts
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { K8sSandboxConfig } from "./config.js";
import type { ExecInPod } from "./exec.js";
import { FrameParser, wrapCommand } from "./framing.js";

/** argv for the long-lived session: a bare interactive `bash` (NOT `bash -c`). */
export function buildPersistentKubectlArgs(config: K8sSandboxConfig): string[] {
  const args = ["exec", "-i", "-n", config.namespace];
  if (config.context) args.push("--context", config.context);
  args.push(config.pod, "--", "bash");
  return args;
}

type SpawnFn = typeof nodeSpawn;
export type PersistentExec = ExecInPod & { dispose: () => void };

interface Inflight {
  nonce: string;
  /** resolve from a matching frame */
  done: (r: { stdout: Buffer; exitCode: number | null }) => void;
  /** channel died → caller retries via fallback */
  fail: (e: Error) => void;
}

/**
 * An ExecInPod backed by ONE long-lived `kubectl exec -i -- bash`. Commands are
 * multiplexed over the framed protocol (framing.ts), one in flight at a time.
 * Channel unavailability (spawn error, mid-command death) transparently retries
 * the op via `deps.fallback`; timeout/abort reject with M2-compatible errors.
 * The session is spawned lazily and torn down by dispose().
 */
export function persistentExecInPod(
  config: K8sSandboxConfig,
  deps: { fallback: ExecInPod; spawn?: SpawnFn },
): PersistentExec {
  const spawnFn = deps.spawn ?? nodeSpawn;
  let child: ChildProcess | null = null;
  let parser = new FrameParser();
  let inflight: Inflight | null = null;
  const queue: Array<() => void> = [];
  let seq = 0;
  let disposed = false;

  const killChild = () => {
    if (!child) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    child = null;
  };

  const pump = () => {
    if (inflight || queue.length === 0) return;
    queue.shift()!();
  };

  // Tear the session down and signal channel failure for any in-flight command.
  const failSession = (err: Error) => {
    killChild();
    parser = new FrameParser();
    const cur = inflight;
    inflight = null;
    cur?.fail(err);
    pump();
  };

  const ensureChild = () => {
    if (child || disposed) return;
    const c = spawnFn("kubectl", buildPersistentKubectlArgs(config), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = c;
    c.stdout!.on("data", (d: Buffer) => {
      for (const f of parser.push(d)) {
        if (inflight && f.nonce === inflight.nonce) {
          const cur = inflight;
          inflight = null;
          cur.done({ stdout: f.stdout, exitCode: f.exitCode });
          pump();
        }
      }
    });
    c.on("error", (e) => failSession(e instanceof Error ? e : new Error(String(e))));
    c.on("close", () => {
      if (inflight || queue.length) failSession(new Error("session closed"));
      else child = null;
    });
  };

  const exec: ExecInPod = (command, opts = {}) => {
    if (disposed) return deps.fallback(command, opts);
    return new Promise((resolve, reject) => {
      const start = () => {
        ensureChild();
        if (!child) {
          // spawn unavailable → fall back
          deps.fallback(command, opts).then(resolve, reject);
          return;
        }
        const nonce = `n${++seq}`;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        // timeout / abort: kill+reset the session and reject (NO fallback).
        const killAndReject = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          inflight = null;
          killChild();
          parser = new FrameParser();
          reject(err);
          pump();
        };
        function onAbort() {
          killAndReject(new Error("aborted"));
        }
        if (opts.signal?.aborted) return killAndReject(new Error("aborted"));
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        if (opts.timeout && opts.timeout > 0) {
          timer = setTimeout(() => killAndReject(new Error(`timeout:${opts.timeout}`)), opts.timeout * 1000);
        }
        inflight = {
          nonce,
          done: (r) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(r);
          },
          fail: () => {
            if (settled) return;
            settled = true;
            cleanup();
            deps.fallback(command, opts).then(resolve, reject);
          },
        };
        try {
          child.stdin!.write(wrapCommand(nonce, command, opts.stdin));
        } catch (e) {
          failSession(e instanceof Error ? e : new Error(String(e)));
        }
      };
      queue.push(start);
      pump();
    });
  };

  return Object.assign(exec, {
    dispose: () => {
      disposed = true;
      try {
        child?.stdin?.end();
      } catch {
        /* noop */
      }
      killChild();
      queue.length = 0;
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/persistent-exec.test.ts`
Expected: PASS (2 argv + 7 transport).

Note on the timeout test: `failSession`/`close` may fire after `killChild()` emits `close`; the `settled` guard and the `inflight=null` set in `killAndReject` keep the rejection single. If the close handler races, it sees `inflight===null` and `queue.length===0` and is a no-op.

- [ ] **Step 5: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/k8s-sandbox/src/persistent-exec.ts packages/k8s-sandbox/test/persistent-exec.test.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "feat(k8s-sandbox): add persistent kubectl-exec transport with fallback"
```

---

## Task 3: Env injection in `createPodBashOps`

**Files:**
- Modify: `packages/k8s-sandbox/src/operations.ts:64-74`
- Test: `packages/k8s-sandbox/test/operations.test.ts` (add cases to `describe("bash ops")`)

- [ ] **Step 1: Write the failing tests**

In `packages/k8s-sandbox/test/operations.test.ts`, add inside `describe("bash ops", ...)` (after the existing test):

```ts
  it("injects env as a non-leaking, per-invocation prefix when env is provided", async () => {
    const { fn, calls } = fakeExec({ exitCode: 0 });
    const ops = createPodBashOps(fn, cfg);
    await ops.exec("echo $FOO", "/head", { onData: vi.fn(), env: { FOO: "bar baz" } });
    expect(calls[0].command).toBe("cd '/workspace' && env FOO='bar baz' bash -c 'echo $FOO'");
  });

  it("skips env keys whose value is undefined", async () => {
    const { fn, calls } = fakeExec({ exitCode: 0 });
    const ops = createPodBashOps(fn, cfg);
    await ops.exec("true", "/head", { onData: vi.fn(), env: { A: "1", B: undefined } });
    expect(calls[0].command).toBe("cd '/workspace' && env A='1' bash -c 'true'");
  });

  it("emits the M2 form (no prefix) when env is absent or empty", async () => {
    const { fn, calls } = fakeExec({ exitCode: 0 });
    const ops = createPodBashOps(fn, cfg);
    await ops.exec("echo hi", "/head", { onData: vi.fn(), env: {} });
    expect(calls[0].command).toBe("cd '/workspace' && echo hi");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/operations.test.ts -t "bash ops"`
Expected: FAIL — the new assertions don't match (env dropped; current output is `cd '/workspace' && echo $FOO`).

- [ ] **Step 3: Implement the env prefix**

In `packages/k8s-sandbox/src/operations.ts`, replace `createPodBashOps` (lines 64-74) with:

```ts
export function createPodBashOps(exec: ExecInPod, cfg: K8sSandboxConfig): BashOperations {
  const q = mapper(cfg);
  return {
    // Pi passes `env` only to the bash tool. Inject it here (transport-agnostic)
    // as an `env VAR=val … bash -c <cmd>` prefix: scoped to this one invocation,
    // so nothing leaks across calls (M2 dropped env entirely — see git history).
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const pairs = env
        ? Object.entries(env)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${shQuote(String(v))}`)
        : [];
      const wrapped = pairs.length
        ? `cd ${q(cwd)} && env ${pairs.join(" ")} bash -c ${shQuote(command)}`
        : `cd ${q(cwd)} && ${command}`; // M2's exact form — unchanged when no env
      const r = await exec(wrapped, { onData, signal, timeout });
      return { exitCode: r.exitCode };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/operations.test.ts -t "bash ops"`
Expected: PASS (original + 3 new bash-ops cases).

- [ ] **Step 5: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/k8s-sandbox/src/operations.ts packages/k8s-sandbox/test/operations.test.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "feat(k8s-sandbox): inject per-command env for pod bash ops"
```

---

## Task 4: find on `rg --files` (ignore list + .gitignore)

**Files:**
- Modify: `packages/k8s-sandbox/src/operations.ts:94-110`
- Test: `packages/k8s-sandbox/test/operations.test.ts` (rewrite the `describe("find ops")` case)

- [ ] **Step 1: Rewrite the failing test**

In `packages/k8s-sandbox/test/operations.test.ts`, replace the entire `describe("find ops", ...)` block (currently asserting `find . -type f -name …`) with:

```ts
describe("find ops", () => {
  it("globs via rg --files, honouring the ignore list and stripping ./", async () => {
    const { fn, calls } = fakeExec({ stdout: "src/a.ts\nb.ts\n" });
    const ops = createPodFindOps(fn, cfg);
    const results = await ops.glob("*.ts", "/head", {
      ignore: ["**/node_modules/**", "**/.git/**"],
      limit: 100,
    });
    expect(results).toEqual(["src/a.ts", "b.ts"]);
    expect(calls[0].command).toBe(
      "cd '/workspace' && rg --files --hidden -g '*.ts' " +
        "-g '!**/node_modules/**' -g '!**/.git/**' | head -n 100",
    );
  });

  it("emits no ignore globs when the ignore list is empty", async () => {
    const { fn, calls } = fakeExec({ stdout: "" });
    const ops = createPodFindOps(fn, cfg);
    await ops.glob("*.go", "/head", { ignore: [], limit: 50 });
    expect(calls[0].command).toBe("cd '/workspace' && rg --files --hidden -g '*.go' | head -n 50");
  });

  it("exists uses test -e on the mapped path", async () => {
    const { fn, calls } = fakeExec({ exitCode: 0 });
    expect(await createPodFindOps(fn, cfg).exists("/head/x")).toBe(true);
    expect(calls[0].command).toBe("test -e '/workspace/x'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/operations.test.ts -t "find ops"`
Expected: FAIL — current `glob` emits `find . -type f -name '*.ts' …`, not `rg --files …`.

- [ ] **Step 3: Implement `rg --files`**

In `packages/k8s-sandbox/src/operations.ts`, replace `createPodFindOps` (lines 94-110) with:

```ts
export function createPodFindOps(exec: ExecInPod, cfg: K8sSandboxConfig): FindOperations {
  const q = mapper(cfg);
  return {
    exists: async (p) => (await exec(`test -e ${q(p)}`)).exitCode === 0,
    // `rg --files` lists files honouring .gitignore by default (matching Pi's
    // local `fd` — "respects .gitignore"); --hidden keeps dotfiles in view while
    // gitignore still applies. Each Pi `ignore` entry becomes a negated glob.
    // Paths come back relative to cwd; strip any leading "./" defensively.
    glob: async (pattern, cwd, { ignore, limit }) => {
      const globs = [`-g ${shQuote(pattern)}`, ...ignore.map((ig) => `-g ${shQuote(`!${ig}`)}`)];
      const r = await exec(`cd ${q(cwd)} && rg --files --hidden ${globs.join(" ")} | head -n ${limit}`);
      return r.stdout
        .toString()
        .split("\n")
        .filter((x) => x.length > 0)
        .map((rel) => rel.replace(/^\.\//, ""));
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/operations.test.ts -t "find ops"`
Expected: PASS (3 find-ops cases).

- [ ] **Step 5: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/k8s-sandbox/src/operations.ts packages/k8s-sandbox/test/operations.test.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "feat(k8s-sandbox): route find through rg --files (ignore + gitignore)"
```

---

## Task 5: Two-tier extension wiring + dispose on shutdown

**Files:**
- Modify: `packages/k8s-sandbox/src/extension.ts`
- Modify: `packages/k8s-sandbox/src/index.ts`
- Test: `packages/k8s-sandbox/test/extension.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `packages/k8s-sandbox/test/extension.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { K8sSandboxConfig } from "../src/config.js";
import type { ExecInPod } from "../src/exec.js";
import { k8sSandboxExtension } from "../src/extension.js";

const cfg: K8sSandboxConfig = {
  pod: "sbx-0",
  namespace: "default",
  context: undefined,
  podCwd: "/workspace",
  headCwd: "/head",
};

/** Minimal ExtensionAPI stub recording registrations + event handlers. */
function fakePi() {
  const tools: unknown[] = [];
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const pi = {
    registerTool: (t: unknown) => tools.push(t),
    on: (name: string, h: (...a: unknown[]) => unknown) => {
      handlers[name] = h;
    },
  } as unknown as Parameters<ReturnType<typeof k8sSandboxExtension>>[0];
  return { pi, tools, handlers };
}

describe("k8sSandboxExtension", () => {
  it("registers the seven pod tools and wires the lifecycle handlers", () => {
    const exec: ExecInPod = async () => ({ stdout: Buffer.from(""), exitCode: 0 });
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, exec })(pi);
    expect(tools).toHaveLength(7);
    expect(typeof handlers.user_bash).toBe("function");
    expect(typeof handlers.before_agent_start).toBe("function");
    expect(typeof handlers.session_shutdown).toBe("function");
  });

  it("disposes the fast channel on session_shutdown when it exposes dispose()", () => {
    const dispose = vi.fn();
    const exec = Object.assign(async () => ({ stdout: Buffer.from(""), exitCode: 0 }), { dispose }) as ExecInPod;
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, exec })(pi);
    handlers.session_shutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is inert (registers nothing) when config is null", () => {
    const { pi, tools } = fakePi();
    k8sSandboxExtension({ config: null })(pi);
    expect(tools).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/extension.test.ts`
Expected: FAIL — no `session_shutdown` handler yet (the dispose test fails / `handlers.session_shutdown` is undefined).

- [ ] **Step 3: Implement the two-tier wiring**

Replace `packages/k8s-sandbox/src/extension.ts` in full with:

```ts
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { type K8sSandboxConfig, resolveConfig } from "./config.js";
import { type ExecInPod, kubectlExecInPod } from "./exec.js";
import { persistentExecInPod } from "./persistent-exec.js";
import {
  createPodBashOps,
  createPodEditOps,
  createPodFindOps,
  createPodLsOps,
  createPodReadOps,
  createPodWriteOps,
} from "./operations.js";
import { createPodGrepTool } from "./grep-tool.js";

/**
 * Pi extension that overrides the seven built-in tools so file/search/exec run
 * in a remote Kubernetes pod. Inert (local tools stand) unless a sandbox is
 * configured.
 *
 * Two-tier transport:
 *  - fastExec: a persistent in-pod bash channel for the small request/response
 *    ops (read/write/edit/ls/find), with transparent fallback to per-call exec.
 *  - streamExec: M2's per-call `kubectl exec` for the streaming/long-running ops
 *    (bash, grep, user `!`), which need onData/abort/long-running semantics.
 *
 * @param opts.config Explicit config; if omitted, resolved from process.env.
 *                    Pass `null` to force-disable.
 * @param opts.exec   Override BOTH transports (used by tests / alternate auth).
 */
export function k8sSandboxExtension(opts?: {
  config?: K8sSandboxConfig | null;
  exec?: ExecInPod;
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const localCwd = process.cwd();
    const config =
      opts?.config !== undefined ? opts.config : resolveConfig(process.env, localCwd);
    if (!config) return; // off gate — local tools stand

    const streamExec = opts?.exec ?? kubectlExecInPod(config);
    const fastExec =
      opts?.exec ?? persistentExecInPod(config, { fallback: kubectlExecInPod(config) });

    // Fast request/response ops → persistent channel.
    pi.registerTool(createReadTool(localCwd, { operations: createPodReadOps(fastExec, config) }));
    pi.registerTool(createWriteTool(localCwd, { operations: createPodWriteOps(fastExec, config) }));
    pi.registerTool(createEditTool(localCwd, { operations: createPodEditOps(fastExec, config) }));
    pi.registerTool(createLsTool(localCwd, { operations: createPodLsOps(fastExec, config) }));
    pi.registerTool(createFindTool(localCwd, { operations: createPodFindOps(fastExec, config) }));

    // Streaming / long-running ops → per-call kubectl exec (M2 path, unchanged).
    pi.registerTool(createBashTool(localCwd, { operations: createPodBashOps(streamExec, config) }));
    pi.registerTool(createPodGrepTool(localCwd, streamExec, config));
    pi.on("user_bash", () => ({ operations: createPodBashOps(streamExec, config) }));

    // Tell the model its cwd is the pod's, not the head's.
    pi.on("before_agent_start", (event) => {
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${config.podCwd} (sandbox pod ${config.namespace}/${config.pod})`,
      );
      return { systemPrompt: modified };
    });

    // Tear down the persistent kubectl process so it is never leaked.
    pi.on("session_shutdown", () => {
      const maybe = fastExec as ExecInPod & { dispose?: () => void };
      if (typeof maybe.dispose === "function") maybe.dispose();
    });
  };
}
```

- [ ] **Step 4: Export the transport from the package index**

In `packages/k8s-sandbox/src/index.ts`, add after the `exec.js` export line:

```ts
export { buildPersistentKubectlArgs, persistentExecInPod, type PersistentExec } from "./persistent-exec.js";
```

- [ ] **Step 5: Run the extension tests to verify they pass**

Run: `pnpm -C packages/k8s-sandbox exec vitest run test/extension.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 6: Run the full package suite (M2 + M3 all green)**

Run: `pnpm -C packages/k8s-sandbox test`
Expected: PASS — framing (7), persistent-exec (9), operations (paths/read/write/edit/bash incl. env, ls, find), config, exec, extension. No failures.

- [ ] **Step 7: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/k8s-sandbox/src/extension.ts packages/k8s-sandbox/src/index.ts packages/k8s-sandbox/test/extension.test.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "feat(k8s-sandbox): two-tier transport routing + dispose persistent channel"
```

---

## Task 6: Real kind smoke

**Files:**
- Modify: `packages/k8s-sandbox/SMOKE.md` (append an M3 section)

Goal: on a real kind cluster, prove the three M3 claims — (1) a burst of fast ops reuses **one** kubectl process, (2) an env var set on a bash call is visible in the pod, (3) find honours `.gitignore` + the ignore list. This task is run by a human/operator against a live cluster; record the actual results.

- [ ] **Step 1: Ensure a sandbox pod and gateway env**

Run (redirect noisy output per the repo context-budget rule):

```bash
export LOG_DIR=/tmp/kagenti/m3-smoke; mkdir -p $LOG_DIR
kubectl apply -f /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox/deploy/sandbox.yaml > $LOG_DIR/apply.log 2>&1; echo "EXIT:$?"
kubectl rollout status deploy/sandbox --timeout=120s > $LOG_DIR/rollout.log 2>&1; echo "EXIT:$?"
POD=$(kubectl get pod -l app=sandbox -o jsonpath='{.items[0].metadata.name}'); echo "POD=$POD"
```

Expected: `EXIT:0` for both; `POD=sandbox-...`. Gateway env (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) and `sh-redis` on :6379 present (M1/M2 setup).

- [ ] **Step 2: Seed pod fixtures for find (gitignore + node_modules)**

```bash
kubectl exec "$POD" -- bash -lc '
  cd /workspace &&
  mkdir -p src node_modules/pkg .git &&
  printf "node_modules/\n" > .gitignore &&
  : > src/keep.ts && : > node_modules/pkg/skip.ts && : > .git/cfg.ts &&
  : > top.ts
' > $LOG_DIR/seed.log 2>&1; echo "EXIT:$?"
```

Expected: `EXIT:0`.

- [ ] **Step 3: Drive a headless turn that triggers a burst of fast ops + an env bash call**

Set the sandbox env and run the harness headless against the pod, asking the agent to (a) list/read several files (fast ops), (b) run a bash command echoing an injected env var, (c) find `*.ts` files:

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
KAGENTI_SANDBOX_POD="$POD" KAGENTI_SANDBOX_CONTEXT="kind-kagenti" \
  pnpm -C harness exec tsx src/cli.ts -p \
  "Run: ls /workspace; read /workspace/.gitignore; then run the bash command 'echo MARKER=\$M3_SMOKE' (M3_SMOKE is set); then find *.ts files under /workspace. Report what you saw." \
  > $LOG_DIR/run.log 2>&1; echo "EXIT:$?"
```

(If the headless CLI needs a different flag/entrypoint than M2's smoke used, mirror M2's `SMOKE.md` invocation. The env var the agent must see is provided to the bash tool by Pi; to inject `M3_SMOKE`, pass it through whatever per-call env Pi forwards — for a manual check you may instead instruct the agent to run `echo MARKER=$M3_SMOKE` after the harness sets it via the bash tool env path.)

- [ ] **Step 4: Verify the three claims (use a subagent to scan the log, per context-budget rule)**

Dispatch an Explore subagent:

> Use Grep (with `-C 2`) on `$LOG_DIR/run.log`. Confirm and report: (1) the find result lists `src/keep.ts` and `top.ts` but NOT `node_modules/pkg/skip.ts` or `.git/cfg.ts` (gitignore + ignore-list honoured); (2) a line `MARKER=` shows the injected env value (env injection works); (3) no errors/tracebacks. Return the matching lines only, not the whole file.

For claim (1)-process-reuse: confirm a single persistent session served the burst. Quick external check — while a run is active, `kubectl get pod "$POD" -o jsonpath='{range .status..}{end}'` won't show it; instead rely on the temporary spawn log: add a one-line `console.error("spawned persistent session")` in `ensureChild` for the smoke run and assert it appears exactly once in `$LOG_DIR/run.log` for the multi-read burst, then revert the log line. Record the count.

- [ ] **Step 5: Record results in `SMOKE.md`**

Append an `## M3 smoke (YYYY-MM-DD)` section to `packages/k8s-sandbox/SMOKE.md` capturing: pod name, cluster/context, the find output (kept vs excluded), the `MARKER=` line, the single-spawn count, and a PASS/FAIL verdict. Keep it factual (mirror the M2 section's format).

- [ ] **Step 6: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/k8s-sandbox/SMOKE.md
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "test(k8s-sandbox): record M3 persistent-channel + env + find smoke"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §2 D1 persistent transport T1 → Task 2 (`persistentExecInPod`, bare `bash`). ✅
- §2 D2 S-fast scope (fast ops persistent, bash/grep per-call) → Task 5 routing. ✅
- §2 D3 framing (sentinel + base64 + `${PIPESTATUS[0]}`, one-in-flight) → Task 1 + Task 2 queue. ✅
- §2 D4 env at bash-ops layer, no signature change → Task 3. ✅
- §2 D5 find on `rg --files` → Task 4. ✅
- §2 D6 transparent fallback (spawn fail + mid-command death, non-zero exit passes through) → Task 2 tests + impl. ✅
- §2 D7 dispose on `session_shutdown`, lazy spawn → Task 2 (lazy `ensureChild`, `dispose`) + Task 5 (`session_shutdown`). ✅
- §3.1 per-command stdin via heredoc → Task 1 `wrapCommand(stdin)` + test. ✅
- §3.3 no new config → no config.ts task (intentional). ✅
- §6 verification gate (framing pure tests; fake-spawn transport tests incl. fallback/timeout/abort/dispose; operations env + find; M2 green; one kind smoke) → Tasks 1–6. ✅
- §5 error-handling table (timeout/abort reject; channel death → fallback; non-zero exit pass-through) → Task 2 tests. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The smoke task (Task 6) records live results at execution time — that is data, not a code placeholder (mirrors M2's smoke task). ✅

**Type consistency:** `ExecInPod` (from `exec.ts`) reused unchanged; `persistentExecInPod` returns `ExecInPod & { dispose }` (`PersistentExec`); `wrapCommand(nonce, command, stdin?)` and `FrameParser.push → Frame[]` signatures match across Tasks 1, 2, 5; `buildPersistentKubectlArgs` name consistent in impl/test/index; `createPodBashOps`/`createPodFindOps` keep their M2 signatures. ✅

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
