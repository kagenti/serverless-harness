import { describe, it, expect } from "vitest";
import { reservationBenefit } from "../src/sharing.js";
describe("reservationBenefit", () => {
  it("computes dedicated:shared reservation-seconds ratio and the latency guardrail", () => {
    const ded = { arm: "dedicated" as const, resvSecPerLeaf: 120, p95Ms: 10000, throughput: 0.3, peakPods: 8 };
    const shr = { arm: "shared" as const, resvSecPerLeaf: 20, p95Ms: 11000, throughput: 0.29, peakPods: 2 };
    const r = reservationBenefit(ded, shr, 2);
    expect(r.ratio).toBe(6);           // 120/20
    expect(r.withinDegrade).toBe(true); // 11000 <= 2*10000
  });
  it("flags degraded latency", () => {
    const ded = { arm: "dedicated" as const, resvSecPerLeaf: 120, p95Ms: 5000, throughput: 0.3, peakPods: 8 };
    const shr = { arm: "shared" as const, resvSecPerLeaf: 20, p95Ms: 20000, throughput: 0.1, peakPods: 2 };
    expect(reservationBenefit(ded, shr, 2).withinDegrade).toBe(false);
  });
});
