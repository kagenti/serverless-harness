import { describe, it, expect } from "vitest";
import { validateVerdict } from "../src/verdict";

describe("validateVerdict", () => {
  it("accepts a well-formed verdict", () => {
    const r = validateVerdict({ item_id: "i1", verdict: "FLAGGED", reason: "calls eval on input" });
    expect(r).toEqual({ ok: true, value: { item_id: "i1", verdict: "FLAGGED", reason: "calls eval on input" } });
  });

  it("rejects an unknown verdict label", () => {
    const r = validateVerdict({ item_id: "i1", verdict: "MAYBE", reason: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(validateVerdict({ item_id: "i1", verdict: "CLEAR" }).ok).toBe(false);
    expect(validateVerdict({ verdict: "CLEAR", reason: "x" }).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateVerdict(null).ok).toBe(false);
    expect(validateVerdict("nope").ok).toBe(false);
  });
});
