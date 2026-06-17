import { describe, expect, it, vi } from "vitest";
import type { ExecInPod } from "../src/exec.js";
import type { K8sSandboxConfig } from "../src/config.js";
import {
  createPodReadOps,
  createPodWriteOps,
  createPodEditOps,
  createPodBashOps,
  createPodLsOps,
  createPodFindOps,
} from "../src/operations.js";

const cfg: K8sSandboxConfig = {
  pod: "sbx-0",
  namespace: "default",
  context: undefined,
  podCwd: "/workspace",
  headCwd: "/head",
};

/** Build a fake ExecInPod that returns scripted results and records calls. */
function fakeExec(result: { stdout?: string; exitCode?: number | null }) {
  const calls: Array<{ command: string; stdin?: string }> = [];
  const fn: ExecInPod = async (command, opts) => {
    calls.push({ command, stdin: opts?.stdin?.toString() });
    return { stdout: Buffer.from(result.stdout ?? ""), exitCode: result.exitCode ?? 0 };
  };
  return { fn, calls };
}

describe("read ops", () => {
  it("reads a file via cat with the mapped path", async () => {
    const { fn, calls } = fakeExec({ stdout: "hello" });
    const ops = createPodReadOps(fn, cfg);
    const buf = await ops.readFile("/head/a.txt");
    expect(buf.toString()).toBe("hello");
    expect(calls[0].command).toBe("cat '/workspace/a.txt'");
  });

  it("access rejects when test -r exits non-zero", async () => {
    const { fn } = fakeExec({ exitCode: 1 });
    const ops = createPodReadOps(fn, cfg);
    await expect(ops.access("/head/a.txt")).rejects.toThrow();
  });

  it("detectImageMimeType returns the type for an image, null otherwise", async () => {
    const img = createPodReadOps(fakeExec({ stdout: "image/png\n" }).fn, cfg);
    expect(await img.detectImageMimeType!("/head/x.png")).toBe("image/png");
    const txt = createPodReadOps(fakeExec({ stdout: "text/plain\n" }).fn, cfg);
    expect(await txt.detectImageMimeType!("/head/x.txt")).toBeNull();
  });
});

describe("write ops", () => {
  it("writes via base64 -d on stdin", async () => {
    const { fn, calls } = fakeExec({});
    const ops = createPodWriteOps(fn, cfg);
    await ops.writeFile("/head/a.txt", "hi");
    expect(calls[0].command).toBe("base64 -d > '/workspace/a.txt'");
    expect(calls[0].stdin).toBe(Buffer.from("hi").toString("base64"));
  });

  it("mkdir -p with the mapped dir", async () => {
    const { fn, calls } = fakeExec({});
    await createPodWriteOps(fn, cfg).mkdir("/head/sub");
    expect(calls[0].command).toBe("mkdir -p '/workspace/sub'");
  });
});

describe("edit ops", () => {
  it("access requires read AND write", async () => {
    const { fn, calls } = fakeExec({});
    await createPodEditOps(fn, cfg).access("/head/a.txt");
    expect(calls[0].command).toBe("test -r '/workspace/a.txt' && test -w '/workspace/a.txt'");
  });
});

describe("bash ops", () => {
  it("cds into the mapped cwd then runs the command, returning exitCode", async () => {
    const { fn, calls } = fakeExec({ exitCode: 0 });
    const ops = createPodBashOps(fn, cfg);
    const onData = vi.fn();
    const r = await ops.exec("echo hi", "/head", { onData });
    expect(calls[0].command).toBe("cd '/workspace' && echo hi");
    expect(r).toEqual({ exitCode: 0 });
  });

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

  it("drops env keys that are not valid POSIX names (no injection)", async () => {
    const { fn, calls } = fakeExec({ exitCode: 0 });
    const ops = createPodBashOps(fn, cfg);
    await ops.exec("true", "/head", {
      onData: vi.fn(),
      env: { GOOD: "1", "BAD KEY": "x", "PATH=/evil; rm -rf /": "y" },
    });
    expect(calls[0].command).toBe("cd '/workspace' && env GOOD='1' bash -c 'true'");
  });
});

describe("ls ops", () => {
  it("readdir splits lines and drops blanks", async () => {
    const { fn, calls } = fakeExec({ stdout: "a.txt\nb\n\n" });
    const entries = await createPodLsOps(fn, cfg).readdir("/head");
    expect(entries).toEqual(["a.txt", "b"]);
    expect(calls[0].command).toBe("ls -1A '/workspace'");
  });

  it("stat reports directory vs file", async () => {
    const dir = await createPodLsOps(fakeExec({ stdout: "DIR\n" }).fn, cfg).stat("/head/d");
    expect((await dir).isDirectory()).toBe(true);
    const file = await createPodLsOps(fakeExec({ stdout: "FILE\n" }).fn, cfg).stat("/head/f");
    expect((await file).isDirectory()).toBe(false);
  });
});

describe("find ops", () => {
  it("globs via find -name under the mapped cwd and strips ./", async () => {
    const { fn, calls } = fakeExec({ stdout: "./src/a.ts\n./b.ts\n" });
    const ops = createPodFindOps(fn, cfg);
    const results = await ops.glob("*.ts", "/head", { ignore: [], limit: 100 });
    expect(results).toEqual(["src/a.ts", "b.ts"]);
    expect(calls[0].command).toBe("cd '/workspace' && find . -type f -name '*.ts' 2>/dev/null | head -n 100");
  });
});
