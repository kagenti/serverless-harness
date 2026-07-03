import { describe, it, expect } from "vitest";
import { leaseKey, activeCount } from "../src/sandbox-lease.js";

describe("leaseKey", () => {
  it("namespaces per pod", () => {
    expect(leaseKey("sandbox-1-0")).toBe("sh:sandbox:sandbox-1-0:leases");
  });
});

describe("activeCount", () => {
  const now = 1_000_000;
  it("counts only members whose expiry is strictly in the future", () => {
    const members = [
      { value: "a", score: now - 1 },   // expired
      { value: "b", score: now },       // expired (boundary: not > now)
      { value: "c", score: now + 1 },   // active
      { value: "d", score: now + 500 }, // active
    ];
    expect(activeCount(members, now)).toBe(2);
  });
  it("is 0 for an empty set", () => {
    expect(activeCount([], now)).toBe(0);
  });
});
