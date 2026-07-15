import { describe, it, expect } from "vitest";
import { rulesFromEnv } from "../src/main.js";

describe("rulesFromEnv", () => {
  it("reads deny lists from a caller-supplied env object, not process.env", () => {
    const env = {
      IBAC_STUB_DENY_TOOLS: "delete_repo, wipe_db",
      IBAC_STUB_DENY_URLS: "internal.example.com/admin",
      IBAC_STUB_DENY_ARG_MARKERS: "rm -rf /",
    };

    const rules = rulesFromEnv(env);

    expect(rules.denyTools).toEqual(["delete_repo", "wipe_db"]);
    expect(rules.denyUrlSubstrings).toEqual(["internal.example.com/admin"]);
    expect(rules.denyArgMarkers).toEqual(["rm -rf /"]);
  });

  it("returns undefined entries when the supplied env has no matching vars set", () => {
    const rules = rulesFromEnv({});

    expect(rules.denyTools).toBeUndefined();
    expect(rules.denyUrlSubstrings).toBeUndefined();
    expect(rules.denyArgMarkers).toBeUndefined();
  });
});
