// harness/src/leaf-job-runner.ts
import type { WorkQueue } from "@sh/work-queue";
import { classifyOutcome } from "./classify-outcome.js";
import { deriveDoneMarkerPath, writeDoneMarker, type DoneMarker } from "./done-marker.js";
import type { LeafEnvelope, LeafResult } from "./run-leaf.js";

export interface LeafJobDeps {
  queue: WorkQueue;
  runLeaf: (env: LeafEnvelope) => Promise<LeafResult>;
  writeMarker?: (path: string, m: DoneMarker) => void;
  consumerId: string;
  maxAttempts?: number;
  minIdleMs?: number;
  blockMs?: number;
  heartbeatMs?: number;
  now?: () => string;
  setHeartbeat?: (fn: () => void, ms: number) => unknown;
  clearHeartbeat?: (h: unknown) => void;
}

/**
 * Claim and process at most one queue entry. Returns a label describing the outcome.
 * - "idle": nothing to claim.
 * - "deadletter": delivery count exceeded → failed marker + ack, runLeaf not run.
 * - "done"/"failed": runLeaf reached a terminal state → marker + ack.
 * - "retry": transient error → NOT acked (entry stays pending for reclaim).
 */
export async function processOne(deps: LeafJobDeps): Promise<"done" | "failed" | "deadletter" | "idle" | "retry"> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const minIdleMs = deps.minIdleMs ?? 90_000;
  const blockMs = deps.blockMs ?? 5_000;
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const writeMarker = deps.writeMarker ?? writeDoneMarker;
  const now = deps.now ?? (() => new Date().toISOString());
  const setHb = deps.setHeartbeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearHb = deps.clearHeartbeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const claimed = await deps.queue.claim(deps.consumerId, { minIdleMs, blockMs });
  if (!claimed) return "idle";

  const env = claimed.envelope as LeafEnvelope;
  const markerPath = deriveDoneMarkerPath(env.resultRef, env.doneMarkerRef);

  if (claimed.deliveryCount > maxAttempts) {
    writeMarker(markerPath, { status: "failed", sessionId: env.sessionId, reason: "error", ts: now() });
    await deps.queue.ack(claimed.entryId);
    return "deadletter";
  }

  const hb = setHb(() => { void deps.queue.touch(claimed.entryId, deps.consumerId); }, heartbeatMs);
  let result: LeafResult;
  try {
    result = await deps.runLeaf(env);
  } finally {
    clearHb(hb);
  }

  const outcome = classifyOutcome(result);
  if (outcome.marker) {
    writeMarker(markerPath, { status: outcome.marker.status, sessionId: env.sessionId, reason: outcome.marker.reason, ts: now() });
  }
  if (outcome.ack) {
    await deps.queue.ack(claimed.entryId);
    return result.status === "done" ? "done" : "failed";
  }
  return "retry";
}
