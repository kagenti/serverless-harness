// packages/session-backend/src/redis-backend.ts
import { createClient, type RedisClientType } from "redis";
import { makeStoredEntry, type StoredEntry } from "./entry";
import type { LogStore } from "./backend";

const streamKey = (sid: string) => `session:${sid}`;
const seqKey = (sid: string) => `session:${sid}:seq`;

/**
 * Redis Streams implementation of LogStore. Single-writer-per-session: a session is
 * owned by one harness instance at a time (mobility is sequential handoff, never
 * concurrent), so INCR(position) then XADD is safe without a transaction.
 *
 * Stream-id scheme (M5 cutover): each entry is stored with the explicit id
 * `"<position>-0"` (e.g. `"3-0"`), enabling O(tail) seeks in `read(fromPosition)`.
 * Sessions written by pre-M5 code used `"*"` (auto-generated ids) and are NOT
 * back-compatible; treat them as throwaway / reset before use.
 */
export class RedisSessionBackend<E = unknown> implements LogStore<E> {
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

  async append(sid: string, entry: E, piType: string): Promise<StoredEntry<E>> {
    await this.ready;
    const position = await this.nextPosition(sid);
    const stored = makeStoredEntry({ position, session_id: sid, piType, entry, timestamp: Date.now() });
    await this.client.xAdd(streamKey(sid), `${stored.position}-0`, {
      position: String(stored.position),
      timestamp: String(stored.timestamp),
      piType: stored.piType,
      entry: JSON.stringify(stored.entry),
      content_sha256: stored.content_sha256,
    });
    return stored;
  }

  async read(sid: string, fromPosition = 1): Promise<StoredEntry<E>[]> {
    await this.ready;
    const start = fromPosition <= 1 ? "-" : `${fromPosition}-0`;
    const rows = await this.client.xRange(streamKey(sid), start, "+");
    return rows.map((r): StoredEntry<E> => ({
      position: Number(r.message.position),
      timestamp: Number(r.message.timestamp),
      session_id: sid,
      piType: r.message.piType,
      entry: JSON.parse(r.message.entry) as E,
      content_sha256: r.message.content_sha256,
    }));
  }

  async latestWhere(sid: string, predicate: (entry: E) => boolean): Promise<StoredEntry<E> | null> {
    const all = await this.read(sid);
    const matches = all.filter((e) => predicate(e.entry));
    return matches.length ? matches[matches.length - 1] : null;
  }

  async positionOfId(sid: string, id: string): Promise<number | null> {
    const rows = await this.read(sid);
    for (const r of rows) {
      if ((r.entry as { id?: unknown } | null)?.id === id) return r.position;
    }
    return null;
  }

  async list(): Promise<string[]> {
    await this.ready;
    const keys = await this.client.keys("session:*");
    return keys.filter((k) => !k.endsWith(":seq")).map((k) => k.slice("session:".length));
  }

  /** Test helper: delete a session's stream + sequence counter. */
  async reset(sid: string): Promise<void> {
    await this.ready;
    await this.client.del([streamKey(sid), seqKey(sid)]);
  }

  /** Close the connection (call in test teardown). */
  async close(): Promise<void> {
    await this.ready;
    await this.client.quit();
  }
}
