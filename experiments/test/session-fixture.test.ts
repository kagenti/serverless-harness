import { describe, it, expect, afterAll } from "vitest";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "@sh/harness/buffered-redis-backend";
import { buildCompactedSession } from "../src/session-fixture";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const store = new RedisSessionBackend<FileEntry>(REDIS);
const sids: string[] = [];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  await store.close();
});

describe("buildCompactedSession", () => {
  it("produces a compacted, checkpointed session whose tail is far smaller than the full log", async () => {
    const fx = await buildCompactedSession(store, { n: 40, tailKept: 4 });
    sids.push(fx.sessionId);

    expect(fx.fullLength).toBeGreaterThan(40); // n messages + compaction + marker
    expect(fx.tailLength).toBeLessThan(fx.fullLength);
    expect(fx.tailLength).toBeLessThanOrEqual(10); // ~tailKept + compaction + marker

    const backend = new BufferedRedisBackend(store);
    const marker = await backend.latestCheckpoint(fx.sessionId);
    expect((marker as { customType?: string } | null)?.customType).toBe("checkpoint");
  });

  it("reconstructs identically via openFromCheckpoint and openFromBackend (parity)", async () => {
    const fx = await buildCompactedSession(store, { n: 30, tailKept: 4 });
    sids.push(fx.sessionId);

    const backend = new BufferedRedisBackend(store);
    const viaCheckpoint = await SessionManager.openFromCheckpoint(fx.sessionId, backend, process.cwd());
    const viaBackend = await SessionManager.openFromBackend(fx.sessionId, backend, process.cwd());
    expect(viaCheckpoint.buildSessionContext()).toEqual(viaBackend.buildSessionContext());
  });
});
