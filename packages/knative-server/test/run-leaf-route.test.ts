import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the result store hermetic — no live Redis in unit tests.
vi.mock("@sh/harness/leaf-result-store", async (orig) => {
  const actual = await orig<typeof import("@sh/harness/leaf-result-store")>();
  const mem = new Map<string, string>();
  class FakeStore { async set(k: string, v: string) { mem.set(k, v); } async get(k: string) { return mem.get(k) ?? null; } async close() {} }
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
beforeEach(() => { runLeaf.mockReset(); });

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
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
