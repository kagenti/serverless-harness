import { spawn as nodeSpawn } from "node:child_process";
import type { K8sSandboxConfig } from "./config.js";
import type { ExecInPod, SandboxTransport } from "./transport.js";

// Re-export so existing `./exec.js` importers of ExecInPod keep working.
export type { ExecInPod } from "./transport.js";

type SpawnFn = typeof nodeSpawn;

/** Pure argv builder for `kubectl exec` (unit-tested). */
export function buildKubectlArgs(config: K8sSandboxConfig, command: string): string[] {
  const args = ["exec", "-i", "-n", config.namespace];
  if (config.context) args.push("--context", config.context);
  args.push(config.pod, "--", "bash", "-c", command);
  return args;
}

/** True only when exec timing is explicitly enabled (off by default). */
export function shouldEmitExecTiming(env: NodeJS.ProcessEnv): boolean {
  return env.KAGENTI_EXEC_TIMING === "1";
}

/** One stable, newline-terminated timing line for a single exec. */
export function formatExecTiming(pod: string, ms: number, command: string): string {
  const cmd = command.slice(0, 60).replace(/\s+/g, " ");
  return `[exec-timing] pod=${pod} ms=${ms} cmd=${cmd}\n`;
}

/**
 * Default transport: each `exec()` shells out to a fresh `kubectl exec`. There is
 * no long-lived resource, so `close()` is a no-op. `deps.spawn` is injectable for
 * tests (defaults to node's spawn); real callers pass only `config`.
 */
export function KubectlTransport(
  config: K8sSandboxConfig,
  deps: { spawn?: SpawnFn } = {},
): SandboxTransport {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const exec: ExecInPod = (command, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawnFn("kubectl", buildKubectlArgs(config, command), {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const startMs = Date.now();
      const out: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      const timer =
        opts.timeout && opts.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, opts.timeout * 1000)
          : undefined;

      child.stdout.on("data", (d: Buffer) => {
        out.push(d); // TODO(M3): bound/stream this buffer for large outputs (perf milestone).
        opts.onData?.(d);
      });
      child.stderr.on("data", (d: Buffer) => {
        opts.onData?.(d);
      });

      const onAbort = () => child.kill("SIGKILL");
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) return reject(new Error("aborted"));
        if (timedOut) return reject(new Error(`timeout:${opts.timeout}`));
        if (shouldEmitExecTiming(process.env)) {
          process.stderr.write(formatExecTiming(config.pod, Date.now() - startMs, command));
        }
        resolve({ stdout: Buffer.concat(out), exitCode: code });
      });

      if (opts.stdin) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  return { exec, close: async () => {} };
}

/**
 * @deprecated Back-compat alias retained only during the ST2 migration; use
 * `KubectlTransport(config).exec`. Removed in the final ST2 task.
 */
export function kubectlExecInPod(config: K8sSandboxConfig): ExecInPod {
  return KubectlTransport(config).exec;
}
