import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "@sh/harness/buffered-redis-backend";
import { CountingBackend } from "../src/counting-backend";
import { buildCompactedSession } from "../src/session-fixture";
import { buildResultsMarkdown, type E2Row } from "../src/report";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const store = new RedisSessionBackend<FileEntry>(REDIS);
const sids: string[] = [];
const Ns = [50, 200, 1000, 5000];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  await store.close();
});

async function measure(sessionId: string): Promise<{
  backend: { entries: number; bytes: number; ms: number };
  checkpoint: { entries: number; bytes: number; ms: number };
}> {
  const cb = new CountingBackend(new BufferedRedisBackend(store));

  cb.reset();
  let t0 = performance.now();
  const viaBackend = await SessionManager.openFromBackend(sessionId, cb, process.cwd());
  const backendMs = performance.now() - t0;
  const b = cb.counts();

  cb.reset();
  t0 = performance.now();
  const viaCheckpoint = await SessionManager.openFromCheckpoint(sessionId, cb, process.cwd());
  const checkpointMs = performance.now() - t0;
  const c = cb.counts();

  // Parity re-confirmation (spec §5).
  expect(viaCheckpoint.buildSessionContext()).toEqual(viaBackend.buildSessionContext());

  return {
    backend: { entries: b.entriesRead, bytes: b.bytesRead, ms: backendMs },
    checkpoint: { entries: c.entriesRead, bytes: c.bytesRead, ms: checkpointMs },
  };
}

describe("E2 — reconstruction cost", () => {
  it("checkpoint read stays ~constant while backend grows; ratio increases with N", async () => {
    const rows: E2Row[] = [];
    for (const n of Ns) {
      const fx = await buildCompactedSession(store, { n, tailKept: 4 });
      sids.push(fx.sessionId);
      const m = await measure(fx.sessionId);
      rows.push({
        n,
        backendEntries: m.backend.entries,
        checkpointEntries: m.checkpoint.entries,
        backendBytes: m.backend.bytes,
        checkpointBytes: m.checkpoint.bytes,
        ratioEntries: m.backend.entries / m.checkpoint.entries,
        backendMs: m.backend.ms,
        checkpointMs: m.checkpoint.ms,
      });
    }

    // Checkpoint entries are bounded by the kept tail, independent of N.
    const cpEntries = rows.map((r) => r.checkpointEntries);
    expect(Math.max(...cpEntries)).toBeLessThanOrEqual(10);

    // Backend entries grow with N.
    expect(rows[rows.length - 1].backendEntries).toBeGreaterThan(rows[0].backendEntries * 5);

    // Ratio strictly increases across the N series.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].ratioEntries).toBeGreaterThan(rows[i - 1].ratioEntries);
    }
    // And the largest N dwarfs the smallest.
    expect(rows[rows.length - 1].ratioEntries).toBeGreaterThan(rows[0].ratioEntries * 5);

    // Record results next to this file.
    const resultsPath = fileURLToPath(new URL("../RESULTS.md", import.meta.url));
    writeFileSync(resultsPath, buildResultsMarkdown(rows));
    // Echo to stdout (redirected to $LOG_DIR by the runner) for the record.
    console.log(JSON.stringify(rows, null, 2));
  }, 120_000);
});
