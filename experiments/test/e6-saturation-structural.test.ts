import { describe, it, expect } from "vitest";
import {
  detectKnee,
  dutyCycle,
  derivedRatio,
  sanityFloorPass,
  buildRatioCurve,
  type LadderPoint,
  type WorkloadPoint,
} from "../src/sharing";

describe("E6 — saturation analysis (structural)", () => {
  // Throughput rises then plateaus; p95 stays flat then blows up past the knee.
  const series: LadderPoint[] = [
    { c: 1, throughput: 1.0, p95Ms: 1000 },
    { c: 2, throughput: 1.9, p95Ms: 1050 },
    { c: 4, throughput: 3.6, p95Ms: 1200 },
    { c: 8, throughput: 5.0, p95Ms: 1900 },
    { c: 16, throughput: 5.1, p95Ms: 4200 }, // plateau + latency blowup
  ];

  it("detects the knee as the last still-scaling point within the latency bound", () => {
    // degradeX=2 => p95 bound = 2000ms; c=16 exceeds it and throughput plateaued.
    expect(detectKnee(series, 2)).toBe(8);
  });

  it("throws when there is no c=1 baseline", () => {
    expect(() => detectKnee([{ c: 2, throughput: 1, p95Ms: 1 }], 2)).toThrow(/baseline/);
  });

  it("computes duty cycle and derived ratio", () => {
    expect(dutyCycle(250, 1000)).toBeCloseTo(0.25, 5);
    expect(derivedRatio(0.25)).toBe(4.0);
    expect(() => dutyCycle(1, 0)).toThrow();
    expect(() => derivedRatio(0)).toThrow();
  });

  it("caps duty cycle at 1 and enforces the sanity floor", () => {
    expect(dutyCycle(1500, 1000)).toBe(1);
    expect(sanityFloorPass(8, 4)).toBe(true);
    expect(sanityFloorPass(2, 4)).toBe(false);
  });
});

describe("buildRatioCurve — N as a function of per-leaf sandbox work", () => {
  it("maps each workload point to duty + N, N decreasing as sandbox work rises", () => {
    const pts: WorkloadPoint[] = [
      { label: "L0", execMs: 300, execCount: 2, wallMs: 12000 },
      { label: "L1", execMs: 1200, execCount: 6, wallMs: 12000 },
      { label: "L2", execMs: 3000, execCount: 14, wallMs: 12000 },
    ];
    const curve = buildRatioCurve(pts);
    expect(curve.map((c) => c.label)).toEqual(["L0", "L1", "L2"]);
    expect(curve[0].duty).toBeCloseTo(0.025, 3);
    expect(curve[0].n).toBe(40); // 1/0.025
    expect(curve[0].execCount).toBe(2);
    // heavier sandbox work at equal wall => higher duty => lower N
    expect(curve[2].duty).toBeGreaterThan(curve[0].duty);
    expect(curve[2].n).toBeLessThan(curve[0].n);
  });

  it("propagates the dutyCycle guard (wallMs <= 0 throws)", () => {
    expect(() => buildRatioCurve([{ label: "x", execMs: 1, execCount: 1, wallMs: 0 }])).toThrow();
  });
});
