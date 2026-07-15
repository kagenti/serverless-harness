import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { startServer } from "../src/server.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = startServer({ denyTools: ["delete_repo"] }, 0); // port 0 = random available port
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /healthz", () => {
  it("returns 200", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/chat/completions", () => {
  it("returns an allow verdict for a benign action", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ibac-judge",
        messages: [{ role: "user", content: "GET https://example.com/status" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const verdict = JSON.parse(body.choices[0].message.content);
    expect(verdict).toEqual({ verdict: "allow", reason: "no matching deny rule" });
  });

  it("returns a deny verdict when the action text matches a configured deny rule", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ibac-judge",
        messages: [{ role: "user", content: "tool call: delete_repo({\"repo\":\"foo\"})" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const verdict = JSON.parse(body.choices[0].message.content);
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toContain("delete_repo");
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not valid json{{{",
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 with an allow verdict for a JSON null body", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const verdict = JSON.parse(body.choices[0].message.content);
    expect(verdict).toEqual({ verdict: "allow", reason: "no matching deny rule" });
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });
});
