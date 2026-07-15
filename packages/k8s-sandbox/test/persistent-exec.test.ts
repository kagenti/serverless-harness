import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { K8sSandboxConfig } from "../src/config.js";
import type { ExecInPod } from "../src/transport.js";
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
    const t = persistentExecInPod(cfg, { fallback, spawn });

    const p = t.exec("cat '/workspace/a.txt'");
    expect(calls).toHaveLength(1); // lazy spawn happened
    expect(writes[0]).toContain("cat '/workspace/a.txt'");
    child.stdout.emit("data", frameFor("n1", "hello", 0));
    expect(await p).toEqual({ stdout: Buffer.from("hello"), exitCode: 0 });
  });

  it("reuses one child across sequential calls (no second spawn)", async () => {
    const { child } = makeFakeChild();
    const { spawn, calls } = fakeSpawn([child]);
    const t = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });

    const p1 = t.exec("echo a");
    child.stdout.emit("data", frameFor("n1", "a", 0));
    await p1;
    const p2 = t.exec("echo b");
    child.stdout.emit("data", frameFor("n2", "b", 0));
    await p2;
    expect(calls).toHaveLength(1);
  });

  it("serializes: the second command is not written until the first frame arrives", async () => {
    const { child, writes } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const t = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });

    const p1 = t.exec("first");
    const p2 = t.exec("second");
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
    const t = persistentExecInPod(cfg, { fallback, spawn });

    const p = t.exec("cat '/workspace/a.txt'");
    child.emit("error", new Error("broken pipe"));
    expect(await p).toEqual({ stdout: Buffer.from("FB"), exitCode: 7 });
    expect(calls).toEqual(["cat '/workspace/a.txt'"]);
  });

  it("times out: kills the child and rejects with timeout:<n>", async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const t = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });

    const p = t.exec("sleep 999", { timeout: 2 });
    const assertion = expect(p).rejects.toThrow("timeout:2");
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(child.kill).toHaveBeenCalled();
  });

  it("aborts: kills the child and rejects with 'aborted'", async () => {
    const { child } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const t = persistentExecInPod(cfg, { fallback: recordingFallback().fallback, spawn });
    const ac = new AbortController();

    const p = t.exec("sleep 999", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(child.kill).toHaveBeenCalled();
  });

  it("close() kills the child and routes later calls to the fallback", async () => {
    const { child } = makeFakeChild();
    const { spawn } = fakeSpawn([child]);
    const { fallback, calls } = recordingFallback();
    const t = persistentExecInPod(cfg, { fallback, spawn });

    const p1 = t.exec("echo a");
    child.stdout.emit("data", frameFor("n1", "a", 0));
    await p1;
    await t.close();
    expect(child.stdin.end).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalled();
    expect(await t.exec("echo later")).toEqual({ stdout: Buffer.from("FB"), exitCode: 7 });
    expect(calls).toEqual(["echo later"]);
  });
});
