import { spawn as nodeSpawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { K8sSandboxConfig } from "../src/config.js";
import { kubectlExecInPod } from "../src/exec.js";
import { persistentExecInPod } from "../src/persistent-exec.js";
import {
  createPodBashOps,
  createPodFindOps,
  createPodLsOps,
  createPodReadOps,
  createPodWriteOps,
} from "../src/operations.js";

const execFileP = promisify(execFile);

// Gate: this suite hits a REAL kind cluster and is skip-by-default. It only runs
// when M3_LIVE_SMOKE is set, so `pnpm test`/CI never executes it.
const LIVE = !!process.env.M3_LIVE_SMOKE;

// Construct the config directly (mirrors the unit-test fixture) so path mapping
// is deterministic: head path /head/X maps to pod path /workspace/X.
const cfg: K8sSandboxConfig = {
  pod: process.env.KAGENTI_SANDBOX_POD ?? "",
  namespace: process.env.KAGENTI_SANDBOX_NAMESPACE ?? "default",
  context: process.env.KAGENTI_SANDBOX_CONTEXT ?? "kind-kagenti",
  podCwd: "/workspace",
  headCwd: "/head",
};

/** Direct `kubectl exec` into the pod (independent verification path). */
async function kubectlExecRaw(args: string[]): Promise<string> {
  const base = ["exec", "-n", cfg.namespace];
  if (cfg.context) base.push("--context", cfg.context);
  base.push(cfg.pod, "--", ...args);
  const { stdout } = await execFileP("kubectl", base, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

describe.skipIf(!LIVE)("M3 live smoke (real kind cluster)", () => {
  it("Claim 1: a single persistent process serves a burst of >=3 ops", async () => {
    let spawnCount = 0;
    const countingSpawn = ((...a: Parameters<typeof nodeSpawn>) => {
      spawnCount += 1;
      // @ts-expect-error spread of typed-overload args is fine at runtime
      return nodeSpawn(...a);
    }) as typeof nodeSpawn;

    const fastExec = persistentExecInPod(cfg, {
      fallback: kubectlExecInPod(cfg),
      spawn: countingSpawn,
    });
    try {
      const read = createPodReadOps(fastExec, cfg);
      const ls = createPodLsOps(fastExec, cfg);
      const find = createPodFindOps(fastExec, cfg);

      // BURST: run >=3 ops sequentially, all over the same persistent channel.
      // NOTE: the seeded .ts files are 0 bytes, so we assert presence of the
      // *.gitignore* read (non-empty) and structural results for ls/glob;
      // content length of empty files is intentionally not asserted.
      const gi = await read.readFile("/head/.gitignore");
      const listing = await ls.readdir("/head");
      const globbed = await find.glob("*.ts", "/head", {
        ignore: ["**/node_modules/**", "**/.git/**"],
        limit: 100,
      });
      const gi2 = await read.readFile("/head/.gitignore");

      expect(gi.length).toBeGreaterThan(0);
      expect(listing.length).toBeGreaterThan(0);
      expect(globbed.length).toBeGreaterThan(0);
      expect(gi2.length).toBeGreaterThan(0);
      expect(gi2.toString()).toBe(gi.toString());

      // The whole burst must have been served by exactly ONE kubectl process.
      expect(spawnCount).toBe(1);
      // eslint-disable-next-line no-console
      console.log(`[Claim1] spawnCount=${spawnCount} (burst of 4 ops)`);
    } finally {
      fastExec.dispose();
    }
  }, 30000);

  it("Claim 2 (TOP): write/edit over the persistent channel round-trips multi-line/special content", async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: kubectlExecInPod(cfg) });
    const headPath = "/head/m3-write.txt";
    const podPath = "/workspace/m3-write.txt";
    const content =
      'line1\nline2 with "quotes" and $dollar and `backtick`\nline3 end\n';
    try {
      const write = createPodWriteOps(fastExec, cfg);
      const read = createPodReadOps(fastExec, cfg);

      // Must NOT hang (the pre-fix heredoc-delimiter bug hung here). The 30s
      // test timeout would fail the test if it did.
      await write.writeFile(headPath, content);

      // Read back over the persistent channel.
      const roundTrip = (await read.readFile(headPath)).toString();
      expect(roundTrip).toBe(content);

      // Independently confirm with a direct kubectl exec cat.
      const direct = await kubectlExecRaw(["cat", podPath]);
      expect(direct).toBe(content);

      // eslint-disable-next-line no-console
      console.log(`[Claim2] write round-trip OK; bytes=${Buffer.from(content).length}`);
    } finally {
      fastExec.dispose();
    }
  }, 30000);

  it("Claim 3: env injection reaches the bash op", async () => {
    const streamExec = kubectlExecInPod(cfg);
    const bash = createPodBashOps(streamExec, cfg);
    const chunks: Buffer[] = [];
    const r = await bash.exec("echo MARKER=$M3_SMOKE", "/head", {
      onData: (d) => chunks.push(d),
      env: { M3_SMOKE: "works-42" },
    });
    const out = Buffer.concat(chunks).toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain("MARKER=works-42");
    const line = out.split("\n").find((l) => l.includes("MARKER=")) ?? out.trim();
    // eslint-disable-next-line no-console
    console.log(`[Claim3] captured: ${line.trim()}`);
  }, 30000);

  it("Claim 4: glob honours ignore-list; a gitignored DIRECTORY (dist/) is pruned even with -g '*.ts'", async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: kubectlExecInPod(cfg) });
    try {
      const find = createPodFindOps(fastExec, cfg);
      const results = await find.glob("*.ts", "/head", {
        ignore: ["**/node_modules/**", "**/.git/**"],
        limit: 100,
      });
      const set = new Set(results);
      // eslint-disable-next-line no-console
      console.log(`[Claim4] glob result: ${JSON.stringify(results)}`);

      // Included: regular tracked files.
      expect(set.has("src/keep.ts")).toBe(true);
      expect(set.has("top.ts")).toBe(true);
      // Excluded: in the ignore-list / rg built-ins.
      expect(set.has("node_modules/pkg/skip.ts")).toBe(false);
      expect(set.has(".git/cfg.ts")).toBe(false);

      // ── gitignored DIRECTORY case (the nuance) ────────────────────────────
      // operations.ts notes that a positive `-g <pattern>` is a ripgrep
      // whitelist that can override .gitignore. That override is real, but it
      // is FILE-level only (proven in Claim 4b). It does NOT resurrect files
      // inside a gitignored *directory*: when `.gitignore` contains `dist/`,
      // ripgrep PRUNES the whole `dist/` directory before the `-g '*.ts'`
      // whitelist is ever consulted, so `dist/bundle.ts` stays excluded even
      // though `*.ts` matches it. (Only `rg --files -uu`/`--no-ignore-vcs`
      // would surface it.) Assert the dir-prune behaviour here; the file-level
      // override is asserted separately in Claim 4b.
      const distVisible = set.has("dist/bundle.ts");
      // eslint-disable-next-line no-console
      console.log(
        `[Claim4] dist/bundle.ts visible via -g glob = ${distVisible} ` +
          `(gitignored DIRECTORY dist/ is pruned before -g whitelist applies -> false)`,
      );
      expect(distVisible).toBe(false);
    } finally {
      fastExec.dispose();
    }
  }, 30000);

  it("Claim 4b: positive -g whitelist-overrides a file-level .gitignore (verified nuance)", async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: kubectlExecInPod(cfg) });
    try {
      // Seed an ISOLATED fixture (does not touch the shared /workspace files):
      // /workspace/ovr/{a.ts, keep2.ts, .gitignore} where .gitignore ignores
      // the file `a.ts` by name. A positive `-g '*.ts'` should whitelist-override
      // that FILE-level ignore (unlike the DIRECTORY-prune case in Claim 4).
      await kubectlExecRaw([
        "bash",
        "-lc",
        "mkdir -p /workspace/ovr && " +
          ": > /workspace/ovr/a.ts && " +
          ": > /workspace/ovr/keep2.ts && " +
          "printf 'a.ts\\n' > /workspace/ovr/.gitignore",
      ]);

      const find = createPodFindOps(fastExec, cfg);
      // cwd /head/ovr maps to /workspace/ovr; empty ignore-list so ONLY
      // .gitignore is in play.
      const results = await find.glob("*.ts", "/head/ovr", {
        ignore: [],
        limit: 100,
      });
      const set = new Set(results);
      // eslint-disable-next-line no-console
      console.log(`[Claim4b] glob result: ${JSON.stringify(results)}`);

      // a.ts is gitignored by name, but the positive -g '*.ts' whitelist
      // overrides a FILE-level ignore -> it reappears.
      expect(set.has("a.ts")).toBe(true);
      // keep2.ts is not ignored at all.
      expect(set.has("keep2.ts")).toBe(true);
    } finally {
      await kubectlExecRaw(["rm", "-rf", "/workspace/ovr"]);
      fastExec.dispose();
    }
  }, 30000);

  it("Claim 5: dispose is non-throwing (best-effort process-count probe)", async () => {
    const fastExec = persistentExecInPod(cfg, { fallback: kubectlExecInPod(cfg) });
    // Warm the channel so a persistent bash exists in the pod.
    await createPodReadOps(fastExec, cfg).readFile("/head/.gitignore");

    const countBash = async (): Promise<number> => {
      try {
        const out = await kubectlExecRaw([
          "sh",
          "-c",
          'ps -o pid,args 2>/dev/null | grep -c "[b]ash"',
        ]);
        return parseInt(out.trim(), 10) || 0;
      } catch {
        return -1;
      }
    };

    const before = await countBash();
    expect(() => fastExec.dispose()).not.toThrow();
    // Give the kill a moment to propagate.
    await new Promise((res) => setTimeout(res, 1500));
    const after = await countBash();

    // eslint-disable-next-line no-console
    console.log(`[Claim5] bash-process count before=${before} after=${after} (informational)`);
  }, 30000);
});
