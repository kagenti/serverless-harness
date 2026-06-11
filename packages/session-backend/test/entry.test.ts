// packages/session-backend/test/entry.test.ts
import { describe, it, expect } from "vitest";
import { makeEntry, ENTRY_TYPES } from "../src/entry";

describe("log entry schema", () => {
  it("stamps position, session_id, type, and a content hash", () => {
    const e = makeEntry({ position: 1, session_id: "s1", type: "user_message", data: { text: "hi" } });
    expect(e.position).toBe(1);
    expect(e.session_id).toBe("s1");
    expect(e.type).toBe("user_message");
    expect(e.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an unknown entry type at runtime", () => {
    // @ts-expect-error invalid type
    expect(() => makeEntry({ position: 1, session_id: "s1", type: "nope", data: {} })).toThrow();
  });

  it("exposes the full typed-entry vocabulary", () => {
    expect(ENTRY_TYPES).toContain("intention");
    expect(ENTRY_TYPES).toContain("commit");
    expect(ENTRY_TYPES).toContain("checkpoint");
  });
});
