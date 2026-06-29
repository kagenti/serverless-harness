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

  it("deleteConsumer removes a consumer from the group", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s4" });
    const c = await q.claim("worker-del", { minIdleMs: 5000, blockMs: 200 });
    await q.ack(c!.entryId);
    await q.deleteConsumer("worker-del");
    // Consumer no longer exists — gcIdleConsumers should find nothing for it
    const removed = await q.gcIdleConsumers(0);
    expect(removed).toBe(0);
  });

  it("gcIdleConsumers removes consumers with 0 pending and idle >= threshold", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s5" });
    const c = await q.claim("worker-gc", { minIdleMs: 5000, blockMs: 200 });
    await q.ack(c!.entryId);
    // worker-gc now has 0 pending; after a tiny wait it's idle
    await new Promise((r) => setTimeout(r, 10));
    const removed = await q.gcIdleConsumers(0);
    expect(removed).toBe(1);
  });

  it("gcIdleConsumers does NOT remove consumers that still have pending entries", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s6" });
    await q.claim("worker-busy", { minIdleMs: 5000, blockMs: 200 });
    // worker-busy has 1 pending (unacked)
    const removed = await q.gcIdleConsumers(0);
    expect(removed).toBe(0);
  });

  it("reapDeadLetters ACKs entries past maxAttempts and returns their envelopes", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s7", resultRef: "/out" });
    // Simulate 4 deliveries by claiming+not-acking repeatedly (minIdle 0 to reclaim immediately)
    await q.claim("w1", { minIdleMs: 0, blockMs: 200 });
    await q.claim("w2", { minIdleMs: 0, blockMs: 200 });
    await q.claim("w3", { minIdleMs: 0, blockMs: 200 });
    await q.claim("w4", { minIdleMs: 0, blockMs: 200 });
    // Entry now has deliveryCount=4, idle resets on each claim but we use minIdleMs=0
    expect(await q.pending()).toBe(1);
    const dead = await q.reapDeadLetters("reaper", { minIdleMs: 0, maxAttempts: 3 });
    expect(dead).toHaveLength(1);
    expect((dead[0].envelope as any).sessionId).toBe("s7");
    expect(await q.pending()).toBe(0);
  });

  it("reapDeadLetters leaves entries with deliveryCount <= maxAttempts", async () => {
    q = new RedisWorkQueue(URL, stream());
    await q.ensureGroup();
    await q.enqueue({ sessionId: "s8" });
    // Only 1 delivery
    await q.claim("w1", { minIdleMs: 5000, blockMs: 200 });
    const dead = await q.reapDeadLetters("reaper", { minIdleMs: 0, maxAttempts: 3 });
    expect(dead).toHaveLength(0);
    expect(await q.pending()).toBe(1);
  });
});
