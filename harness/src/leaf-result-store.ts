import { createClient, type RedisClientType } from "redis";
import type { Verdict } from "./verdict.js";
import type { LeafResult, LeafUsage } from "./run-leaf.js";

export interface LeafResultRecord {
  status: "done" | "failed" | "aborted" | "paused" | "solved";
  verdict: Verdict | null;
  gate: { gateId: number; summary: string; proposed_action: string } | null;
  reason: string | null;
  patch: string | null;   // solve-leaf candidate patch (unified diff); null for non-solve results
  usage: LeafUsage | null; // solve-leaf cumulative token usage (for run cost pricing); null otherwise
  sessionId: string; // RAW (un-sanitized) id, for caller correlation
  ts: string;
}

/** Minimal structural Redis surface — lets unit tests inject an in-memory fake. */
export interface RedisLike {
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function resultKey(leafSessionId: string): string {
  return `leaf:result:${leafSessionId}`;
}

/** Map a terminal LeafResult to the persisted record. `rawSessionId` is the un-sanitized envelope id. */
export function toResultRecord(result: LeafResult, rawSessionId: string, ts: string): LeafResultRecord {
  const base: LeafResultRecord = { status: "failed", verdict: null, gate: null, reason: null, patch: null, usage: null, sessionId: rawSessionId, ts };
  if (result.status === "done") return { ...base, status: "done", verdict: result.verdict };
  if (result.status === "solved") return { ...base, status: "solved", patch: result.patch, usage: result.usage ?? null };
  if (result.status === "paused") {
    return { ...base, status: "paused", gate: { gateId: result.gateId, summary: result.gate.summary, proposed_action: result.gate.proposed_action } };
  }
  if (result.status === "aborted") return { ...base, status: "aborted" };
  return { ...base, status: "failed", reason: result.reason };
}

export async function writeResult(redis: RedisLike, leafSessionId: string, record: LeafResultRecord, ttlSeconds: number): Promise<void> {
  await redis.set(resultKey(leafSessionId), JSON.stringify(record), { EX: ttlSeconds });
}

export async function readResult(redis: RedisLike, leafSessionId: string): Promise<LeafResultRecord | null> {
  const raw = await redis.get(resultKey(leafSessionId));
  if (!raw) return null;
  try { return JSON.parse(raw) as LeafResultRecord; } catch { return null; }
}

/** Real client used by the server and async worker. Reuses REDIS_URL, connects lazily. */
export class RedisResultStore implements RedisLike {
  private client: RedisClientType;
  private ready: Promise<void>;
  constructor(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379") {
    this.client = createClient({ url }) as RedisClientType;
    this.ready = this.client.connect().then(() => undefined);
  }
  async set(key: string, value: string, opts?: { EX?: number }): Promise<unknown> {
    await this.ready;
    return opts?.EX ? this.client.set(key, value, { EX: opts.EX }) : this.client.set(key, value);
  }
  async get(key: string): Promise<string | null> {
    await this.ready;
    return this.client.get(key);
  }
  async close(): Promise<void> {
    await this.ready;
    await this.client.close();
  }
}
