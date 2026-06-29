// packages/knative-server/src/leaf-job.ts
import { RedisWorkQueue } from "@sh/work-queue";
import { processOne } from "@sh/harness/leaf-job-runner";
import { deriveDoneMarkerPath, writeDoneMarker } from "@sh/harness/done-marker";
import { runLeaf, type LeafEnvelope } from "@sh/harness/run-leaf";
import { type TurnConfig } from "@sh/harness/run-turn";

const MIN_IDLE_MS = 90_000;
const MAX_ATTEMPTS = 3;
const CONSUMER_GC_IDLE_MS = 300_000; // 5 min — GC consumers idle longer than this with 0 pending

function buildConfig(): TurnConfig {
  return {
    redisUrl: process.env.REDIS_URL,
    cwd: process.env.HARNESS_CWD || process.cwd(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  };
}

// Module-scoped so the top-level catch can close it if an exception escapes the drain loop.
let queue: RedisWorkQueue | undefined;

async function main(): Promise<void> {
  const q = new RedisWorkQueue(process.env.REDIS_URL);
  queue = q;
  await q.ensureGroup();
  const consumerId = process.env.HOSTNAME ?? `leaf-job-${process.pid}`;

  // Startup reap: dead-letter stale PEL entries past maxAttempts so pendingEntriesCount drops
  // and KEDA can scale to zero without waiting for reclaim cycles.
  const deadLettered = await q.reapDeadLetters(consumerId, { minIdleMs: MIN_IDLE_MS, maxAttempts: MAX_ATTEMPTS });
  for (const { envelope } of deadLettered) {
    if (envelope && typeof envelope === "object") {
      const env = envelope as LeafEnvelope;
      try {
        const path = deriveDoneMarkerPath(env.resultRef, env.doneMarkerRef);
        writeDoneMarker(path, { status: "failed", sessionId: env.sessionId, reason: "error", ts: new Date().toISOString() });
      } catch { /* best-effort marker write */ }
    }
  }
  if (deadLettered.length > 0) {
    console.log(`reaper: dead-lettered ${deadLettered.length} stale entries`);
  }

  // GC idle consumers with 0 pending entries (orphaned by completed/crashed pods).
  const gcCount = await q.gcIdleConsumers(CONSUMER_GC_IDLE_MS);
  if (gcCount > 0) {
    console.log(`reaper: removed ${gcCount} idle consumers`);
  }

  // Drain: process entries until the queue yields nothing ("idle"), then close and exit 0 so
  // KEDA can scale to zero. A transient "retry" closes and exits non-zero (process.exit(1)) so
  // the entry stays pending and a later Job reclaims it. (process.exit skips finally blocks, so
  // the queue is closed explicitly on each terminal path rather than in a finally.)
  for (;;) {
    const outcome = await processOne({
      queue: q,
      runLeaf: (env: LeafEnvelope) => runLeaf(env, buildConfig()),
      consumerId,
    });
    if (outcome === "idle") break;
    if (outcome === "retry") {
      // Entry stays pending for another pod to reclaim — do NOT delete our consumer.
      await q.close();
      process.exit(1);
    }
  }

  // Clean exit: no pending entries for us, safe to remove our consumer registration.
  await q.deleteConsumer(consumerId);
  await q.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("leaf-job error:", err);
  try {
    await queue?.close();
  } catch {
    // Best-effort close; suppress errors on exit.
  }
  process.exit(1);
});
