export interface LadderPoint {
  c: number;          // concurrent leaves at this rung
  throughput: number; // aggregate leaves/sec
  p95Ms: number;      // per-leaf p95 latency at this rung
}

/**
 * The knee = the highest concurrency that is still "healthy": p95 within
 * `degradeX` of the single-leaf baseline AND throughput still rising vs the
 * previous rung. That c is the recommended KAGENTI_SANDBOX_CAP.
 */
export function detectKnee(points: LadderPoint[], degradeX: number): number {
  const baseline = points.find((p) => p.c === 1);
  if (!baseline) throw new Error("detectKnee: no c=1 baseline point");
  const bound = baseline.p95Ms * degradeX;
  const sorted = [...points].sort((a, b) => a.c - b.c);
  let knee = 1;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    const withinLatency = cur.p95Ms <= bound;
    const stillScaling = cur.throughput > prev.throughput;
    if (withinLatency && stillScaling) knee = cur.c;
    else break;
  }
  return knee;
}

/** Fraction of wall-clock the sandbox was busy on this leaf's execs; in (0, 1]. */
export function dutyCycle(execBusyMs: number, wallMs: number): number {
  if (wallMs <= 0) throw new Error("dutyCycle: wallMs must be > 0");
  return Math.min(1, execBusyMs / wallMs);
}

/** How many such leaves time-share one sandbox before it is continuously busy. */
export function derivedRatio(duty: number): number {
  if (duty <= 0) throw new Error("derivedRatio: duty must be > 0");
  return Math.round((1 / duty) * 10) / 10;
}

/** CI floor: one sandbox must sustain at least `minConcurrency` healthy leaves. */
export function sanityFloorPass(knee: number, minConcurrency: number): boolean {
  return knee >= minConcurrency;
}

export interface LeafObservation {
  runId: string;
  expectedRef: string;   // the ref this leaf's envelope pinned
  observedMarker: string; // marker.txt content read from its worktree
}

/** Every leaf must have seen its own ref's marker — no sibling leakage. */
export function worktreeConsistent(obs: LeafObservation[]): {
  ok: boolean;
  mismatches: LeafObservation[];
} {
  const mismatches = obs.filter((o) => o.observedMarker !== o.expectedRef);
  return { ok: mismatches.length === 0, mismatches };
}
