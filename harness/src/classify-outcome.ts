import type { LeafResult } from "./run-leaf.js";

export interface Outcome {
  ack: boolean;
  marker: { status: "done" | "failed"; reason: string | null } | null;
  retryable: boolean;
}

/**
 * Decide what the leaf-job does with a queue entry given the leaf's terminal result.
 * - done / deterministic failures → write a marker and ACK (no reprocess).
 * - "error" (possibly transient model/gateway) → no marker, no ack, retryable (reclaim).
 *   (A process crash never returns here at all → entry stays pending → reclaimed.)
 */
export function classifyOutcome(result: LeafResult): Outcome {
  if (result.status === "done") {
    return { ack: true, marker: { status: "done", reason: null }, retryable: false };
  }
  if (result.reason === "error") {
    return { ack: false, marker: null, retryable: true };
  }
  return { ack: true, marker: { status: "failed", reason: result.reason }, retryable: false };
}
