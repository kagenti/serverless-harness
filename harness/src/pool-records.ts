import { createClient, type RedisClientType } from "redis";

export interface SandboxRecord {
  sandboxId: string;
  labels: Record<string, string>;
  capabilities: string[];
  capacityMax: number;
  transport: "grpc";
}

export interface RecordStore {
  put(rec: SandboxRecord): Promise<void>;
  remove(sandboxId: string): Promise<void>;
  list(): Promise<SandboxRecord[]>;
}

/** Redis hash of grpc presence records: field = sandboxId, value = JSON(SandboxRecord). */
export function recordsKey(): string {
  return "sh:sandbox:records";
}

/** node-redis-backed record store. Connects lazily; reuses REDIS_URL. */
export class RedisRecordStore implements RecordStore {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379") {
    this.client = createClient({ url }) as RedisClientType;
    this.ready = this.client.connect().then(() => undefined);
  }
  async put(rec: SandboxRecord): Promise<void> {
    await this.ready;
    await this.client.hSet(recordsKey(), rec.sandboxId, JSON.stringify(rec));
  }
  async remove(sandboxId: string): Promise<void> {
    await this.ready;
    await this.client.hDel(recordsKey(), sandboxId);
  }
  async list(): Promise<SandboxRecord[]> {
    await this.ready;
    const all = await this.client.hGetAll(recordsKey());
    return Object.values(all).map((v) => JSON.parse(v) as SandboxRecord);
  }
  async close(): Promise<void> {
    await this.ready;
    await this.client.close();
  }
}
