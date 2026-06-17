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
        resolve({ stdout: Buffer.concat(out), exitCode: code });
      });

      if (opts.stdin) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
}
