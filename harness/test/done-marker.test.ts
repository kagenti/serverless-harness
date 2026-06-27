import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveDoneMarkerPath, writeDoneMarker, readDoneMarker } from "../src/done-marker";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "marker-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("deriveDoneMarkerPath", () => {
  it("derives <resultRef>.status by default", () => {
    expect(deriveDoneMarkerPath("/work/r/out.json")).toBe("/work/r/out.json.status");
  });
  it("honors an explicit override", () => {
    expect(deriveDoneMarkerPath("/work/r/out.json", "/work/r/done")).toBe("/work/r/done");
  });
});

describe("writeDoneMarker / readDoneMarker", () => {
  it("round-trips a done marker and leaves no temp file", () => {
    const p = join(dir, "out.json.status");
    writeDoneMarker(p, { status: "done", sessionId: "s1", reason: null, ts: "2026-06-27T00:00:00Z" });
    expect(readDoneMarker(p)).toEqual({ status: "done", sessionId: "s1", reason: null, ts: "2026-06-27T00:00:00Z" });
    expect(readdirSync(dir)).toEqual(["out.json.status"]); // no .tmp left behind
  });
  it("round-trips a failed marker with a reason", () => {
    const p = join(dir, "m.status");
    writeDoneMarker(p, { status: "failed", sessionId: "s2", reason: "bad_inputs", ts: "t" });
    expect(readDoneMarker(p)?.reason).toBe("bad_inputs");
  });
  it("returns null for a missing marker", () => {
    expect(readDoneMarker(join(dir, "nope.status"))).toBeNull();
  });
});
