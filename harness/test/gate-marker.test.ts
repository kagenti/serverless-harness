import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveGateRef, writeGateMarker, readGateMarker, type GateMarker } from "../src/gate-marker";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gatemk-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("deriveGateRef", () => {
  it("defaults to <resultRef>.gate and honors an override", () => {
    expect(deriveGateRef("/work/r/out.json")).toBe("/work/r/out.json.gate");
    expect(deriveGateRef("/work/r/out.json", "/work/r/custom.gate")).toBe("/work/r/custom.gate");
  });
});

describe("gate marker write/read", () => {
  it("round-trips an awaiting_approval marker (and creates parent dirs)", () => {
    const p = join(dir, "nested", "out.json.gate");
    const m: GateMarker = {
      status: "awaiting_approval", sessionId: "run/i1", gateId: 0,
      gate: { summary: "s", proposed_action: "a" }, ts: "2026-06-28T00:00:00.000Z",
    };
    writeGateMarker(p, m);
    expect(existsSync(p)).toBe(true);
    expect(readGateMarker(p)).toEqual(m);
  });
  it("returns null for a missing/garbled file", () => {
    expect(readGateMarker(join(dir, "nope.gate"))).toBeNull();
  });
  it("returns null for an off-shape marker (wrong status / missing fields)", () => {
    const p = join(dir, "bad.gate");
    writeFileSync(p, JSON.stringify({ status: "done", sessionId: "s", gateId: 0, ts: "t", gate: { summary: "x", proposed_action: "y" } }));
    expect(readGateMarker(p)).toBeNull(); // status must be awaiting_approval
    writeFileSync(p, JSON.stringify({ status: "awaiting_approval", sessionId: "s", gateId: 0, ts: "t", gate: { summary: "x" } }));
    expect(readGateMarker(p)).toBeNull(); // gate.proposed_action missing
  });
});
