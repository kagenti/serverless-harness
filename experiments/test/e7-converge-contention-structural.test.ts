import { describe, it, expect, afterAll } from "vitest";
import { worktreeConsistent, type LeafObservation } from "../src/sharing";
import { RedisLeaseStore } from "@sh/harness/sandbox-lease";

describe("E7 — mixed-ref consistency (structural)", () => {
  it("passes when every leaf observed its own ref, fails on cross-contamination", () => {
    const good: LeafObservation[] = [
      { runId: "a", expectedRef: "branch-0", observedMarker: "branch-0" },
      { runId: "b", expectedRef: "branch-1", observedMarker: "branch-1" },
    ];
    expect(worktreeConsistent(good).ok).toBe(true);

    const bad: LeafObservation[] = [
      { runId: "a", expectedRef: "branch-0", observedMarker: "branch-0" },
      { runId: "b", expectedRef: "branch-1", observedMarker: "branch-0" }, // leaked sibling ref
    ];
    const r = worktreeConsistent(bad);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].runId).toBe("b");
  });
});

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
describe("E7 — lease never exceeds cap (structural, real Redis)", () => {
  const store = new RedisLeaseStore(REDIS);
  const pod = `e7-cap-test-${process.pid}`;
  afterAll(async () => {
    // best-effort cleanup of the test pod's lease set
    // (RedisLeaseStore has no delete-key; release each member we added)
    for (const id of ["r0", "r1", "r2", "r3", "r4"]) await store.release(pod, id);
  });

  it("grants at most `cap` concurrent leases", async () => {
    const cap = 3;
    const results: boolean[] = [];
    for (const id of ["r0", "r1", "r2", "r3", "r4"]) {
      results.push(await store.acquire(pod, cap, id, 60_000));
    }
    expect(results.filter(Boolean).length).toBe(cap); // exactly 3 granted, 2 refused
    expect(await store.load(pod)).toBe(cap);
  });
});
