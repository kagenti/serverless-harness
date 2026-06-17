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
 * NOTE: this transport does NOT stream `opts.onData`; streaming ops (bash, grep) stay on the M2 per-call exec.
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
    // Null `child` BEFORE kill() so a synchronous `close` (from kill) re-entering
    // killChild/the close handler sees no child and is a no-op (avoids recursion).
    const c = child;
    child = null;
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
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
