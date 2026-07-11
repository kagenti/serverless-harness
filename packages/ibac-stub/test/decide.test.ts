import { describe, it, expect } from "vitest";
import { decide } from "../src/decide.js";

describe("decide", () => {
  it("allows by default (empty rules)", () => {
    const result = decide("GET https://example.com/anything", {});
    expect(result.verdict).toBe("allow");
  });

  it("denies when action text contains a denyTools entry", () => {
    const result = decide("tool call: delete_repo({\"repo\":\"foo\"})", {
      denyTools: ["delete_repo"],
    });
    expect(result.verdict).toBe("deny");
  });

  it("denies when action text contains a denyUrlSubstrings entry", () => {
    const result = decide("POST https://internal.example.com/admin/wipe", {
      denyUrlSubstrings: ["internal.example.com/admin"],
    });
    expect(result.verdict).toBe("deny");
  });

  it("denies when action text contains a denyArgMarkers entry", () => {
    const result = decide("tool call: run_cmd({\"cmd\":\"rm -rf /\"})", {
      denyArgMarkers: ["rm -rf /"],
    });
    expect(result.verdict).toBe("deny");
  });

  it("reason is non-empty and names the rule on deny", () => {
    const result = decide("tool call: delete_repo({})", {
      denyTools: ["delete_repo"],
    });
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).toContain("delete_repo");
  });

  it("allow reason is set", () => {
    const result = decide("GET https://example.com/anything", {});
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
