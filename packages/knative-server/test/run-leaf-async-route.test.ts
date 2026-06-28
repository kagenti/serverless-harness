// packages/knative-server/test/run-leaf-async-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueue = vi.fn(async () => "1-0");
const ensureGroup = vi.fn(async () => {});
vi.mock("@sh/work-queue", () => ({
  RedisWorkQueue: class { ensureGroup = ensureGroup; enqueue = enqueue; close = async () => {}; },
}));
const readDoneMarker = vi.fn();
vi.mock("@sh/harness/done-marker", () => ({
  readDoneMarker: (...a: any[]) => readDoneMarker(...a),
  deriveDoneMarkerPath: (r: string, o?: string) => o ?? `${r}.status`,
}));

import { startServer } from "../src/server";

let base: string; let server: any;
beforeEach(() => { enqueue.mockClear(); readDoneMarker.mockReset(); });
async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("async /run-leaf", () => {
  beforeEach(() => { server = startServer(0); base = `http://127.0.0.1:${server.address().port}`; });

  it("202 + enqueues on async:true with a valid envelope", async () => {
    const r = await req("POST", "/run-leaf", { sessionId: "run/i1", inputsRef: "/in", resultRef: "/out", async: true });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: "accepted", sessionId: "run/i1", doneMarker: "/out.status" });
    expect(enqueue).toHaveBeenCalledOnce();
    server.close();
  });

  it("400 and no enqueue on a malformed async envelope", async () => {
    const r = await req("POST", "/run-leaf", { sessionId: "s", async: true });
    expect(r.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    server.close();
  });

  it("status returns done from the marker", async () => {
    readDoneMarker.mockReturnValue({ status: "done", sessionId: "run/i1", reason: null, ts: "t" });
    const r = await req("GET", "/run-leaf/status?doneMarker=/work/out.status&sessionId=run/i1");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "done" });
    server.close();
  });

  it("status returns queued when no marker yet", async () => {
    readDoneMarker.mockReturnValue(null);
    const r = await req("GET", "/run-leaf/status?doneMarker=/work/out.status&sessionId=run/i1");
    expect(r.json).toMatchObject({ status: "queued" });
    server.close();
  });

  it("status rejects a doneMarker outside the work root (path traversal)", async () => {
    const r = await req("GET", "/run-leaf/status?doneMarker=/etc/passwd");
    expect(r.status).toBe(403);
    expect(readDoneMarker).not.toHaveBeenCalled();
    server.close();
  });
});
