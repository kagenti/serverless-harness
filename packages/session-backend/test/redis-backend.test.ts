import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { RedisSessionBackend } from "../src/redis-backend";

const SID = "test-" + process.pid;
const b = new RedisSessionBackend<{ type: string; customType?: string; n?: number; id?: string }>(
  "redis://127.0.0.1:6379",
);

beforeEach(async () => { await b.reset(SID); });
afterAll(async () => { await b.reset(SID); await b.close(); });

describe("RedisSessionBackend (LogStore)", () => {
  it("appends opaque entries and reads them back in order with monotonic positions", async () => {
    await b.append(SID, { type: "message", n: 1 }, "message");
    await b.append(SID, { type: "message", n: 2 }, "message");
    const rows = await b.read(SID);
    expect(rows.map(r => r.position)).toEqual([1, 2]);
    expect(rows.map(r => r.entry.n)).toEqual([1, 2]);
    expect(rows[0].piType).toBe("message");
  });

  it("read(fromPosition) returns only the tail", async () => {
    await b.append(SID, { type: "message" }, "message");
    await b.append(SID, { type: "custom", customType: "checkpoint" }, "custom");
    await b.append(SID, { type: "message" }, "message");
    const tail = await b.read(SID, 2);
    expect(tail.map(r => r.position)).toEqual([2, 3]);
  });

  it("latestWhere returns the newest matching entry", async () => {
    await b.append(SID, { type: "custom", customType: "checkpoint" }, "custom"); // pos 1
    await b.append(SID, { type: "message" }, "message");                          // pos 2
    await b.append(SID, { type: "custom", customType: "checkpoint" }, "custom"); // pos 3
    const cp = await b.latestWhere(SID, e => e.type === "custom" && e.customType === "checkpoint");
    expect(cp?.position).toBe(3);
  });

  it("returns the entry verbatim (round-trip identity)", async () => {
    const entry = { type: "custom", customType: "checkpoint", n: 42 };
    await b.append(SID, entry, "custom");
    const [row] = await b.read(SID);
    expect(row.entry).toEqual(entry);
  });

  it("read(fromPosition) uses a stream-id seek and returns exactly the tail", async () => {
    await b.append(SID, { type: "message", n: 1 }, "message"); // pos 1
    await b.append(SID, { type: "message", n: 2 }, "message"); // pos 2
    await b.append(SID, { type: "message", n: 3 }, "message"); // pos 3
    const tail = await b.read(SID, 2);
    expect(tail.map((r) => r.position)).toEqual([2, 3]);
    expect(tail.map((r) => r.entry.n)).toEqual([2, 3]);
  });

  it("read(fromPosition) past the end returns empty", async () => {
    await b.append(SID, { type: "message", n: 1 }, "message"); // pos 1
    const tail = await b.read(SID, 99);
    expect(tail).toEqual([]);
  });

  it("positionOfId returns the position of the entry with the matching id, or null", async () => {
    await b.append(SID, { type: "message", id: "a" }, "message"); // pos 1
    await b.append(SID, { type: "message", id: "b" }, "message"); // pos 2
    await b.append(SID, { type: "compaction", id: "c" }, "compaction"); // pos 3
    expect(await b.positionOfId(SID, "b")).toBe(2);
    expect(await b.positionOfId(SID, "c")).toBe(3);
    expect(await b.positionOfId(SID, "missing")).toBeNull();
  });
});
