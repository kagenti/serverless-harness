import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "@sh/harness/buffered-redis-backend";

export interface CompactedFixture {
  sessionId: string;
  resumeFromPosition: number;
  fullLength: number;
  tailLength: number;
}

/**
 * Build a length-n session in Redis that compacted once, keeping the last `tailKept`
 * messages, with a checkpoint marker pointing at the kept-tail position. The kept tail
 * is fixed independent of n, so openFromCheckpoint reads ~constant while openFromBackend
 * grows with n. No thinking_level_change is appended, so buildSessionContext() parity
 * holds (the M5 thinkingLevel caveat only triggers on a pre-tail thinking_level_change).
 */
export async function buildCompactedSession(
  store: RedisSessionBackend<FileEntry>,
  opts: { n: number; tailKept?: number },
): Promise<CompactedFixture> {
  const tailKept = opts.tailKept ?? 4;
  const backend = new BufferedRedisBackend(store);
  const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
  const sessionId = sm.getSessionId();

  const ids: string[] = [];
  for (let i = 0; i < opts.n; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const id = sm.appendMessage({ role, content: `m${i}` } as never);
    ids.push(id);
  }

  // Keep the last `tailKept` messages: firstKept = the message at index n - tailKept.
  const firstKeptId = ids[Math.max(0, opts.n - tailKept)];
  sm.appendCompaction("summary of earlier turns", firstKeptId, 1234);
  await backend.flush();

  const resumeFromPosition = await store.positionOfId(sessionId, firstKeptId);
  if (resumeFromPosition == null) {
    throw new Error(`fixture: positionOfId returned null for firstKeptId ${firstKeptId}`);
  }
  sm.appendCustomEntry("checkpoint", { resumeFromPosition });
  await backend.flush();

  const full = await store.read(sessionId);
  const tail = await store.read(sessionId, resumeFromPosition);
  return {
    sessionId,
    resumeFromPosition,
    fullLength: full.length,
    tailLength: tail.length,
  };
}
