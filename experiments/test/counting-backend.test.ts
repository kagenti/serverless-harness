import { describe, it, expect } from "vitest";
import type { SessionStorageBackend } from "@earendil-works/pi-coding-agent";
import { CountingBackend } from "../src/counting-backend";

// A trivial in-memory backend returning a fixed list, to exercise the decorator.
function fakeBackend(entries: unknown[]): SessionStorageBackend {
  return {
    append: async () => {},
    read: async (_sid: string, fromPosition = 1) =>
      entries.slice(fromPosition - 1) as never,
    latestCheckpoint: async () => null,
    list: async () => [],
  };
}

describe("CountingBackend", () => {
  it("tallies entries and bytes per read, and reset() zeroes", async () => {
    const entries = [{ a: 1 }, { b: 22 }, { c: 333 }];
    const cb = new CountingBackend(fakeBackend(entries));

    const full = await cb.read("s");
    expect(full.length).toBe(3);
    const c1 = cb.counts();
    expect(c1.reads).toBe(1);
    expect(c1.entriesRead).toBe(3);
    expect(c1.bytesRead).toBe(
      entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0),
    );

    await cb.read("s", 3); // tail of 1 entry
    expect(cb.counts().reads).toBe(2);
    expect(cb.counts().entriesRead).toBe(4);

    cb.reset();
    expect(cb.counts()).toEqual({ reads: 0, entriesRead: 0, bytesRead: 0, checkpointLookups: 0 });
  });

  it("counts latestCheckpoint lookups separately and delegates", async () => {
    const cb = new CountingBackend(fakeBackend([]));
    expect(await cb.latestCheckpoint("s")).toBeNull();
    expect(cb.counts().checkpointLookups).toBe(1);
    expect(cb.counts().entriesRead).toBe(0);
  });
});
