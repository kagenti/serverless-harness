import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateDecision, readDecision,
  isGateRequestEntry, isGateDecisionEntry, gateRequestFromEntry, gateDecisionFromEntry,
  GATE_REQUEST_ENTRY_TYPE, GATE_DECISION_ENTRY_TYPE,
} from "../src/gate";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("validateDecision", () => {
  it("accepts approve/reject/abort with a numeric gateId", () => {
    expect(validateDecision({ gateId: 0, action: "approve" })).toEqual({
      ok: true, value: { gateId: 0, action: "approve", feedback: undefined },
    });
    expect(validateDecision({ gateId: 2, action: "reject", feedback: "do X" })).toEqual({
      ok: true, value: { gateId: 2, action: "reject", feedback: "do X" },
    });
    expect(validateDecision({ gateId: 1, action: "abort" }).ok).toBe(true);
  });
  it("rejects a bad action, missing gateId, or non-object", () => {
    expect(validateDecision({ gateId: 0, action: "maybe" }).ok).toBe(false);
    expect(validateDecision({ action: "approve" }).ok).toBe(false);
    expect(validateDecision(null).ok).toBe(false);
  });
});

describe("readDecision", () => {
  it("reads and validates a decision file; null on missing/garbled/invalid", () => {
    const p = join(dir, "d.json");
    writeFileSync(p, JSON.stringify({ gateId: 0, action: "approve" }));
    expect(readDecision(p)).toEqual({ gateId: 0, action: "approve", feedback: undefined });
    expect(readDecision(join(dir, "nope.json"))).toBeNull();
    writeFileSync(p, "{not json");
    expect(readDecision(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ gateId: 0, action: "nope" }));
    expect(readDecision(p)).toBeNull();
  });
});

describe("entry helpers", () => {
  const req = { type: "custom", customType: GATE_REQUEST_ENTRY_TYPE, data: { gateId: 0, summary: "s", proposed_action: "a" } };
  const dec = { type: "custom", customType: GATE_DECISION_ENTRY_TYPE, data: { gateId: 0, action: "approve" } };
  it("recognizes and extracts gate-request entries", () => {
    expect(isGateRequestEntry(req)).toBe(true);
    expect(isGateRequestEntry(dec)).toBe(false);
    expect(gateRequestFromEntry(req)).toEqual({ gateId: 0, summary: "s", proposed_action: "a" });
    expect(gateRequestFromEntry(dec)).toBeNull();
  });
  it("recognizes and extracts gate-decision entries", () => {
    expect(isGateDecisionEntry(dec)).toBe(true);
    expect(gateDecisionFromEntry(dec)).toEqual({ gateId: 0, action: "approve", feedback: undefined });
    expect(gateDecisionFromEntry(req)).toBeNull();
  });
});
