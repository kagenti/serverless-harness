import type { LeafResult } from "./run-leaf.js";

export interface Outcome {
  ack: boolean;
  retryable: boolean;
}

/**
 * Decide what the leaf-job does with a queue entry given the leaf's terminal result.
 * - done / paused / aborted / deterministic failures → ack (a result record is written by the caller).
 * - "error" (possibly transient) → no ack, retryable (entry stays pending → reclaimed).
 *   (A process crash never returns here → entry stays pending → reclaimed.)
 */
export function classifyOutcome(result: LeafResult): Outcome {
  if (result.status === "failed" && result.reason === "error") {
    return { ack: false, retryable: true };
  }
  return { ack: true, retryable: false };
}
