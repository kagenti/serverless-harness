import { describe, it, expect, afterAll } from "vitest";
import { type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { runTurn } from "@sh/harness/run-turn";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const LIVE = process.env.SH_RUN_LIVE === "1" && !!process.env.ANTHROPIC_AUTH_TOKEN;
const store = new RedisSessionBackend<FileEntry>(REDIS);
const sids: string[] = [];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  await store.close();
});

async function abortCount(sessionId: string): Promise<number> {
  const entries = await store.read(sessionId);
  return entries.filter(
    (r) => (r.entry as { type?: string }).type === "custom" &&
           (r.entry as { customType?: string }).customType === "abort",
  ).length;
}

describe("E5 — budget voter enforcement (live)", () => {
  // Skips unless SH_RUN_LIVE=1 and a key is present (see README).
  (LIVE ? it : it.skip)(
    "blocks a real tool call and records exactly one abort under a tiny cap",
    async () => {
      // SH_BUDGET_TOKENS=1 must be exported by the runner so run-turn registers the voter.
      expect(Number(process.env.SH_BUDGET_TOKENS)).toBeGreaterThan(0);
      // A prompt that forces a tool call (a tool must be registered — see README §tools).
      const prompt =
        "Use the shell tool to run `echo hello`. You must call a tool; do not answer directly.";
      const result = await runTurn(prompt, undefined, { redisUrl: REDIS });
      sids.push(result.sessionId);

      expect(await abortCount(result.sessionId)).toBe(1);
    },
    300_000,
  );
});
