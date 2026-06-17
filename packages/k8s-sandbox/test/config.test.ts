import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("returns null when KAGENTI_SANDBOX_POD is unset (the off gate)", () => {
    expect(resolveConfig({}, "/head")).toBeNull();
  });

  it("applies defaults when only the pod is set", () => {
    const cfg = resolveConfig({ KAGENTI_SANDBOX_POD: "sbx-0" }, "/head");
    expect(cfg).toEqual({
      pod: "sbx-0",
      namespace: "default",
      context: undefined,
      podCwd: "/workspace",
      headCwd: "/head",
    });
  });

  it("honours all overrides", () => {
    const cfg = resolveConfig(
      {
        KAGENTI_SANDBOX_POD: "sbx-0",
        KAGENTI_SANDBOX_NAMESPACE: "team1",
        KAGENTI_SANDBOX_CONTEXT: "kind-kagenti",
        KAGENTI_SANDBOX_CWD: "/repo",
      },
      "/head",
    );
    expect(cfg).toEqual({
      pod: "sbx-0",
      namespace: "team1",
      context: "kind-kagenti",
      podCwd: "/repo",
      headCwd: "/head",
    });
  });
});
