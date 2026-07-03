import { describe, it, expect } from "vitest";
import { orderByLoad, selectPoolSandbox, SandboxPoolSaturatedError } from "../src/select-sandbox.js";
import type { LeaseStore } from "../src/sandbox-lease.js";

describe("orderByLoad", () => {
  it("sorts ascending by active load, stable on ties", () => {
    expect(orderByLoad([
      { pod: "c", active: 2 }, { pod: "a", active: 0 }, { pod: "b", active: 0 },
    ])).toEqual(["a", "b", "c"]);
  });
});

function fakeLease(loads: Record<string, number>, cap: number): LeaseStore & { acquired: string[]; acquiredTtl: number[] } {
  const counts = { ...loads };
  const acquired: string[] = [];
  const acquiredTtl: number[] = [];
  return {
    acquired,
    acquiredTtl,
    async load(pod) { return counts[pod] ?? 0; },
    async acquire(pod, c, _runId, ttlMs) {
      if ((counts[pod] ?? 0) < c) { counts[pod] = (counts[pod] ?? 0) + 1; acquired.push(pod); acquiredTtl.push(ttlMs); return true; }
      return false;
    },
    async heartbeat() {},
    async release() {},
  };
}

describe("selectPoolSandbox", () => {
  const opts = { cap: 2, ttlMs: 60000 };

  it("returns null when no sandbox is configured at all", async () => {
    const res = await selectPoolSandbox({} as NodeJS.ProcessEnv, "/head", "leaf-1", opts, {
      listPods: async () => [],
    });
    expect(res).toBeNull();
  });

  it("falls back to single-pod resolution when no pool selector is set", async () => {
    const env = { KAGENTI_SANDBOX_POD: "sandbox-x" } as unknown as NodeJS.ProcessEnv;
    const res = await selectPoolSandbox(env, "/head", "leaf-1", opts, {});
    expect(res?.config.pod).toBe("sandbox-x");
  });

  it("picks the least-loaded pod and acquires a lease", async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: "app=sandbox" } as unknown as NodeJS.ProcessEnv;
    const lease = fakeLease({ "sandbox-0-0": 2, "sandbox-1-0": 0 }, opts.cap);
    const res = await selectPoolSandbox(env, "/head", "leaf-1", opts, {
      listPods: async () => ["sandbox-0-0", "sandbox-1-0"],
      lease,
    });
    expect(res?.config.pod).toBe("sandbox-1-0");
    expect(lease.acquired).toEqual(["sandbox-1-0"]);
    expect(lease.acquiredTtl).toEqual([opts.ttlMs]);
  });

  it("throws SandboxPoolSaturatedError when every pod is at cap", async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: "app=sandbox" } as unknown as NodeJS.ProcessEnv;
    const lease = fakeLease({ "sandbox-0-0": 2, "sandbox-1-0": 2 }, opts.cap);
    await expect(selectPoolSandbox(env, "/head", "leaf-1", opts, {
      listPods: async () => ["sandbox-0-0", "sandbox-1-0"],
      lease,
    })).rejects.toBeInstanceOf(SandboxPoolSaturatedError);
  });
});
