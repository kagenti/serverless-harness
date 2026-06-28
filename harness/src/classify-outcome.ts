import type { LeafResult } from "./run-leaf.js";

export interface Outcome {
  ack: boolean;
  marker: { status: "done" | "failed" | "aborted"; reason: string | null } | null;
  retryable: boolean;
}

/**
 * Decide what the leaf-job does with a queue entry given the leaf's terminal result.
 * - done / aborted / deterministic failures → ack (write a terminal marker where applicable).
 * - paused → ack with NO terminal marker (runLeaf already wrote the awaiting_approval gate marker;
 *   resume is a fresh re-invocation, not a redelivery).
 * - "error" (possibly transient) → no marker, no ack, retryable (reclaim).
 *   (A process crash never returns here at all → entry stays pending → reclaimed.)
 */
export function classifyOutcome(result: LeafResult): Outcome {
  if (result.status === "done") {
    return { ack: true, marker: { status: "done", reason: null }, retryable: false };
  }
  if (result.status === "paused") {
    return { ack: true, marker: null, retryable: false };
  }
  if (result.status === "aborted") {
    return { ack: true, marker: { status: "aborted", reason: null }, retryable: false };
  }
  if (result.reason === "error") {
    return { ack: false, marker: null, retryable: true };
  }
  return { ack: true, marker: { status: "failed", reason: result.reason }, retryable: false };
}
