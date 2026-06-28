import { describe, it, expect, afterEach } from "vitest";
import { RedisWorkQueue } from "../src/queue";

const URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
let q: RedisWorkQueue;
// unique stream per test so runs don't collide
const stream = () => `test-leaf-queue-${process.pid}-${Math.floor(performance.now())}`;

afterEach(async () => { if (q) { await q.purge(); await q.close(); } });

describe("RedisWorkQueue", () => {
  it("enqueues and claims an entry with the envelope and deliveryCount 1", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s1", inputsRef: "/in", resultRef: "/out" });
    const c = await q.claim("worker-a", { minIdleMs: 5000, blockMs: 200 });
    expect(c).not.toBeNull();
    expect((c!.envelope as any).sessionId).toBe("s1");
    expect(c!.deliveryCount).toBe(1);
  });

  it("ack removes the entry from the pending list", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s2" });
    const c = await q.claim("worker-a", { minIdleMs: 5000, blockMs: 200 });
    await q.ack(c!.entryId);
    expect(await q.pending()).toBe(0);
  });

  it("claim returns null when there is no new or reclaimable work", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    const c = await q.claim("worker-a", { minIdleMs: 5000, blockMs: 100 });
    expect(c).toBeNull();
  });

  it("reclaims an unacked entry for another consumer and bumps deliveryCount", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s3" });
    const first = await q.claim("worker-a", { minIdleMs: 0, blockMs: 200 });
    expect(first!.deliveryCount).toBe(1);
    // worker-a never acks; worker-b reclaims with minIdle 0
    const second = await q.claim("worker-b", { minIdleMs: 0, blockMs: 200 });
    expect(second!.entryId).toBe(first!.entryId);
    expect(second!.deliveryCount).toBe(2);
  });
});
