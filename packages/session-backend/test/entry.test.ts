import { describe, it, expect } from "vitest";
import { makeStoredEntry } from "../src/entry";

describe("makeStoredEntry", () => {
  it("wraps an opaque entry and hashes its JSON", () => {
    const e = makeStoredEntry({
      position: 1, session_id: "s", piType: "message",
      entry: { type: "message", x: 1 },
    });
    expect(e.position).toBe(1);
    expect(e.session_id).toBe("s");
    expect(e.piType).toBe("message");
    expect(e.entry).toEqual({ type: "message", x: 1 });
    expect(e.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.timestamp).toBe(0); // default when not provided
  });

  it("is deterministic: equal entries -> equal hash regardless of envelope fields", () => {
    const a = makeStoredEntry({ position: 1, session_id: "s", piType: "t", entry: { a: 1 } });
    const b = makeStoredEntry({ position: 9, session_id: "s2", piType: "t", entry: { a: 1 } });
    expect(a.content_sha256).toBe(b.content_sha256);
  });

  it("different entry content -> different hash", () => {
    const a = makeStoredEntry({ position: 1, session_id: "s", piType: "t", entry: { a: 1 } });
    const b = makeStoredEntry({ position: 1, session_id: "s", piType: "t", entry: { a: 2 } });
    expect(a.content_sha256).not.toBe(b.content_sha256);
  });
});
