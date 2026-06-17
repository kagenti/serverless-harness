# M2 K8sSandboxClient Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Pi's tool execution (read/write/edit/bash/ls/grep/find) to a remote Kubernetes pod via `kubectl exec`, so the agent's "hands" run in the sandbox rather than on the harness head.

**Architecture:** A new standalone `@sh/k8s-sandbox` package exposes an injectable `execInPod` transport (default = shell out to `kubectl exec -i … -- bash -c <cmd>`), seven pod-backed Pi `Operations` factories, and a Pi extension that registers/overrides the seven built-in tools. The extension is wired into the headless `harness/cli.ts` via `extensionFactories`, env-gated so it is inert unless `KAGENTI_SANDBOX_POD` is set. **No pi-fork change** — Pi's `Operations` seam is native; the one exception is `grep`, whose search hardwires a local `rg`, so its tool gets an `execute` override that runs `rg` in the pod.

**Tech Stack:** TypeScript (ESM), pnpm workspaces, vitest, Pi (`@earendil-works/pi-coding-agent` via `link:`), `kubectl`, a kind cluster for the smoke.

---

## Design reference

Spec: [`docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md`](../../specs/2026-06-17-m2-k8s-sandbox-client-design.md)

**Verified facts this plan relies on (from reading pi-fork source at submodule `7acc67a`):**

- `createReadTool` / `createWriteTool` / `createEditTool` / `createBashTool` / `createLsTool` / `createFindTool` / `createGrepTool` are exported from `@earendil-works/pi-coding-agent` and each takes `(cwd, { operations })`. (`packages/coding-agent/src/index.ts`)
- `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `FindOperations`, `GrepOperations` are exported types with the shapes used below. (`src/core/tools/*.ts`)
- `find`'s `execute` **uses `customOps.glob` instead of `fd` when supplied** (`src/core/tools/find.ts:154-164`) → operations route the search to the pod.
- `grep`'s `execute` **always spawns local `rg`** even when operations are supplied (`src/core/tools/grep.ts:172,221`); operations only cover `isDirectory`/`readFile` for context lines → grep needs an `execute` override. Its success result shape is `{ content: [{ type: "text", text }], details: undefined }` (`grep.ts:311`).
- The SSH example (`examples/extensions/ssh.ts`) is the delegation template: register a tool, delegate `execute` to a tool built with remote operations; intercept `user_bash` returning `{ operations }`; rewrite the announced cwd in `before_agent_start` returning `{ systemPrompt }`.
- `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`; `pi.registerTool(tool)` accepts an `AgentTool` (the SSH example passes the object returned by `create*Tool`). (`src/core/extensions/types.ts:1416,1170`)
- Headless wiring uses `DefaultResourceLoader({ extensionFactories: [...] })` — there are **no CLI flags** on the headless path (`harness/src/cli.ts:54-60`). Config comes from env / factory argument.

---

## File structure

```
packages/k8s-sandbox/
  package.json          # @sh/k8s-sandbox; links pi-coding-agent; vitest
  tsconfig.json         # mirrors session-backend if present, else minimal ESM
  src/
    index.ts            # public exports
    paths.ts            # shQuote(), mapPath() — pure helpers
    config.ts           # K8sSandboxConfig, resolveConfig() (env gate)
    exec.ts             # ExecInPod type, buildKubectlArgs(), kubectlExecInPod()
    operations.ts       # createPod{Read,Write,Edit,Bash,Ls,Find}Ops
    grep-tool.ts        # createPodGrepTool() — execute override (rg in-pod)
    extension.ts        # k8sSandboxExtension() — registers the 7 tools, gated
  deploy/
    sandbox.yaml        # plain Deployment + PVC fixture
  test/
    paths.test.ts
    config.test.ts
    exec.test.ts
    operations.test.ts
harness/
  package.json          # + "@sh/k8s-sandbox": "workspace:*"
  src/cli.ts            # + k8sSandboxExtension() in extensionFactories
```

Unit tests (`paths`, `config`, `exec` argv builder, `operations` with a fake `ExecInPod`) are **cluster-free and build-free** — they import only erased types from Pi. `grep-tool.ts` and `extension.ts` import Pi runtime factories and are exercised by the real kind smoke (Task 11), not unit tests.

---

## Task 1: Discovery note — confirm grep/find routing empirically

**Files:**
- Create: `packages/k8s-sandbox/NOTES-pi-operations.md`

- [ ] **Step 1: Read the two execute paths and confirm the facts**

Run:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness/pi-fork
sed -n '150,170p' packages/coding-agent/src/core/tools/find.ts   # custom glob replaces fd
sed -n '170,225p' packages/coding-agent/src/core/tools/grep.ts   # rg spawned locally regardless
```
Expected: `find.ts` shows `if (customOps?.glob) { … return … }` before the `fd` path; `grep.ts` shows `const child = spawn(rgPath, args, …)` with no operations override of the search itself.

- [ ] **Step 2: Write the note**

Create `packages/k8s-sandbox/NOTES-pi-operations.md`:
```markdown
# Pi Operations routing — grep/find findings (pi-fork @ 7acc67a)

Confirms the M2 design's §4.1 load-bearing risk.

## find — operations SUFFICE
`createFindToolDefinition.execute` (src/core/tools/find.ts:154-164): when
`options.operations.glob` is provided it is used INSTEAD of `fd`. Supplying a
custom `glob` that shells out in-pod fully routes find's search to the pod.
Return: array of paths (relative to the search cwd is accepted).

## grep — operations DO NOT suffice
`createGrepToolDefinition.execute` (src/core/tools/grep.ts): always
`spawn(rgPath, args)` against the LOCAL filesystem (line ~221). `operations`
only feeds `isDirectory` (path check) and `readFile` (context lines). So grep's
search runs on the head regardless of operations.
Decision: route grep by OVERRIDING the tool's `execute` to run `rg` IN the pod
via execInPod, and return grep's result shape:
  { content: [{ type: "text", text }], details: undefined }
(grep.ts:311 for the success/no-match shape.)

## bash/read/write/edit/ls — operations SUFFICE (standard pattern, per SSH example).
```

- [ ] **Step 3: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/NOTES-pi-operations.md
git commit -m "docs(k8s-sandbox): record grep/find Operations routing findings"
```

---

## Task 2: Scaffold the `@sh/k8s-sandbox` package

**Files:**
- Create: `packages/k8s-sandbox/package.json`
- Create: `packages/k8s-sandbox/tsconfig.json`
- Create: `packages/k8s-sandbox/src/index.ts`

- [ ] **Step 1: Write `package.json`**

Create `packages/k8s-sandbox/package.json` (mirrors `@sh/session-backend`, adds the Pi link needed for tool-factory types):
```json
{
  "name": "@sh/k8s-sandbox",
  "type": "module",
  "version": "0.0.0",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "link:../pi-fork/packages/coding-agent"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

Create `packages/k8s-sandbox/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write a placeholder `src/index.ts`**

Create `packages/k8s-sandbox/src/index.ts`:
```ts
// Public surface — populated by later tasks.
export {};
```

- [ ] **Step 4: Install workspace deps**

The workspace already globs `packages/*` (`pnpm-workspace.yaml`), so no edit there.
Run:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
pnpm install > /tmp/k8s-sandbox-install.log 2>&1; echo "EXIT:$?"
```
Expected: EXIT:0; `packages/k8s-sandbox/node_modules` now exists (symlinked `vitest`, `typescript`, and the linked Pi package).

- [ ] **Step 5: Verify the empty test runner works**

Run:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm test 2>&1 | tail -5; echo "EXIT:${PIPESTATUS[0]}"
```
Expected: vitest reports "No test files found" (exit is non-zero but that's fine — it confirms vitest resolves). Proceed.

- [ ] **Step 6: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/package.json packages/k8s-sandbox/tsconfig.json packages/k8s-sandbox/src/index.ts pnpm-lock.yaml
git commit -m "chore(k8s-sandbox): scaffold @sh/k8s-sandbox package"
```

---

## Task 3: Path helpers (`paths.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/paths.ts`
- Test: `packages/k8s-sandbox/test/paths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/k8s-sandbox/test/paths.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mapPath, shQuote } from "../src/paths.js";

describe("shQuote", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shQuote("/workspace/a.txt")).toBe("'/workspace/a.txt'");
  });
  it("escapes embedded single quotes", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("mapPath", () => {
  it("rewrites a head-cwd prefix to the pod cwd", () => {
    expect(mapPath("/Users/dev/proj/src/a.ts", "/Users/dev/proj", "/workspace")).toBe("/workspace/src/a.ts");
  });
  it("rewrites the head cwd itself", () => {
    expect(mapPath("/Users/dev/proj", "/Users/dev/proj", "/workspace")).toBe("/workspace");
  });
  it("leaves paths outside the head cwd untouched", () => {
    expect(mapPath("/etc/hosts", "/Users/dev/proj", "/workspace")).toBe("/etc/hosts");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/paths.test.ts 2>&1 | tail -8`
Expected: FAIL — cannot resolve `../src/paths.js`.

- [ ] **Step 3: Implement `paths.ts`**

Create `packages/k8s-sandbox/src/paths.ts`:
```ts
/** Single-quote a string for safe interpolation into a `bash -c` command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrite an absolute head path into the pod's filesystem by swapping the
 * head cwd prefix for the pod cwd. Paths outside the head cwd are returned
 * unchanged (mirrors the SSH example's naive prefix replace).
 */
export function mapPath(p: string, headCwd: string, podCwd: string): string {
  if (p === headCwd) return podCwd;
  if (p.startsWith(headCwd + "/")) return podCwd + p.slice(headCwd.length);
  return p;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/paths.test.ts 2>&1 | tail -8`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/src/paths.ts packages/k8s-sandbox/test/paths.test.ts
git commit -m "feat(k8s-sandbox): add shQuote and mapPath helpers"
```

---

## Task 4: Config + env gate (`config.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/config.ts`
- Test: `packages/k8s-sandbox/test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/k8s-sandbox/test/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("returns null when KAGENTI_SANDBOX_POD is unset (the off gate)", () => {
    expect(resolveConfig({}, "/head")).toBeNull();
  });

  it("applies defaults when only the pod is set", () => {
    const cfg = resolveConfig({ KAGENTI_SANDBOX_POD: "sbx-0" }, "/head");
    expect(cfg).toEqual({
      pod: "sbx-0",
      namespace: "default",
      context: undefined,
      podCwd: "/workspace",
      headCwd: "/head",
    });
  });

  it("honours all overrides", () => {
    const cfg = resolveConfig(
      {
        KAGENTI_SANDBOX_POD: "sbx-0",
        KAGENTI_SANDBOX_NAMESPACE: "team1",
        KAGENTI_SANDBOX_CONTEXT: "kind-kagenti",
        KAGENTI_SANDBOX_CWD: "/repo",
      },
      "/head",
    );
    expect(cfg).toEqual({
      pod: "sbx-0",
      namespace: "team1",
      context: "kind-kagenti",
      podCwd: "/repo",
      headCwd: "/head",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/config.test.ts 2>&1 | tail -8`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Implement `config.ts`**

Create `packages/k8s-sandbox/src/config.ts`:
```ts
export interface K8sSandboxConfig {
  /** Pod name to exec into. */
  pod: string;
  /** Kubernetes namespace. */
  namespace: string;
  /** kube context, or undefined to use current-context. */
  context: string | undefined;
  /** Working directory inside the pod (announced to the model). */
  podCwd: string;
  /** The harness process cwd; head paths under it map to podCwd. */
  headCwd: string;
}

/**
 * Resolve sandbox config from environment. Returns null when
 * KAGENTI_SANDBOX_POD is unset — the gate that keeps the extension inert
 * (all tools run locally) unless a sandbox pod is explicitly configured.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, headCwd: string): K8sSandboxConfig | null {
  const pod = env.KAGENTI_SANDBOX_POD;
  if (!pod) return null;
  return {
    pod,
    namespace: env.KAGENTI_SANDBOX_NAMESPACE ?? "default",
    context: env.KAGENTI_SANDBOX_CONTEXT || undefined,
    podCwd: env.KAGENTI_SANDBOX_CWD ?? "/workspace",
    headCwd,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/config.test.ts 2>&1 | tail -8`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/src/config.ts packages/k8s-sandbox/test/config.test.ts
git commit -m "feat(k8s-sandbox): add config resolution with env gate"
```

---

## Task 5: Transport seam — `buildKubectlArgs` + `ExecInPod` (`exec.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/exec.ts`
- Test: `packages/k8s-sandbox/test/exec.test.ts`

Only the pure `buildKubectlArgs` is unit-tested; `kubectlExecInPod` (spawns a real process) is exercised by the kind smoke in Task 11.

- [ ] **Step 1: Write the failing test**

Create `packages/k8s-sandbox/test/exec.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildKubectlArgs } from "../src/exec.js";
import type { K8sSandboxConfig } from "../src/config.js";

const base: K8sSandboxConfig = {
  pod: "sbx-0",
  namespace: "team1",
  context: undefined,
  podCwd: "/workspace",
  headCwd: "/head",
};

describe("buildKubectlArgs", () => {
  it("builds an interactive exec with namespace and bash -c", () => {
    expect(buildKubectlArgs(base, "cat '/workspace/a.txt'")).toEqual([
      "exec", "-i", "-n", "team1", "sbx-0", "--", "bash", "-c", "cat '/workspace/a.txt'",
    ]);
  });

  it("includes --context when set", () => {
    expect(buildKubectlArgs({ ...base, context: "kind-kagenti" }, "true")).toEqual([
      "exec", "-i", "-n", "team1", "--context", "kind-kagenti", "sbx-0", "--", "bash", "-c", "true",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/exec.test.ts 2>&1 | tail -8`
Expected: FAIL — cannot resolve `../src/exec.js`.

- [ ] **Step 3: Implement `exec.ts`**

Create `packages/k8s-sandbox/src/exec.ts`:
```ts
import { spawn } from "node:child_process";
import type { K8sSandboxConfig } from "./config.js";

/**
 * Run one command inside the sandbox pod (as `bash -c <command>`).
 * stdout is collected and returned; stderr is streamed to onData (with stdout)
 * but NOT included in `stdout`, so file ops get clean bytes. Pass `stdin` to
 * feed data (e.g. base64 for writes). `onData` streams output for bash.
 */
export type ExecInPod = (
  command: string,
  opts?: {
    stdin?: Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number; // seconds
  },
) => Promise<{ stdout: Buffer; exitCode: number | null }>;

/** Pure argv builder for `kubectl exec` (unit-tested). */
export function buildKubectlArgs(config: K8sSandboxConfig, command: string): string[] {
  const args = ["exec", "-i", "-n", config.namespace];
  if (config.context) args.push("--context", config.context);
  args.push(config.pod, "--", "bash", "-c", command);
  return args;
}

/** Default transport: shell out to `kubectl exec`. */
export function kubectlExecInPod(config: K8sSandboxConfig): ExecInPod {
  return (command, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("kubectl", buildKubectlArgs(config, command), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      let timedOut = false;
      const timer =
        opts.timeout && opts.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, opts.timeout * 1000)
          : undefined;

      child.stdout.on("data", (d: Buffer) => {
        out.push(d);
        opts.onData?.(d);
      });
      child.stderr.on("data", (d: Buffer) => {
        opts.onData?.(d);
      });

      const onAbort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) return reject(new Error("aborted"));
        if (timedOut) return reject(new Error(`timeout:${opts.timeout}`));
        resolve({ stdout: Buffer.concat(out), exitCode: code });
      });

      if (opts.stdin) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/exec.test.ts 2>&1 | tail -8`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/src/exec.ts packages/k8s-sandbox/test/exec.test.ts
git commit -m "feat(k8s-sandbox): add execInPod transport seam (kubectl exec)"
```

---

## Task 6: The six operations factories (`operations.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/operations.ts`
- Test: `packages/k8s-sandbox/test/operations.test.ts`

A fake `ExecInPod` records each `(command, opts)` and returns scripted results, so we assert both the exact command built and correct parsing.

- [ ] **Step 1: Write the failing test**

Create `packages/k8s-sandbox/test/operations.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/operations.test.ts 2>&1 | tail -10`
Expected: FAIL — cannot resolve `../src/operations.js`.

- [ ] **Step 3: Implement `operations.ts`**

Create `packages/k8s-sandbox/src/operations.ts`:
```ts
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { K8sSandboxConfig } from "./config.js";
import type { ExecInPod } from "./exec.js";
import { mapPath, shQuote } from "./paths.js";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function mapper(cfg: K8sSandboxConfig) {
  return (p: string) => shQuote(mapPath(p, cfg.headCwd, cfg.podCwd));
}

export function createPodReadOps(exec: ExecInPod, cfg: K8sSandboxConfig): ReadOperations {
  const q = mapper(cfg);
  return {
    readFile: async (p) => (await exec(`cat ${q(p)}`)).stdout,
    access: async (p) => {
      const r = await exec(`test -r ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`File not readable in pod: ${p}`);
    },
    detectImageMimeType: async (p) => {
      const r = await exec(`file --mime-type -b ${q(p)}`);
      const mime = r.stdout.toString().trim();
      return IMAGE_MIMES.includes(mime) ? mime : null;
    },
  };
}

export function createPodWriteOps(exec: ExecInPod, cfg: K8sSandboxConfig): WriteOperations {
  const q = mapper(cfg);
  return {
    writeFile: async (p, content) => {
      const b64 = Buffer.from(content).toString("base64");
      const r = await exec(`base64 -d > ${q(p)}`, { stdin: Buffer.from(b64) });
      if (r.exitCode !== 0) throw new Error(`Write failed in pod: ${p}`);
    },
    mkdir: async (dir) => {
      const r = await exec(`mkdir -p ${q(dir)}`);
      if (r.exitCode !== 0) throw new Error(`mkdir failed in pod: ${dir}`);
    },
  };
}

export function createPodEditOps(exec: ExecInPod, cfg: K8sSandboxConfig): EditOperations {
  const read = createPodReadOps(exec, cfg);
  const write = createPodWriteOps(exec, cfg);
  const q = mapper(cfg);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (p) => {
      const r = await exec(`test -r ${q(p)} && test -w ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`File not read-writable in pod: ${p}`);
    },
  };
}

export function createPodBashOps(exec: ExecInPod, cfg: K8sSandboxConfig): BashOperations {
  const q = mapper(cfg);
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const r = await exec(`cd ${q(cwd)} && ${command}`, { onData, signal, timeout });
      return { exitCode: r.exitCode };
    },
  };
}

export function createPodLsOps(exec: ExecInPod, cfg: K8sSandboxConfig): LsOperations {
  const q = mapper(cfg);
  return {
    exists: async (p) => (await exec(`test -e ${q(p)}`)).exitCode === 0,
    stat: async (p) => {
      const r = await exec(`test -e ${q(p)} && (test -d ${q(p)} && echo DIR || echo FILE)`);
      if (r.exitCode !== 0) throw new Error(`Path not found in pod: ${p}`);
      const isDir = r.stdout.toString().trim() === "DIR";
      return { isDirectory: () => isDir };
    },
    readdir: async (p) => {
      const r = await exec(`ls -1A ${q(p)}`);
      if (r.exitCode !== 0) throw new Error(`readdir failed in pod: ${p}`);
      return r.stdout.toString().split("\n").filter((x) => x.length > 0);
    },
  };
}

export function createPodFindOps(exec: ExecInPod, cfg: K8sSandboxConfig): FindOperations {
  const q = mapper(cfg);
  return {
    exists: async (p) => (await exec(`test -e ${q(p)}`)).exitCode === 0,
    // NOTE: matches basenames via `find -name`; does not honour .gitignore or the
    // `ignore` list (a known M2 simplification vs Pi's local `fd`). Returns paths
    // relative to the search cwd (leading "./" stripped).
    glob: async (pattern, cwd, { limit }) => {
      const r = await exec(`cd ${q(cwd)} && find . -type f -name ${shQuote(pattern)} 2>/dev/null | head -n ${limit}`);
      return r.stdout
        .toString()
        .split("\n")
        .filter((x) => x.length > 0)
        .map((rel) => rel.replace(/^\.\//, ""));
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec vitest run test/operations.test.ts 2>&1 | tail -12`
Expected: PASS (all operations tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/src/operations.ts packages/k8s-sandbox/test/operations.test.ts
git commit -m "feat(k8s-sandbox): add six pod-backed Operations factories"
```

---

## Task 7: Grep tool with in-pod `execute` override (`grep-tool.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/grep-tool.ts`

No unit test: this imports Pi's runtime `createGrepTool` and is covered by the kind smoke (Task 11). The implementation is small and mirrors grep's documented result shape.

- [ ] **Step 1: Implement `grep-tool.ts`**

Create `packages/k8s-sandbox/src/grep-tool.ts`:
```ts
import { isAbsolute, resolve as resolvePath } from "node:path";
import { createGrepTool } from "@earendil-works/pi-coding-agent";
import type { K8sSandboxConfig } from "./config.js";
import type { ExecInPod } from "./exec.js";
import { mapPath, shQuote } from "./paths.js";

/**
 * grep cannot be routed via GrepOperations because Pi's grep always spawns a
 * LOCAL `rg` (see NOTES-pi-operations.md). We reuse the built-in tool's schema,
 * label, and render, but replace `execute` to run `rg` IN the pod and return
 * grep's result shape: { content: [{ type: "text", text }], details: undefined }.
 */
export function createPodGrepTool(
  localCwd: string,
  exec: ExecInPod,
  cfg: K8sSandboxConfig,
): ReturnType<typeof createGrepTool> {
  const base = createGrepTool(localCwd);
  return {
    ...base,
    async execute(_id, params: Record<string, unknown>, signal?: AbortSignal) {
      const pattern = String(params.pattern ?? "");
      const searchDir = typeof params.path === "string" ? params.path : ".";
      const glob = typeof params.glob === "string" ? params.glob : undefined;
      const ignoreCase = params.ignoreCase === true;
      const literal = params.literal === true;
      const context = typeof params.context === "number" ? params.context : 0;

      const headPath = isAbsolute(searchDir) ? searchDir : resolvePath(localCwd, searchDir);
      const podPath = mapPath(headPath, cfg.headCwd, cfg.podCwd);

      const parts = ["rg", "--line-number", "--no-heading", "--color=never", "--hidden"];
      if (ignoreCase) parts.push("--ignore-case");
      if (literal) parts.push("--fixed-strings");
      if (context > 0) parts.push("--context", String(context));
      if (glob) parts.push("--glob", shQuote(glob));
      parts.push("--", shQuote(pattern), shQuote(podPath));

      const r = await exec(parts.join(" "), { signal });
      const text = r.stdout.toString();
      // rg exits 1 with no output when there are no matches.
      if (r.exitCode === 1 && text.trim() === "") {
        return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
      }
      return { content: [{ type: "text" as const, text: text.length ? text : "No matches found" }], details: undefined };
    },
  } as ReturnType<typeof createGrepTool>;
}
```

- [ ] **Step 2: Typecheck the package**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec tsc --noEmit 2>&1 | tail -15; echo "EXIT:${PIPESTATUS[0]}"`
Expected: EXIT:0 (no type errors). If `pi-coding-agent` types are unresolved, confirm `pnpm install` linked the package (Task 2 Step 4) and that the pi-fork packages are built per the M1 build order — see Task 11 Step 1.

- [ ] **Step 3: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/src/grep-tool.ts
git commit -m "feat(k8s-sandbox): add grep tool with in-pod execute override"
```

---

## Task 8: The extension + public exports (`extension.ts`, `index.ts`)

**Files:**
- Create: `packages/k8s-sandbox/src/extension.ts`
- Modify: `packages/k8s-sandbox/src/index.ts`

- [ ] **Step 1: Implement `extension.ts`**

Create `packages/k8s-sandbox/src/extension.ts`:
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
 * in a remote Kubernetes pod via `kubectl exec`. Inert (returns immediately,
 * leaving Pi's local tools in place) unless a sandbox is configured.
 *
 * @param opts.config Explicit config; if omitted, resolved from process.env.
 *                    Pass `null` to force-disable.
 * @param opts.exec   Override the transport (used by tests / alternate auth).
 */
export function k8sSandboxExtension(opts?: {
  config?: K8sSandboxConfig | null;
  exec?: ExecInPod;
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const localCwd = process.cwd();
    const config = opts?.config !== undefined ? opts.config : resolveConfig(process.env, localCwd);
    if (!config) return; // off gate — local tools stand

    const exec = opts?.exec ?? kubectlExecInPod(config);

    pi.registerTool(createReadTool(localCwd, { operations: createPodReadOps(exec, config) }));
    pi.registerTool(createWriteTool(localCwd, { operations: createPodWriteOps(exec, config) }));
    pi.registerTool(createEditTool(localCwd, { operations: createPodEditOps(exec, config) }));
    pi.registerTool(createBashTool(localCwd, { operations: createPodBashOps(exec, config) }));
    pi.registerTool(createLsTool(localCwd, { operations: createPodLsOps(exec, config) }));
    pi.registerTool(createFindTool(localCwd, { operations: createPodFindOps(exec, config) }));
    pi.registerTool(createPodGrepTool(localCwd, exec, config));

    // User `!` commands also run in the pod.
    pi.on("user_bash", () => ({ operations: createPodBashOps(exec, config) }));

    // Tell the model its cwd is the pod's, not the head's.
    pi.on("before_agent_start", (event) => {
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${config.podCwd} (sandbox pod ${config.namespace}/${config.pod})`,
      );
      return { systemPrompt: modified };
    });
  };
}
```

- [ ] **Step 2: Update `index.ts` exports**

Replace `packages/k8s-sandbox/src/index.ts` with:
```ts
export { k8sSandboxExtension } from "./extension.js";
export { resolveConfig, type K8sSandboxConfig } from "./config.js";
export { buildKubectlArgs, kubectlExecInPod, type ExecInPod } from "./exec.js";
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm exec tsc --noEmit 2>&1 | tail -15; echo "EXIT:${PIPESTATUS[0]}"`
Expected: EXIT:0. If `before_agent_start` / `user_bash` event field names mismatch, cross-check against `examples/extensions/ssh.ts` (lines 203-218) and adjust — the SSH example is the source of truth for these hook shapes.

- [ ] **Step 4: Run the full package test suite (regression check)**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness/packages/k8s-sandbox && pnpm test 2>&1 | tail -12`
Expected: PASS — paths (5) + config (3) + exec (2) + operations (all) green.

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/src/extension.ts packages/k8s-sandbox/src/index.ts
git commit -m "feat(k8s-sandbox): add gated extension wiring the 7 pod tools"
```

---

## Task 9: Wire the extension into the headless harness (`cli.ts`)

**Files:**
- Modify: `harness/package.json`
- Modify: `harness/src/cli.ts:54-60`

- [ ] **Step 1: Add the dependency**

In `harness/package.json`, add to `dependencies` (after the `@sh/session-backend` line):
```json
    "@sh/k8s-sandbox": "workspace:*",
```
So the block reads:
```json
  "dependencies": {
    "@sh/session-backend": "workspace:*",
    "@sh/k8s-sandbox": "workspace:*",
    "@earendil-works/pi-ai": "link:../pi-fork/packages/ai",
    "@earendil-works/pi-coding-agent": "link:../pi-fork/packages/coding-agent"
  },
```

- [ ] **Step 2: Install**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness && pnpm install > /tmp/k8s-wire-install.log 2>&1; echo "EXIT:$?"`
Expected: EXIT:0.

- [ ] **Step 3: Import and register the extension**

In `harness/src/cli.ts`, add the import after the `flushExtension` import (line 24):
```ts
import { k8sSandboxExtension } from "@sh/k8s-sandbox";
```
Then change the `extensionFactories` array (line 58) from:
```ts
    extensionFactories: [flushExtension(backend)],
```
to:
```ts
    // k8sSandboxExtension() is inert unless KAGENTI_SANDBOX_POD is set, so the
    // default (Config A, local execution) is unchanged.
    extensionFactories: [flushExtension(backend), k8sSandboxExtension()],
```

- [ ] **Step 4: Verify default (no sandbox env) still type-loads**

Run:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness/harness && pnpm exec tsc --noEmit 2>&1 | tail -15; echo "EXIT:${PIPESTATUS[0]}"
```
Expected: EXIT:0. (A full run needs Pi built + Redis + a model gateway; that is the Task 11 smoke. Here we only confirm the wiring typechecks.)

- [ ] **Step 5: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add harness/package.json harness/src/cli.ts pnpm-lock.yaml
git commit -m "feat(harness): wire k8sSandboxExtension into headless cli (env-gated)"
```

---

## Task 10: Sandbox pod manifest fixture (`deploy/sandbox.yaml`)

**Files:**
- Create: `packages/k8s-sandbox/deploy/sandbox.yaml`

- [ ] **Step 1: Write the manifest**

Create `packages/k8s-sandbox/deploy/sandbox.yaml`. The image must carry `bash`, `coreutils` (`base64`, `file`, `stat`), `findutils`, and `ripgrep`. `alpine` provides bash/coreutils/findutils/ripgrep via apk; install them in a startup command so the fixture is self-contained on any node.
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sandbox-workspace
  namespace: default
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sandbox
  namespace: default
  labels:
    app: sandbox
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sandbox
  template:
    metadata:
      labels:
        app: sandbox
    spec:
      containers:
        - name: sandbox
          image: alpine:3.20
          # Install the tools the Operations rely on, then idle.
          command: ["/bin/sh", "-c"]
          args:
            - apk add --no-cache bash coreutils findutils ripgrep file >/dev/null 2>&1;
              mkdir -p /workspace;
              exec sleep infinity
          workingDir: /workspace
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: workspace
          persistentVolumeClaim:
            claimName: sandbox-workspace
```

- [ ] **Step 2: Validate the YAML parses (no cluster needed)**

Run:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
python3 -c "import yaml,sys; list(yaml.safe_load_all(open('packages/k8s-sandbox/deploy/sandbox.yaml'))); print('OK')"
```
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/deploy/sandbox.yaml
git commit -m "feat(k8s-sandbox): add plain Deployment+PVC sandbox fixture"
```

---

## Task 11: Real kind smoke — prove tools run in the pod

**Files:**
- Create: `packages/k8s-sandbox/SMOKE.md` (runbook + recorded result)

This is the M2 gate's real-cluster half. It is a **manual runbook** (cluster + model gateway dependent), executed once and its result recorded. Requires: a kind cluster with `kubectl` context, the same model-gateway env used for the M1 smoke (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), and the `sh-redis` container from M1 on `:6379`.

- [ ] **Step 1: Build Pi (M1 build order) and ensure prerequisites**

Run:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
for p in ai agent tui coding-agent; do pnpm -C pi-fork/packages/$p build > /tmp/pi-build-$p.log 2>&1 && echo "built $p" || { echo "FAIL $p (see /tmp/pi-build-$p.log)"; break; }; done
docker ps --format '{{.Names}}' | grep -q sh-redis && echo "redis up" || echo "START sh-redis first"
kubectl config current-context
```
Expected: all four `built …` lines; `redis up`; a kind context printed.

- [ ] **Step 2: Apply the sandbox fixture and wait for Ready**

Run:
```bash
kubectl apply -f packages/k8s-sandbox/deploy/sandbox.yaml > /tmp/sbx-apply.log 2>&1; echo "EXIT:$?"
kubectl -n default rollout status deploy/sandbox --timeout=120s > /tmp/sbx-roll.log 2>&1; echo "EXIT:$?"
POD=$(kubectl -n default get pod -l app=sandbox -o jsonpath='{.items[0].metadata.name}'); echo "POD=$POD"
# Confirm tools installed inside the pod:
kubectl -n default exec "$POD" -- sh -c 'command -v bash base64 file rg find && echo TOOLS_OK'
```
Expected: both EXIT:0; a `POD=sandbox-…` name; `TOOLS_OK`.

- [ ] **Step 2b: Sanity-check the bare transport against the pod**

Run:
```bash
kubectl -n default exec -i "$POD" -- bash -c 'hostname'
```
Expected: prints the **pod's** hostname (= `$POD`), establishing the baseline for the isolation assertion in Step 4.

- [ ] **Step 3: Drive one agent turn with the sandbox enabled**

Run (the prompt instructs a file write + a host identity command, both must land in the pod):
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness/harness
export KAGENTI_SANDBOX_POD="$POD"
export KAGENTI_SANDBOX_NAMESPACE=default
export KAGENTI_SANDBOX_CWD=/workspace
unset PI_SESSION_ID
pnpm exec tsx src/cli.ts "Create a file proof.txt in the current directory containing the output of \`hostname\`. Then tell me the hostname." > /tmp/m2-smoke.log 2>&1
echo "EXIT:$?"; tail -5 /tmp/m2-smoke.log
```
Expected: EXIT:0; the log ends with `SESSION_ID=…` and the assistant reply names a hostname.

- [ ] **Step 4: Assert the side effects landed in the POD, not the head**

Run:
```bash
# (a) the file the agent wrote exists IN the pod:
kubectl -n default exec "$POD" -- cat /workspace/proof.txt > /tmp/m2-proof.log 2>&1; echo "EXIT:$?"
cat /tmp/m2-proof.log
# (b) it must NOT exist on the head:
test ! -e /Users/paolo/Projects/aiplatform/serverless-harness/harness/proof.txt && echo "HEAD_CLEAN" || echo "LEAKED TO HEAD"
# (c) the hostname the agent reported equals the pod's, not the head's:
echo "pod hostname: $POD"; hostname
```
Expected: (a) EXIT:0 and `proof.txt` contains the **pod** hostname (matches `$POD`); (b) `HEAD_CLEAN`; (c) the reported hostname matches the pod, differs from the head's `hostname`. Together these prove isolation actually happened.

- [ ] **Step 5: Record the result and commit**

Create `packages/k8s-sandbox/SMOKE.md` with the runbook above plus a "Result (YYYY-MM-DD)" section pasting the Step 4 outputs (pod name, proof.txt contents, HEAD_CLEAN, both hostnames). Then:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/SMOKE.md
git commit -m "test(k8s-sandbox): record real kind smoke proving in-pod execution"
```

- [ ] **Step 6: Tear down the fixture**

Run: `kubectl delete -f packages/k8s-sandbox/deploy/sandbox.yaml > /tmp/sbx-del.log 2>&1; echo "EXIT:$?"`
Expected: EXIT:0.

---

## Task 12: Docs + submodule pointer + close-out

**Files:**
- Create: `packages/k8s-sandbox/README.md`
- Modify: `README.md` (repo root)

- [ ] **Step 1: Write the package README**

Create `packages/k8s-sandbox/README.md`:
```markdown
# @sh/k8s-sandbox

Routes Pi tool execution (read/write/edit/bash/ls/grep/find) to a remote
Kubernetes pod via `kubectl exec`, using Pi's native `Operations` seam. Part of
the serverless harness (Milestone 2). See
[`docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md`](../../docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md).

## Use

`harness/cli.ts` registers `k8sSandboxExtension()`. It is **inert unless
`KAGENTI_SANDBOX_POD` is set**:

| Env var | Default | Meaning |
|---------|---------|---------|
| `KAGENTI_SANDBOX_POD` | (unset → off) | pod to exec into |
| `KAGENTI_SANDBOX_NAMESPACE` | `default` | namespace |
| `KAGENTI_SANDBOX_CONTEXT` | current-context | kube context |
| `KAGENTI_SANDBOX_CWD` | `/workspace` | pod working dir (announced to the model) |

Apply the fixture pod first: `kubectl apply -f deploy/sandbox.yaml`.
See `SMOKE.md` for the end-to-end runbook.

## Notes

- No pi-fork change: the `Operations` seam is native. The one exception is
  `grep`, whose search hardwires a local `rg`; its tool gets an `execute`
  override (`grep-tool.ts`). See `NOTES-pi-operations.md`.
- `find` honours basename globs only (no .gitignore/ignore list) — an M2
  simplification vs Pi's local `fd`.
- Per-op `kubectl exec` latency is acceptable for M2 (not the perf milestone);
  a persistent in-pod channel is the M3 upgrade path.
```

- [ ] **Step 2: Add an M2 line to the repo root README**

In the root `README.md`, append a Milestones note (after the existing M1 mention; if none, add a short "## Milestones" section):
```markdown
- **M2 — K8sSandboxClient** (`packages/k8s-sandbox`): routes Pi tool execution to
  a remote Kubernetes pod via `kubectl exec`. Env-gated (`KAGENTI_SANDBOX_POD`);
  off by default. Design: `docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md`.
```

- [ ] **Step 3: Full workspace test sweep (final regression gate)**

Run:
```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
pnpm -C packages/k8s-sandbox test 2>&1 | tail -6; echo "k8s EXIT:${PIPESTATUS[0]}"
pnpm -C packages/session-backend test 2>&1 | tail -6; echo "sb EXIT:${PIPESTATUS[0]}"
pnpm -C harness test 2>&1 | tail -6; echo "harness EXIT:${PIPESTATUS[0]}"
```
Expected: all three suites green (M1's session-backend + harness suites must remain green — no regressions).

- [ ] **Step 4: Commit**

```bash
cd /Users/paolo/Projects/aiplatform/serverless-harness
git add packages/k8s-sandbox/README.md README.md
git commit -m "docs(k8s-sandbox): add package README and M2 milestone note"
```

- [ ] **Step 5: Update the memory note**

Append M2 status to `/Users/paolo/.claude/projects/-Users-paolo-Projects-aiplatform-kagenti/memory/project_serverless_harness_m1.md` (or create a sibling `project_serverless_harness_m2.md` and add a `MEMORY.md` pointer): record that M2 is complete, the commit range, the `@sh/k8s-sandbox` layout, the grep-override / find-glob findings, env-gate var names, and the smoke result. (No git commit — memory lives outside the repo.)

---

## Self-review (completed by plan author)

**1. Spec coverage:**
- §2 D1 kubectl exec transport → Task 5. D2 all 7 ops → Tasks 6 (six) + 7 (grep). D3 existing pod + manifest → Task 10. D4 injectable seam + fake-exec tests + kind smoke → Tasks 5/6 + 11. D5 new package + harness wiring, no pi-fork change → Tasks 2/8/9. D6 env config gate → Task 4. D7 path mapping → Task 3 + bash/grep cwd handling.
- §4 ops table → Task 6 + 7. §4.1 grep/find risk → Task 1 (note) + 7 (override). §5 extension/headless → Tasks 8/9. §6 manifest → Task 10. §7 gate → Task 11. All covered.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code; every command states expected output.

**3. Type consistency:** `ExecInPod` (command, opts)→`{stdout, exitCode}` used identically in exec.ts, operations.ts, grep-tool.ts, tests. `K8sSandboxConfig` fields (`pod/namespace/context/podCwd/headCwd`) consistent across config/exec/operations/extension. `resolveConfig(env, headCwd)`, `mapPath(p, headCwd, podCwd)`, `shQuote(s)`, `k8sSandboxExtension({config?, exec?})`, `createPod{Read,Write,Edit,Bash,Ls,Find}Ops(exec, cfg)`, `createPodGrepTool(localCwd, exec, cfg)` — names match every call site. Grep result shape matches `grep.ts:311`.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
