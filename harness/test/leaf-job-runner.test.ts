// harness/test/leaf-job-runner.test.ts
import { describe, it, expect, vi } from "vitest";
import { processOne, type LeafJobDeps } from "../src/leaf-job-runner";
import type { ClaimedEntry, WorkQueue } from "@sh/work-queue";
import type { LeafEnvelope, LeafResult } from "../src/run-leaf";

function fakeQueue(claimed: ClaimedEntry | null): WorkQueue & { acked: string[]; touched: string[] } {
  const acked: string[] = []; const touched: string[] = [];
  return {
    acked, touched,
    ensureGroup: async () => {},
    enqueue: async () => "1-0",
    claim: async () => claimed,
    ack: async (id: string) => { acked.push(id); },
    touch: async (id: string) => { touched.push(id); },
    pending: async () => 0,
    purge: async () => {},
    close: async () => {},
  };
}

const ENV: LeafEnvelope = { sessionId: "run/i1", inputsRef: "/in", resultRef: "/out" };
function baseDeps(over: Partial<LeafJobDeps>): LeafJobDeps {
  const markers: Array<{ path: string; status: string; reason: string | null }> = [];
  return {
    queue: fakeQueue(null),
    runLeaf: async () => ({ status: "done", resultRef: "/out" }),
    writeMarker: (path, m) => { markers.push({ path, status: m.status, reason: m.reason }); (baseDeps as any)._m = markers; },
    consumerId: "w1",
    now: () => "t",
    setHeartbeat: () => 0,
    clearHeartbeat: () => {},
    ...over,
  };
}

describe("processOne", () => {
  it("returns idle and does nothing when the queue is empty", async () => {
    const q = fakeQueue(null);
    const r = await processOne(baseDeps({ queue: q }));
    expect(r).toBe("idle");
    expect(q.acked).toEqual([]);
  });

  it("dead-letters (failed marker + ack, runLeaf NOT called) past maxAttempts", async () => {
    const q = fakeQueue({ entryId: "9-0", envelope: ENV, deliveryCount: 4 });
    const runLeaf = vi.fn();
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: runLeaf as any, maxAttempts: 3, writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("deadletter");
    expect(runLeaf).not.toHaveBeenCalled();
    expect(markers[0]).toMatchObject({ status: "failed", reason: "error" });
    expect(q.acked).toEqual(["9-0"]);
  });

  it("done → writes done marker and acks", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "done", resultRef: "/out" }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("done");
    expect(markers[0]).toMatchObject({ status: "done", reason: null });
    expect(q.acked).toEqual(["1-0"]);
  });

  it("deterministic failure → failed marker + ack", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "failed", reason: "bad_inputs" }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("failed");
    expect(markers[0]).toMatchObject({ status: "failed", reason: "bad_inputs" });
    expect(q.acked).toEqual(["1-0"]);
  });

  it("paused → acks, writes no terminal marker, returns paused", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "paused", gateRef: "/out.gate", gateId: 0 }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("paused");
    expect(markers).toEqual([]); // gate marker is written by runLeaf, not the runner
    expect(q.acked).toEqual(["1-0"]);
  });

  it("aborted → writes aborted marker + ack, returns aborted", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "aborted" }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("aborted");
    expect(markers[0]).toMatchObject({ status: "aborted", reason: null });
    expect(q.acked).toEqual(["1-0"]);
  });

  it("retryable error → no ack, no marker, returns retry", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const markers: any[] = [];
    const r = await processOne(baseDeps({ queue: q, runLeaf: async () => ({ status: "failed", reason: "error", message: "x" }), writeMarker: (p, m) => markers.push(m) }));
    expect(r).toBe("retry");
    expect(markers).toEqual([]);
    expect(q.acked).toEqual([]);
  });

  it("schedules and clears a heartbeat around the run", async () => {
    const q = fakeQueue({ entryId: "1-0", envelope: ENV, deliveryCount: 1 });
    const set = vi.fn(() => 42); const clear = vi.fn();
    await processOne(baseDeps({ queue: q, setHeartbeat: set as any, clearHeartbeat: clear as any }));
    expect(set).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledWith(42);
  });
});
