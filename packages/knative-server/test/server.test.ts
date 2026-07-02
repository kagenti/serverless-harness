import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";

// Mock runTurn before importing server
vi.mock("@sh/harness/run-turn", () => ({
  runTurn: vi.fn(),
}));

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

import { startServer } from "../src/server.js";
import { runTurn } from "@sh/harness/run-turn";

const mockedRunTurn = vi.mocked(runTurn);
let server: ReturnType<typeof startServer>;
let baseUrl: string;

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("Content-Type", "application/json");
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  server = startServer(0); // port 0 = random available port
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const res = await request("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });
});

describe("POST /turn", () => {
  it("returns 200 with session result on success", async () => {
    mockedRunTurn.mockResolvedValueOnce({
      sessionId: "test-session-1",
      response: "Hello!",
      stopReason: "end_turn",
    });

    const res = await request("POST", "/turn", { prompt: "Hi" });
    expect(res.status).toBe(200);

    const json = JSON.parse(res.body);
    expect(json.sessionId).toBe("test-session-1");
    expect(json.response).toBe("Hello!");
    expect(json.stopReason).toBe("end_turn");
  });

  it("passes sessionId to runTurn when provided", async () => {
    mockedRunTurn.mockResolvedValueOnce({
      sessionId: "existing-session",
      response: "Resumed!",
      stopReason: "end_turn",
    });

    const res = await request("POST", "/turn", {
      sessionId: "existing-session",
      prompt: "Continue",
    });
    expect(res.status).toBe(200);
    expect(mockedRunTurn).toHaveBeenCalledWith(
      "Continue",
      "existing-session",
      expect.any(Object),
    );
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await request("POST", "/turn", { sessionId: "abc" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("prompt_required");
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const url = new URL("/turn", baseUrl);
        const req = http.request(url, { method: "POST" }, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({
              status: r.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        });
        req.on("error", reject);
        req.write("not valid json{{{");
        req.end();
      },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_json");
  });

  it("returns 404 when session not found", async () => {
    mockedRunTurn.mockRejectedValueOnce(
      new Error("Cannot resume: no session in backend for id xyz"),
    );

    const res = await request("POST", "/turn", {
      sessionId: "xyz",
      prompt: "hello",
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("session_not_found");
  });

  it("returns 500 on unexpected errors", async () => {
    mockedRunTurn.mockRejectedValueOnce(new Error("LLM timeout"));

    const res = await request("POST", "/turn", { prompt: "hello" });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toBe("LLM timeout");
  });
});

describe("GET /runs/status", () => {
  it("GET /runs/status returns queued when no record exists", async () => {
    const r = await (await fetch(`${baseUrl}/runs/status?sessionId=run/none`)).json();
    expect(r).toEqual({ status: "queued" });
  });
  it("GET /runs/status returns the record after a sync run", async () => {
    runLeaf.mockResolvedValue({ status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" } });
    await post("/runs", { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } });
    const r = await (await fetch(`${baseUrl}/runs/status?sessionId=run/i1`)).json();
    expect(r).toMatchObject({ status: "done", verdict: { item_id: "i1", verdict: "FLAGGED" } });
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await request("GET", "/unknown");
    expect(res.status).toBe(404);
  });
});
