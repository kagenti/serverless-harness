import { describe, it, expect } from "vitest";
import { buildSelectorArgs, buildPodNameArgs, resolveSandboxConfig } from "../src/resolve-pod.js";

describe("arg builders", () => {
  it("builds selector args with jsonpath and optional context", () => {
    expect(buildSelectorArgs("sandbox-0", "default")).toEqual(["get", "sandbox", "sandbox-0", "-n", "default", "-o", "jsonpath={.status.selector}"]);
    expect(buildSelectorArgs("s", "ns", "kind-x")).toContain("--context");
  });
  it("builds pod-name args filtered to Running", () => {
    expect(buildPodNameArgs("app=sandbox", "default")).toEqual(["get", "pod", "-n", "default", "-l", "app=sandbox", "--field-selector=status.phase=Running", "-o", "jsonpath={.items[0].metadata.name}"]);
  });
});

describe("resolveSandboxConfig", () => {
  it("short-circuits to KAGENTI_SANDBOX_POD without any kubectl call", async () => {
    let called = false;
    const cfg = await resolveSandboxConfig({ KAGENTI_SANDBOX_POD: "sbx-0" }, "/head", async () => { called = true; return ""; });
    expect(cfg?.pod).toBe("sbx-0");
    expect(called).toBe(false);
  });
  it("returns null when neither POD nor NAME is set", async () => {
    expect(await resolveSandboxConfig({}, "/head", async () => "")).toBeNull();
  });
  it("resolves the pod via selector when NAME is set", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return args[1] === "sandbox" ? "app=sandbox,agents.x-k8s.io/sandbox=s" : "s-abc123"; };
    const cfg = await resolveSandboxConfig({ KAGENTI_SANDBOX_NAME: "s", KAGENTI_SANDBOX_NAMESPACE: "team1" }, "/head", run);
    expect(cfg).toEqual({ pod: "s-abc123", namespace: "team1", context: undefined, podCwd: "/workspace", headCwd: "/head" });
    expect(calls[0]).toContain("sandbox");
    expect(calls[1]).toContain("-l");
  });
  it("throws when the Sandbox has no selector yet", async () => {
    await expect(resolveSandboxConfig({ KAGENTI_SANDBOX_NAME: "s" }, "/head", async () => "")).rejects.toThrow(/selector/);
  });
});
