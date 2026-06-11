// packages/session-backend/test/redis-backend.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { RedisSessionBackend } from "../src/redis-backend";

const SID = "test-" + process.pid;

describe("RedisSessionBackend", () => {
  let b: RedisSessionBackend;
  beforeEach(async () => { b = new RedisSessionBackend("redis://127.0.0.1:6379"); await b.reset(SID); });

  it("appends and reads back in order with monotonic positions", async () => {
    await b.append({ position: await b.nextPosition(SID), session_id: SID, type: "user_message", data: { text: "a" } });
    await b.append({ position: await b.nextPosition(SID), session_id: SID, type: "inference_response", data: { text: "b" } });
    const entries = await b.read(SID);
    expect(entries.map(e => e.position)).toEqual([1, 2]);
    expect(entries[1].type).toBe("inference_response");
  });

  it("read(fromPosition) returns only the tail", async () => {
    for (const t of ["user_message", "checkpoint", "user_message"] as const)
      await b.append({ position: await b.nextPosition(SID), session_id: SID, type: t, data: {} });
    const tail = await b.read(SID, 2);
    expect(tail.map(e => e.position)).toEqual([2, 3]);
  });

  it("latestCheckpoint returns the newest checkpoint entry", async () => {
    await b.append({ position: await b.nextPosition(SID), session_id: SID, type: "checkpoint", data: { ctx: "v1" } });
    await b.append({ position: await b.nextPosition(SID), session_id: SID, type: "user_message", data: {} });
    await b.append({ position: await b.nextPosition(SID), session_id: SID, type: "checkpoint", data: { ctx: "v2" } });
    const cp = await b.latestCheckpoint(SID);
    expect((cp!.data as any).ctx).toBe("v2");
  });
});
