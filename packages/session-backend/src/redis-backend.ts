// packages/session-backend/src/redis-backend.ts
import { createClient, type RedisClientType } from "redis";
import { makeEntry, type LogEntry, type NewEntry } from "./entry";
import type { SessionStorageBackend } from "./backend";

const streamKey = (sid: string) => `session:${sid}`;
const seqKey = (sid: string) => `session:${sid}:seq`;

export class RedisSessionBackend implements SessionStorageBackend {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379") {
    this.client = createClient({ url });
    this.ready = this.client.connect().then(() => undefined);
  }
  async nextPosition(sid: string): Promise<number> {
    await this.ready;
    return this.client.incr(seqKey(sid));
  }
  async append(e: NewEntry): Promise<LogEntry> {
    await this.ready;
    const entry = makeEntry({ ...e, timestamp: Date.now() });
    await this.client.xAdd(streamKey(e.session_id), "*", {
      position: String(entry.position),
      timestamp: String(entry.timestamp),
      type: entry.type,
      data: JSON.stringify(entry.data),
      content_sha256: entry.content_sha256,
    });
    return entry;
  }
  async read(sid: string, fromPosition = 1): Promise<LogEntry[]> {
    await this.ready;
    const rows = await this.client.xRange(streamKey(sid), "-", "+");
    return rows
      .map(r => ({
        position: Number(r.message.position),
        timestamp: Number(r.message.timestamp),
        session_id: sid,
        type: r.message.type as LogEntry["type"],
        data: JSON.parse(r.message.data),
        content_sha256: r.message.content_sha256,
      }))
      .filter(e => e.position >= fromPosition);
  }
  async latestCheckpoint(sid: string): Promise<LogEntry | null> {
    const all = await this.read(sid);
    const cps = all.filter(e => e.type === "checkpoint");
    return cps.length ? cps[cps.length - 1] : null;
  }
  async list(): Promise<string[]> {
    await this.ready;
    const keys = await this.client.keys("session:*");
    return keys.filter(k => !k.endsWith(":seq")).map(k => k.slice("session:".length));
  }
  async reset(sid: string): Promise<void> {
    await this.ready;
    await this.client.del([streamKey(sid), seqKey(sid)]);
  }
}
