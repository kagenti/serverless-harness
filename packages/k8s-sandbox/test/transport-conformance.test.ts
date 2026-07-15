import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { K8sSandboxConfig } from "../src/config.js";
import { KubectlTransport } from "../src/exec.js";
import { runConformance, type TransportFactory } from "./conformance.js";

type SpawnFn = typeof import("node:child_process").spawn;

const cfg: K8sSandboxConfig = {
  pod: "sbx-0",
  namespace: "team1",
  context: undefined,
  podCwd: "/workspace",
  headCwd: "/head",
};

/** Build a KubectlTransport whose child process is a scripted fake. */
const kubectlFactory: TransportFactory = (b) => {
  let stdin: Buffer | undefined;
  const spawn = ((_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (d?: Buffer) => { stdin = d; } };
    // kill() drives a `close` event, exactly as a real SIGKILL would.
    child.kill = vi.fn(() => child.emit("close", null));
    // Emit after the transport has attached its handlers (still synchronous
    // relative to the awaiting test via a microtask).
    queueMicrotask(() => {
      for (const s of b.stdout ?? []) child.stdout.emit("data", Buffer.from(s));
      for (const s of b.stderr ?? []) child.stderr.emit("data", Buffer.from(s));
      if (!b.hang) child.emit("close", b.exitCode ?? 0);
    });
    return child;
  }) as unknown as SpawnFn;
  return { transport: KubectlTransport(cfg, { spawn }), stdinSeen: () => stdin };
};

runConformance("KubectlTransport", kubectlFactory);
