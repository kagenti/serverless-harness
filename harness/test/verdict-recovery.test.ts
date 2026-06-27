import { describe, it, expect } from "vitest";
import { verdictFromCustomEntry } from "../src/run-leaf";

const v = { item_id: "i1", verdict: "FLAGGED", reason: "r" };

describe("verdictFromCustomEntry", () => {
  it("recovers a verdict from a verdict custom entry", () => {
    expect(verdictFromCustomEntry({ type: "custom", customType: "verdict", data: v })).toEqual(v);
  });

  it("returns null for a non-verdict custom entry (e.g. a checkpoint marker)", () => {
    expect(
      verdictFromCustomEntry({ type: "custom", customType: "checkpoint", data: { resumeFromPosition: 3 } }),
    ).toBeNull();
  });

  it("returns null for a non-custom entry", () => {
    expect(verdictFromCustomEntry({ type: "message", role: "user", content: "hi" })).toBeNull();
  });

  it("returns null when the entry data is not a schema-valid verdict", () => {
    expect(
      verdictFromCustomEntry({ type: "custom", customType: "verdict", data: { item_id: "i1", verdict: "MAYBE", reason: "r" } }),
    ).toBeNull();
    expect(verdictFromCustomEntry(null)).toBeNull();
    expect(verdictFromCustomEntry(undefined)).toBeNull();
  });
});
