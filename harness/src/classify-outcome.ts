import type { LeafResult } from "./run-leaf.js";

export interface Outcome {
  ack: boolean;
  retryable: boolean;
}

/**
 * Decide what the leaf-job does with a queue entry given the leaf's terminal result.
 * - done / paused / aborted / deterministic failures → ack (a result record is written by the caller).
 * - "error" (possibly transient) → no ack, retryable (entry stays pending → reclaimed).
 * - "saturated" → no ack, retryable: the async path has no bounded wait; the entry stays queued and
 *   drains as pool leases free (spec §4.3). (A process crash never returns here → stays pending → reclaimed.)
 */
export function classifyOutcome(result: LeafResult): Outcome {
  if (result.status === "failed" && (result.reason === "error" || result.reason === "saturated")) {
    return { ack: false, retryable: true };
  }
  return { ack: true, retryable: false };
}
