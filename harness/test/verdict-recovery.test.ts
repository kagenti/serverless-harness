import { describe, it, expect } from "vitest";
import { verdictFromCustomEntry, toSessionId } from "../src/run-leaf";

describe("toSessionId", () => {
  it("maps the spec's <run>/<item> id to a valid Pi session id", () => {
    expect(toSessionId("run-1106/i1")).toBe("run-1106-i1");
  });
  it("replaces every invalid char and trims to alphanumeric ends", () => {
    expect(toSessionId("/a b/c/")).toBe("a-b-c");
    expect(toSessionId("a.b_c-d")).toBe("a.b_c-d"); // dots, underscores, dashes are allowed
  });
  it("is deterministic so a retry maps to the same session", () => {
    expect(toSessionId("run/x")).toBe(toSessionId("run/x"));
  });
  it("falls back to a non-empty id when nothing valid remains", () => {
    expect(toSessionId("///")).toBe("leaf");
  });
});

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
