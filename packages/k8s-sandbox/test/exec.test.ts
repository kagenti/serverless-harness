import { describe, expect, it } from "vitest";
import { buildKubectlArgs, shouldEmitExecTiming, formatExecTiming } from "../src/exec.js";
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

describe("exec timing (env-gated)", () => {
  it("is off unless KAGENTI_EXEC_TIMING=1", () => {
    expect(shouldEmitExecTiming({})).toBe(false);
    expect(shouldEmitExecTiming({ KAGENTI_EXEC_TIMING: "0" })).toBe(false);
    expect(shouldEmitExecTiming({ KAGENTI_EXEC_TIMING: "1" })).toBe(true);
  });

  it("formats a single stable line, truncating and flattening the command", () => {
    const line = formatExecTiming("sandbox-1", 42, "git -C /workspace/repo fetch\norigin branch-0");
    expect(line).toBe(
      "[exec-timing] pod=sandbox-1 ms=42 cmd=git -C /workspace/repo fetch origin branch-0\n",
    );
    const long = formatExecTiming("p", 1, "x".repeat(200));
    expect(long).toBe(`[exec-timing] pod=p ms=1 cmd=${"x".repeat(60)}\n`);
  });
});
