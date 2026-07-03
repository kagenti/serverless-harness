import { describe, it, expect } from "vitest";
import { buildPoolPodsArgs, parsePodNames, listPoolPods } from "../src/pool.js";

describe("buildPoolPodsArgs", () => {
  it("lists Running pods by selector with a per-name jsonpath", () => {
    expect(buildPoolPodsArgs("app=sandbox", "default")).toEqual([
      "get", "pod", "-n", "default", "-l", "app=sandbox",
      "--field-selector=status.phase=Running",
      "-o", "jsonpath={range .items[*]}{.metadata.name}{'\\n'}{end}",
    ]);
  });
  it("adds --context when provided", () => {
    expect(buildPoolPodsArgs("app=sandbox", "team1", "kind-x")).toContain("--context");
  });
});

describe("parsePodNames", () => {
  it("splits, trims, and drops blanks", () => {
    expect(parsePodNames("sandbox-0-0\nsandbox-1-0\n\n  sandbox-2-0  \n")).toEqual([
      "sandbox-0-0", "sandbox-1-0", "sandbox-2-0",
    ]);
  });
  it("returns [] for empty output", () => {
    expect(parsePodNames("")).toEqual([]);
  });
});

describe("listPoolPods", () => {
  it("runs the built args and parses the result", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return "sandbox-0-0\nsandbox-1-0\n"; };
    const pods = await listPoolPods("app=sandbox", "default", undefined, run);
    expect(pods).toEqual(["sandbox-0-0", "sandbox-1-0"]);
    expect(calls[0]).toEqual(buildPoolPodsArgs("app=sandbox", "default"));
  });
});
