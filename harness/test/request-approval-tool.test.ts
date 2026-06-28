// harness/test/request-approval-tool.test.ts
import { describe, it, expect } from "vitest";
import { requestApprovalExtension, type GateCapture } from "../src/request-approval-tool";

function fakePi() {
  const tools: any[] = [];
  return { api: { registerTool: (t: any) => tools.push(t), on: () => {} } as any, tools };
}

describe("requestApprovalExtension", () => {
  it("registers a request_approval tool", () => {
    const { api, tools } = fakePi();
    requestApprovalExtension({}, undefined, 0)(api);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("request_approval");
  });

  it("captures the gate (with nextGateId) and appends a durable gate-request entry", async () => {
    const capture: GateCapture = {};
    const appended: Array<{ t: string; d: unknown }> = [];
    const sink = { appendCustomEntry: (t: string, d?: unknown) => { appended.push({ t, d }); return "id"; } };
    const { api, tools } = fakePi();
    requestApprovalExtension(capture, sink, 3)(api);
    const res = await tools[0].execute("call-1", { summary: "did X", proposed_action: "do Y" }, undefined, undefined, {} as any);
    expect(capture.gate).toEqual({ gateId: 3, summary: "did X", proposed_action: "do Y" });
    expect(appended).toEqual([{ t: "gate-request", d: { gateId: 3, summary: "did X", proposed_action: "do Y" } }]);
    expect(res.isError).toBeFalsy();
  });

  it("rejects empty summary/proposed_action and does not capture or append", async () => {
    const capture: GateCapture = {};
    const appended: unknown[] = [];
    const sink = { appendCustomEntry: (t: string, d?: unknown) => { appended.push({ t, d }); return "id"; } };
    const { api, tools } = fakePi();
    requestApprovalExtension(capture, sink, 0)(api);
    const res = await tools[0].execute("c", { summary: "", proposed_action: "y" }, undefined, undefined, {} as any);
    expect(capture.gate).toBeUndefined();
    expect(appended).toHaveLength(0);
    expect(res.isError).toBe(true);
  });
});
