import { describe, it, expect } from "vitest";
import {
  resultKey, toResultRecord, writeResult, readResult, type RedisLike, type LeafResultRecord,
} from "../src/leaf-result-store";
import type { LeafResult } from "../src/run-leaf";

function fakeRedis(): RedisLike & { store: Map<string, string>; ttl: Map<string, number> } {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    store, ttl,
    async set(key, value, opts) { store.set(key, value); if (opts?.EX) ttl.set(key, opts.EX); },
    async get(key) { return store.get(key) ?? null; },
  };
}

describe("resultKey", () => {
  it("namespaces by leaf session id", () => {
    expect(resultKey("run-1-i1")).toBe("leaf:result:run-1-i1");
  });
});

describe("toResultRecord", () => {
  it("maps done → verdict-bearing record", () => {
    const r: LeafResult = { status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" } };
    expect(toResultRecord(r, "run-1/i1", "T")).toEqual({
      status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" },
      gate: null, reason: null, patch: null, usage: null, sessionId: "run-1/i1", ts: "T",
    });
  });
  it("maps paused → gate-bearing record", () => {
    const r: LeafResult = { status: "paused", gateId: 1, gate: { summary: "s", proposed_action: "a" } };
    expect(toResultRecord(r, "run-1/i1", "T")).toMatchObject({
      status: "paused", gate: { gateId: 1, summary: "s", proposed_action: "a" }, verdict: null, patch: null,
    });
  });
  it("maps failed → reason-bearing record", () => {
    const r: LeafResult = { status: "failed", reason: "no_verdict" };
    expect(toResultRecord(r, "s", "T")).toMatchObject({ status: "failed", reason: "no_verdict", patch: null });
  });
});

describe("toResultRecord — solved", () => {
  it("carries the patch and sets status solved", () => {
    const rec = toResultRecord({ status: "solved", patch: "diff --git a/x b/x\n" }, "run-1", "2026-07-14T00:00:00Z");
    expect(rec.status).toBe("solved");
    expect(rec.patch).toBe("diff --git a/x b/x\n");
    expect(rec.verdict).toBeNull();
    expect(rec.sessionId).toBe("run-1");
  });
  it("carries token usage when the solved result has it", () => {
    const rec = toResultRecord(
      { status: "solved", patch: "d", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 } },
      "run-1", "t",
    );
    expect(rec.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 });
  });
  it("defaults usage to null when the solved result has none", () => {
    expect(toResultRecord({ status: "solved", patch: "d" }, "run-1", "t").usage).toBeNull();
  });
  it("defaults patch to null for non-solve results", () => {
    const rec = toResultRecord({ status: "aborted" }, "run-1", "t");
    expect(rec.patch).toBeNull();
  });
});

describe("writeResult / readResult", () => {
  it("round-trips a record and sets the TTL", async () => {
    const redis = fakeRedis();
    const rec: LeafResultRecord = { status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" }, gate: null, reason: null, patch: null, sessionId: "run-1/i1", ts: "T" };
    await writeResult(redis, "run-1-i1", rec, 3600);
    expect(redis.ttl.get("leaf:result:run-1-i1")).toBe(3600);
    expect(await readResult(redis, "run-1-i1")).toEqual(rec);
  });
  it("returns null for a missing key", async () => {
    expect(await readResult(fakeRedis(), "nope")).toBeNull();
  });
  it("returns null for a garbled value", async () => {
    const redis = fakeRedis();
    await redis.set("leaf:result:x", "{not json", {});
    expect(await readResult(redis, "x")).toBeNull();
  });
});
