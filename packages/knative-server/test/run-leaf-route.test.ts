import { describe, it, expect, vi, beforeEach } from "vitest";

const runLeaf = vi.fn();
vi.mock("@sh/harness/run-leaf", () => ({ runLeaf: (...a: any[]) => runLeaf(...a) }));

import { startServer } from "../src/server";

let base: string; let server: any;
beforeEach(() => { runLeaf.mockReset(); });

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("POST /run-leaf", () => {
  beforeEach(() => { server = startServer(0); base = `http://127.0.0.1:${server.address().port}`; });

  it("400s on a malformed envelope (missing inputsRef)", async () => {
    const r = await post("/run-leaf", { sessionId: "s", resultRef: "/x" });
    expect(r.status).toBe(400);
    server.close();
  });

  it("returns runLeaf's terminal status on a valid envelope", async () => {
    runLeaf.mockResolvedValue({ status: "done", resultRef: "/work/out.json" });
    const r = await post("/run-leaf", { sessionId: "s", inputsRef: "/in", resultRef: "/out" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: "done", resultRef: "/work/out.json" });
    expect(runLeaf).toHaveBeenCalledOnce();
    server.close();
  });
});
