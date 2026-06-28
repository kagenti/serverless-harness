import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyFire, dispatchAll, loadConfig, exitCodeFor } from "../src/cron-dispatch";

describe("applyFire", () => {
  it("substitutes every __FIRE__ occurrence in string fields and passes others through", () => {
    const out = applyFire(
      { sessionId: "nightly/__FIRE__/i1", resultRef: "/work/nightly/__FIRE__/results/i1.json", inputsRef: "/work/nightly/inputs/i1.json", model: "claude-haiku-4-5" },
      "fire-42",
    );
    expect(out).toEqual({
      sessionId: "nightly/fire-42/i1",
      resultRef: "/work/nightly/fire-42/results/i1.json",
      inputsRef: "/work/nightly/inputs/i1.json",
      model: "claude-haiku-4-5",
    });
  });
  it("does not mutate the input object", () => {
    const input = { sessionId: "s/__FIRE__" };
    applyFire(input, "f1");
    expect(input.sessionId).toBe("s/__FIRE__");
  });
});

describe("dispatchAll", () => {
  const ITEMS = [
    { sessionId: "n/__FIRE__/i1", resultRef: "/work/n/__FIRE__/i1.json" },
    { sessionId: "n/__FIRE__/i2", resultRef: "/work/n/__FIRE__/i2.json" },
  ];

  it("posts every item once with async:true and __FIRE__ substituted; all accepted", async () => {
    const seen: Record<string, unknown>[] = [];
    const post = vi.fn(async (env: Record<string, unknown>) => { seen.push(env); return true; });
    const r = await dispatchAll(ITEMS, "fire-1", post);
    expect(r).toEqual({ total: 2, accepted: 2, failed: 0 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatchObject({ sessionId: "n/fire-1/i1", resultRef: "/work/n/fire-1/i1.json", async: true });
    expect(seen[1]).toMatchObject({ sessionId: "n/fire-1/i2", async: true });
  });

  it("counts a rejected post as failed but still attempts the rest", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const r = await dispatchAll(ITEMS, "fire-1", post as any);
    expect(r).toEqual({ total: 2, accepted: 1, failed: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("counts a thrown post as failed and continues", async () => {
    const post = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(true);
    const r = await dispatchAll(ITEMS, "fire-1", post as any);
    expect(r).toEqual({ total: 2, accepted: 1, failed: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("posts nothing for an empty list", async () => {
    const post = vi.fn(async () => true);
    const r = await dispatchAll([], "fire-1", post);
    expect(r).toEqual({ total: 0, accepted: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("exitCodeFor", () => {
  it("returns 0 when nothing failed", () => { expect(exitCodeFor({ failed: 0 })).toBe(0); });
  it("returns 1 when any item failed", () => { expect(exitCodeFor({ failed: 1 })).toBe(1); });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cron-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it("reads the items array", () => {
    const p = join(dir, "schedule.json");
    writeFileSync(p, JSON.stringify({ items: [{ sessionId: "a" }, { sessionId: "b" }] }));
    expect(loadConfig(p)).toEqual([{ sessionId: "a" }, { sessionId: "b" }]);
  });
  it("throws when items is missing or not an array", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ nope: true }));
    expect(() => loadConfig(p)).toThrow();
  });
  it("throws when the file is missing", () => {
    expect(() => loadConfig(join(dir, "absent.json"))).toThrow();
  });
});
