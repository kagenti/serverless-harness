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

async function main(): Promise<void> {
  const queue = new RedisWorkQueue(process.env.REDIS_URL);
  await queue.ensureGroup();
  const consumerId = process.env.HOSTNAME ?? `leaf-job-${process.pid}`;
  // Drain: process entries until the queue yields nothing, then exit so KEDA can scale to zero.
  // A transient "retry" exits non-zero (process.exit(1)) so the entry stays pending and a later Job reclaims it.
  try {
    for (;;) {
      const outcome = await processOne({
        queue,
        runLeaf: (env: LeafEnvelope) => runLeaf(env, buildConfig()),
        consumerId,
      });
      if (outcome === "idle") process.exit(0);
      if (outcome === "retry") process.exit(1);
    }
  } finally {
    try {
      await queue.close();
    } catch {
      // Best-effort close; suppress errors on exit.
    }
  }
}

main().catch(async (err) => {
  console.error("leaf-job error:", err);
  process.exit(1);
});
