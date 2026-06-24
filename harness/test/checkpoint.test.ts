import { describe, it, expect, afterAll } from "vitest";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "../src/buffered-redis-backend";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const store = new RedisSessionBackend<FileEntry>(REDIS);
const sids: string[] = [];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  await store.close();
});

describe("SessionManager.openFromCheckpoint", () => {
  it("loads only the tail slice from a checkpoint marker", async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);

    sm.appendMessage({ role: "user", content: "one" } as never);    // ~pos 2
    const keepId = sm.appendMessage({ role: "assistant", content: "two" } as never); // ~pos 3
    sm.appendMessage({ role: "user", content: "three" } as never);  // ~pos 4
    await backend.flush();

    const resumeFrom = await store.positionOfId(sid, keepId);
    expect(resumeFrom).not.toBeNull();
    sm.appendCustomEntry("checkpoint", { resumeFromPosition: resumeFrom }); // marker
    await backend.flush();

    const resumed = await SessionManager.openFromCheckpoint(sid, backend, process.cwd());
    const tail = await store.read(sid, resumeFrom!);
    // Reconstructed entry ids equal exactly the stored tail slice (firstKept..marker).
    expect(resumed.getEntries().map((e) => (e as { id?: string }).id)).toEqual(
      tail.map((r) => (r.entry as { id?: string }).id),
    );
    // The slice is strictly smaller than the full log.
    const full = await store.read(sid);
    expect(tail.length).toBeLessThan(full.length);
  });

  it("falls back to full reconstruction when there is no marker", async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);
    sm.appendMessage({ role: "user", content: "hi" } as never);
    sm.appendMessage({ role: "assistant", content: "hello" } as never);
    await backend.flush();

    const viaCheckpoint = await SessionManager.openFromCheckpoint(sid, backend, process.cwd());
    const viaBackend = await SessionManager.openFromBackend(sid, backend, process.cwd());
    expect(viaCheckpoint.getEntries().map((e) => JSON.stringify(e))).toEqual(
      viaBackend.getEntries().map((e) => JSON.stringify(e)),
    );
  });
});
