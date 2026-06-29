import { createClient, type RedisClientType } from "redis";

export interface ClaimedEntry {
  entryId: string;
  envelope: unknown;
  deliveryCount: number;
}

export interface WorkQueue {
  ensureGroup(): Promise<void>;
  enqueue(envelope: unknown): Promise<string>;
  claim(consumerId: string, opts: { minIdleMs: number; blockMs: number }): Promise<ClaimedEntry | null>;
  ack(entryId: string): Promise<void>;
  touch(entryId: string, consumerId: string): Promise<void>;
  pending(): Promise<number>;
  deleteConsumer(consumerId: string): Promise<void>;
  gcIdleConsumers(minIdleMs: number): Promise<number>;
  reapDeadLetters(consumerId: string, opts: { minIdleMs: number; maxAttempts: number }): Promise<Array<{ entryId: string; envelope: unknown }>>;
  purge(): Promise<void>;
  close(): Promise<void>;
}

export class RedisWorkQueue implements WorkQueue {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(
    url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    private readonly stream = "leaf-queue",
    private readonly group = "leaf-workers",
  ) {
    this.client = createClient({ url }) as RedisClientType;
    this.ready = this.client.connect().then(() => undefined);
  }

  async ensureGroup(): Promise<void> {
    await this.ready;
    try {
      // "0" = deliver from the start of the stream; MKSTREAM creates it if absent.
      await this.client.xGroupCreate(this.stream, this.group, "0", { MKSTREAM: true });
    } catch (err) {
      if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
    }
  }

  async enqueue(envelope: unknown): Promise<string> {
    await this.ready;
    return this.client.xAdd(this.stream, "*", { envelope: JSON.stringify(envelope) });
  }

  async claim(consumerId: string, opts: { minIdleMs: number; blockMs: number }): Promise<ClaimedEntry | null> {
    await this.ready;
    // 1. Prefer reclaiming a stale (delivered-but-unacked) entry — crash recovery.
    const auto = await this.client.xAutoClaim(this.stream, this.group, consumerId, opts.minIdleMs, "0", { COUNT: 1 });
    const reclaimed = auto.messages?.find((m) => m && m.message);
    if (reclaimed) {
      return { entryId: reclaimed.id, envelope: JSON.parse(reclaimed.message.envelope), deliveryCount: await this.deliveryCount(reclaimed.id) };
    }
    // 2. Otherwise read a brand-new entry.
    const res = await this.client.xReadGroup(this.group, consumerId, [{ key: this.stream, id: ">" }], { COUNT: 1, BLOCK: opts.blockMs });
    const msg = res?.[0]?.messages?.[0];
    if (!msg) return null;
    return { entryId: msg.id, envelope: JSON.parse(msg.message.envelope), deliveryCount: 1 };
  }

  private async deliveryCount(id: string): Promise<number> {
    const rows = await this.client.xPendingRange(this.stream, this.group, id, id, 1);
    return rows?.[0]?.deliveriesCounter ?? 1;
  }

  async ack(entryId: string): Promise<void> {
    await this.ready;
    await this.client.xAck(this.stream, this.group, entryId);
  }

  async touch(entryId: string, consumerId: string): Promise<void> {
    await this.ready;
    // Reset idle time without re-fetching the payload, so a healthy long run is not reclaimed.
    await this.client.xClaimJustId(this.stream, this.group, consumerId, 0, [entryId]);
  }

  async pending(): Promise<number> {
    await this.ready;
    const summary = await this.client.xPending(this.stream, this.group);
    return summary?.pending ?? 0;
  }

  async deleteConsumer(consumerId: string): Promise<void> {
    await this.ready;
    await this.client.xGroupDelConsumer(this.stream, this.group, consumerId);
  }

  async gcIdleConsumers(minIdleMs: number): Promise<number> {
    await this.ready;
    const info = await this.client.xInfoConsumers(this.stream, this.group);
    let removed = 0;
    for (const c of info) {
      if (c.pending === 0 && c.idle >= minIdleMs) {
        await this.client.xGroupDelConsumer(this.stream, this.group, c.name);
        removed++;
      }
    }
    return removed;
  }

  async reapDeadLetters(consumerId: string, opts: { minIdleMs: number; maxAttempts: number }): Promise<Array<{ entryId: string; envelope: unknown }>> {
    await this.ready;
    const deadLettered: Array<{ entryId: string; envelope: unknown }> = [];
    const pending = await this.client.xPendingRange(this.stream, this.group, "-", "+", 100);
    for (const entry of pending) {
      if (entry.millisecondsSinceLastDelivery >= opts.minIdleMs && entry.deliveriesCounter > opts.maxAttempts) {
        const claimed = await this.client.xClaim(this.stream, this.group, consumerId, opts.minIdleMs, [entry.id]);
        const msg = claimed?.[0];
        await this.client.xAck(this.stream, this.group, entry.id);
        const envelope = msg?.message?.envelope ? JSON.parse(msg.message.envelope) : null;
        deadLettered.push({ entryId: entry.id, envelope });
      }
    }
    return deadLettered;
  }

  async purge(): Promise<void> {
    await this.ready;
    try { await this.client.xGroupDestroy(this.stream, this.group); } catch { /* ignore */ }
    try { await this.client.del(this.stream); } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    await this.ready;
    await this.client.close();
  }
}
