import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the result store hermetic — no live Redis in unit tests. `resultSet` records every
// write so tests can assert whether a result record was persisted (it must NOT be on 503).
const resultSet = vi.fn();
vi.mock("@sh/harness/leaf-result-store", async (orig) => {
  const actual = await orig<typeof import("@sh/harness/leaf-result-store")>();
  const mem = new Map<string, string>();
  class FakeStore { async set(k: string, v: string) { resultSet(k, v); mem.set(k, v); } async get(k: string) { return mem.get(k) ?? null; } async close() {} }
  return { ...actual, RedisResultStore: FakeStore };
});

const runLeaf = vi.fn();
vi.mock("@sh/harness/run-leaf", () => ({
  runLeaf: (...a: any[]) => runLeaf(...a),
  validateItem: (o: any) => (o && typeof o.item_id === "string" && typeof o.file === "string" && typeof o.pattern === "string" ? o : null),
  leafSessionId: (env: any) => (env.sessionId ?? "leaf").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "") || "leaf",
}));

import { startServer } from "../src/server";

let base: string; let server: any;
beforeEach(() => { runLeaf.mockReset(); resultSet.mockReset(); });

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
}

describe("POST /runs", () => {
  beforeEach(() => { server = startServer(0); base = `http://127.0.0.1:${server.address().port}`; });
  afterEach(() => { server.close(); });

  it("400s on a malformed envelope (missing item)", async () => {
    const r = await post("/runs", { sessionId: "s" });
    expect(r.status).toBe(400);
  });

  it("returns the verdict inline on a valid envelope", async () => {
    runLeaf.mockResolvedValue({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
    const r = await post("/runs", { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
    expect(runLeaf).toHaveBeenCalledOnce();
  });
});

// Spec §4.3: the sync path must bound-wait with backoff on pool saturation, then 503 Retry-After.
describe("POST /runs saturation (spec §4.3)", () => {
  beforeEach(() => {
    // Tiny budget keeps the test fast; the loop re-attempts pool acquisition every few ms.
    process.env.KAGENTI_SYNC_SATURATION_WAIT_MS = "60";
    process.env.KAGENTI_SYNC_SATURATION_BACKOFF_MS = "5";
    process.env.KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS = "10";
    process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S = "7";
    server = startServer(0); base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => {
    server.close();
    delete process.env.KAGENTI_SYNC_SATURATION_WAIT_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_BACKOFF_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS;
    delete process.env.KAGENTI_SYNC_SATURATION_RETRY_AFTER_S;
  });

  it("returns 503 with Retry-After after the wait budget is exhausted", async () => {
    runLeaf.mockResolvedValue({ status: "failed", reason: "saturated" });
    const r = await post("/runs", { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("7");
    // Bounded WAIT with BACKOFF means the pool was re-attempted at least once before giving up.
    expect(runLeaf.mock.calls.length).toBeGreaterThan(1);
    // A 503 means "retry", not a terminal failure — no result record must be persisted.
    expect(resultSet).not.toHaveBeenCalled();
  });

  it("retries pool acquisition and returns the verdict once a pod frees", async () => {
    runLeaf
      .mockResolvedValueOnce({ status: "failed", reason: "saturated" })
      .mockResolvedValueOnce({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
    const r = await post("/runs", { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
    expect(runLeaf).toHaveBeenCalledTimes(2);
    expect(resultSet).toHaveBeenCalledOnce();
  });
});

// Regression: the pre-rename path must keep working as a deprecated alias (issue #37).
describe("POST /run-leaf (deprecated alias)", () => {
  beforeEach(() => { server = startServer(0); base = `http://127.0.0.1:${server.address().port}`; });
  afterEach(() => { server.close(); });

  it("still dispatches to runLeaf and warns about deprecation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runLeaf.mockResolvedValue({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
    const r = await post("/run-leaf", { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "done", verdict: { item_id: "i1", verdict: "CLEAR", reason: "ok" } });
    expect(runLeaf).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("/run-leaf");
    expect(msg).toContain("/runs");
    warn.mockRestore();
  });
});
