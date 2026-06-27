import { describe, it, expect } from "vitest";
import { submitVerdictExtension, type VerdictCapture } from "../src/submit-verdict-tool";

// Minimal fake ExtensionAPI that records the registered tool.
function fakePi() {
  const tools: any[] = [];
  return { api: { registerTool: (t: any) => tools.push(t), on: () => {} } as any, tools };
}

describe("submitVerdictExtension", () => {
  it("registers a submit_verdict tool", () => {
    const capture: VerdictCapture = {};
    const { api, tools } = fakePi();
    submitVerdictExtension(capture)(api);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("submit_verdict");
  });

  it("captures a valid verdict and returns success", async () => {
    const capture: VerdictCapture = {};
    const { api, tools } = fakePi();
    submitVerdictExtension(capture)(api);
    const res = await tools[0].execute("call-1", { item_id: "i1", verdict: "FLAGGED", reason: "r" }, undefined, undefined, {} as any);
    expect(capture.verdict).toEqual({ item_id: "i1", verdict: "FLAGGED", reason: "r" });
    expect(res.isError).toBeFalsy();
  });

  it("rejects an invalid verdict and does not capture", async () => {
    const capture: VerdictCapture = {};
    const { api, tools } = fakePi();
    submitVerdictExtension(capture)(api);
    const res = await tools[0].execute("call-1", { item_id: "i1", verdict: "MAYBE", reason: "r" }, undefined, undefined, {} as any);
    expect(capture.verdict).toBeUndefined();
    expect(res.isError).toBe(true);
  });

  it("appends a durable verdict custom entry when a session manager is provided", async () => {
    const capture: VerdictCapture = {};
    const appended: Array<{ t: string; d: unknown }> = [];
    const sm = { appendCustomEntry: (t: string, d?: unknown) => { appended.push({ t, d }); return "id"; } };
    const { api, tools } = fakePi();
    submitVerdictExtension(capture, sm)(api);
    await tools[0].execute("c1", { item_id: "i1", verdict: "CLEAR", reason: "r" }, undefined, undefined, {} as any);
    expect(appended).toEqual([{ t: "verdict", d: { item_id: "i1", verdict: "CLEAR", reason: "r" } }]);
  });

  it("does not append a durable entry on an invalid verdict", async () => {
    const appended: Array<{ t: string; d: unknown }> = [];
    const sm = { appendCustomEntry: (t: string, d?: unknown) => { appended.push({ t, d }); return "id"; } };
    const { api, tools } = fakePi();
    submitVerdictExtension({}, sm)(api);
    await tools[0].execute("c1", { item_id: "i1", verdict: "MAYBE", reason: "r" }, undefined, undefined, {} as any);
    expect(appended).toEqual([]);
  });
});
