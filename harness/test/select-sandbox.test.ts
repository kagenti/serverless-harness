import { describe, it, expect, vi } from "vitest";
import { orderByLoad, selectPoolSandbox, SandboxPoolSaturatedError } from "../src/select-sandbox.js";
import type { LeaseStore } from "../src/sandbox-lease.js";
import type { RecordStore, SandboxRecord } from "../src/pool-records.js";
import type { ExecClientLike } from "@sh/k8s-sandbox";

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

  it("throws a plain Error (not SandboxPoolSaturatedError) when a pool selector is set but no pods are Running", async () => {
    const env = { KAGENTI_SANDBOX_POOL_SELECTOR: "app=sandbox" } as unknown as NodeJS.ProcessEnv;
    // lease is never touched: the empty-list guard throws before any lease call.
    const err = await selectPoolSandbox(env, "/head", "leaf-1", opts, {
      listPods: async () => [],
      lease: fakeLease({}, opts.cap),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SandboxPoolSaturatedError);
    expect((err as Error).message).toBe("no Running pods for pool selector 'app=sandbox'");
  });
});

const grpcRec: SandboxRecord = { sandboxId: "sbx-remote-1", labels: {}, capabilities: [], capacityMax: 4, transport: "grpc" };
const fakeRecords = (recs: SandboxRecord[]): RecordStore => ({ put: async () => {}, remove: async () => {}, list: async () => recs });
const fakeExecClient: ExecClientLike = { exec: () => ({ on: () => ({}), cancel: () => {} }) as never, abort: (_r, cb) => { cb(null); return {}; } };

describe("selectPoolSandbox remote dispatch", () => {
  const env = (extra: Record<string, string> = {}) => ({ KAGENTI_SANDBOX_POOL_SELECTOR: "app=sbx", ...extra }) as NodeJS.ProcessEnv;
  const opts = { cap: 4, ttlMs: 60000, remoteSandbox: true };

  it("flag OFF: ignores grpc records, transport is undefined, and never calls records.list()", async () => {
    const lease = fakeLease({ "sandbox-0-0": 0 }, opts.cap);
    const list = vi.fn(async () => [grpcRec]);
    const records: RecordStore = { put: async () => {}, remove: async () => {}, list };
    const sel = await selectPoolSandbox(env(), "/head", "run-1", { cap: 4, ttlMs: 60000 /* remoteSandbox omitted ⇒ false */ }, {
      listPods: async () => ["sandbox-0-0"],
      lease,
      records,
    });
    expect(sel?.transport).toBeUndefined();
    expect(sel?.config.pod).toBe("sandbox-0-0");
    // The #1 inertness gate: when remoteSandbox is off, RecordStore.list() must never be invoked.
    expect(list).not.toHaveBeenCalled();
  });

  it("flag ON: a leased grpc record yields a GrpcRelayTransport", async () => {
    // Only the grpc record is available (no pods) so it must be chosen.
    const lease = fakeLease({ "sbx-remote-1": 0 }, opts.cap);
    const sel = await selectPoolSandbox(env(), "/head", "run-1", opts, {
      listPods: async () => [],
      lease,
      records: fakeRecords([grpcRec]),
      makeExecClient: () => fakeExecClient,
    });
    expect(sel?.transport).toBeDefined();
    expect(typeof sel?.transport?.exec).toBe("function");
    expect(sel?.config.pod).toBe("sbx-remote-1");
  });
});
