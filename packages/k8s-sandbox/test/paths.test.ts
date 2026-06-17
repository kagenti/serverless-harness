import { describe, expect, it } from "vitest";
import { mapPath, shQuote } from "../src/paths.js";

describe("shQuote", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shQuote("/workspace/a.txt")).toBe("'/workspace/a.txt'");
  });
  it("escapes embedded single quotes", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("mapPath", () => {
  it("rewrites a head-cwd prefix to the pod cwd", () => {
    expect(mapPath("/Users/dev/proj/src/a.ts", "/Users/dev/proj", "/workspace")).toBe("/workspace/src/a.ts");
  });
  it("rewrites the head cwd itself", () => {
    expect(mapPath("/Users/dev/proj", "/Users/dev/proj", "/workspace")).toBe("/workspace");
  });
  it("leaves paths outside the head cwd untouched", () => {
    expect(mapPath("/etc/hosts", "/Users/dev/proj", "/workspace")).toBe("/etc/hosts");
  });
});
