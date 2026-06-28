import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLeaf, buildLeafPrompt, leafSessionId, type LeafEnvelope } from "../src/run-leaf";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "leaf-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function envelope(): LeafEnvelope {
  const inputsRef = join(dir, "in.json");
  const resultRef = join(dir, "out.json");
  writeFileSync(inputsRef, JSON.stringify({ item_id: "i1", file: "a.py", pattern: "eval(" }));
  return { sessionId: "run/i1", inputsRef, resultRef };
}

describe("buildLeafPrompt", () => {
  it("includes the file, pattern, and submit_verdict instruction", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(" });
    expect(p).toContain("a.py");
    expect(p).toContain("eval(");
    expect(p).toContain("submit_verdict");
  });
});

describe("runLeaf", () => {
  it("writes the validated verdict to result_ref and returns done", async () => {
    const env = envelope();
    const produceVerdict = async (_i, _e, _c, capture) => {
      capture.verdict = { item_id: "i1", verdict: "FLAGGED", reason: "found eval" };
    };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toEqual({ status: "done", resultRef: env.resultRef });
    expect(JSON.parse(readFileSync(env.resultRef, "utf8"))).toEqual({
      item_id: "i1", verdict: "FLAGGED", reason: "found eval",
    });
  });

  it("returns failed:no_verdict and writes nothing when the agent submits none", async () => {
    const env = envelope();
    const produceVerdict = async () => { /* never captures */ };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toEqual({ status: "failed", reason: "no_verdict" });
    expect(existsSync(env.resultRef)).toBe(false);
  });

  it("returns failed:bad_inputs when inputs_ref is missing/invalid", async () => {
    const env = { ...envelope(), inputsRef: join(dir, "nope.json") };
    const res = await runLeaf(env, undefined, { produceVerdict: async () => {} });
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.reason).toBe("bad_inputs");
  });

  it("returns failed:invalid_verdict and writes nothing when verdict label is off-schema", async () => {
    const env = envelope();
    const produceVerdict = async (_i, _e, _c, capture) => {
      capture.verdict = { item_id: "i1", verdict: "MAYBE", reason: "x" };
    };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res).toMatchObject({ status: "failed", reason: "invalid_verdict" });
    expect(existsSync(env.resultRef)).toBe(false);
  });

  it("returns failed:error and writes nothing when produceVerdict throws", async () => {
    const env = envelope();
    const produceVerdict = async () => { throw new Error("boom"); };
    const res = await runLeaf(env, undefined, { produceVerdict });
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.reason).toBe("error");
    expect(existsSync(env.resultRef)).toBe(false);
  });
});

describe("leafSessionId", () => {
  it("sanitizes the bare sessionId when no tenant is set", () => {
    expect(leafSessionId({ sessionId: "run-1/i1" })).toBe("run-1-i1");
  });
  it("prefixes and sanitizes with the tenant for per-tenant id isolation", () => {
    expect(leafSessionId({ sessionId: "run-1/i1", tenant: "acme" })).toBe("acme-run-1-i1");
  });
});
