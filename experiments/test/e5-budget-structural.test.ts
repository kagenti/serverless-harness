import { describe, it, expect, afterAll } from "vitest";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "@sh/harness/buffered-redis-backend";
import { budgetVoterExtension } from "@sh/harness/budget-voter";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const store = new RedisSessionBackend<FileEntry>(REDIS);
const sids: string[] = [];

afterAll(async () => {
  for (const sid of sids) await store.reset(sid);
  await store.close();
});

// A synthetic ExtensionContext whose branch reports a given assistant token spend.
function spendCtx(total: number) {
  return {
    sessionManager: {
      getBranch: () =>
        total === 0
          ? []
          : [{ type: "message", message: { role: "assistant", usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0 } } }],
    },
  } as never;
}

function register(sm: SessionManager, limit: number) {
  const handlers: Record<string, (e: unknown, ctx: unknown) => unknown> = {};
  const pi = { on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => { handlers[ev] = h; } };
  budgetVoterExtension(sm, { limit })(pi as never);
  return handlers;
}

async function abortCount(sessionId: string): Promise<number> {
  const entries = await store.read(sessionId);
  return entries.filter(
    (r) => (r.entry as { type?: string; customType?: string }).type === "custom" &&
           (r.entry as { customType?: string }).customType === "abort",
  ).length;
}

describe("E5 — budget voter enforcement (structural, real Redis)", () => {
  it("blocks the tool call and persists exactly one abort entry once over cap", async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);

    const handlers = register(sm, 50);
    handlers.session_start({}, spendCtx(0)); // baseline = 0
    const res = handlers.tool_call({}, spendCtx(60)); // 60 > 50

    expect(res).toEqual({ block: true, reason: "Session token budget exceeded" });
    await backend.flush();
    expect(await abortCount(sid)).toBe(1);
  });

  it("is inert when the cap is disabled (limit <= 0): no block, no abort", async () => {
    const backend = new BufferedRedisBackend(store);
    const sm = SessionManager.create(process.cwd(), undefined, undefined, backend);
    const sid = sm.getSessionId();
    sids.push(sid);

    const handlers = register(sm, 0); // disabled cap
    handlers.session_start({}, spendCtx(0));
    const res = handlers.tool_call({}, spendCtx(10_000)); // way over, but cap disabled

    expect(res).toEqual({});
    await backend.flush();
    expect(await abortCount(sid)).toBe(0);
  });
});
