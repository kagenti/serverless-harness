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
  // A transient "retry" rethrows below (non-zero exit) so the entry is reclaimed by a later Job.
  for (;;) {
    const outcome = await processOne({
      queue,
      runLeaf: (env: LeafEnvelope) => runLeaf(env, buildConfig()),
      consumerId,
    });
    if (outcome === "idle") break;
    if (outcome === "retry") { await queue.close(); process.exit(1); }
  }
  await queue.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("leaf-job error:", err);
  process.exit(1);
});
