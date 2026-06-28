// packages/knative-server/src/leaf-job.ts
import { RedisWorkQueue } from "@sh/work-queue";
import { processOne } from "@sh/harness/leaf-job-runner";
import { runLeaf, type LeafEnvelope } from "@sh/harness/run-leaf";
import { type TurnConfig } from "@sh/harness/run-turn";

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
      await q.close();
      process.exit(1);
    }
  }
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
