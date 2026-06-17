import { describe, expect, it } from "vitest";
import { buildKubectlArgs } from "../src/exec.js";
import type { K8sSandboxConfig } from "../src/config.js";

const base: K8sSandboxConfig = {
  pod: "sbx-0",
  namespace: "team1",
  context: undefined,
  podCwd: "/workspace",
  headCwd: "/head",
};

describe("buildKubectlArgs", () => {
  it("builds an interactive exec with namespace and bash -c", () => {
    expect(buildKubectlArgs(base, "cat '/workspace/a.txt'")).toEqual([
      "exec", "-i", "-n", "team1", "sbx-0", "--", "bash", "-c", "cat '/workspace/a.txt'",
    ]);
  });

  it("includes --context when set", () => {
    expect(buildKubectlArgs({ ...base, context: "kind-kagenti" }, "true")).toEqual([
      "exec", "-i", "-n", "team1", "--context", "kind-kagenti", "sbx-0", "--", "bash", "-c", "true",
    ]);
  });
});
