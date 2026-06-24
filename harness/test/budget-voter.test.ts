import { describe, it, expect } from "vitest";
import {
  decideBudget,
  sessionSpendTotal,
  budgetVoterExtension,
} from "../src/budget-voter";

// --- minimal fakes (no Pi runtime) -------------------------------------------
function fakeCtx(assistantUsages: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }>) {
  return {
    sessionManager: {
      getBranch: () =>
        assistantUsages.map((usage) => ({
          type: "message",
          message: { role: "assistant", usage },
        })),
    },
  } as unknown as Parameters<typeof sessionSpendTotal>[0];
}
function emptyCtx() {
  return { sessionManager: { getBranch: () => [] } } as unknown as Parameters<typeof sessionSpendTotal>[0];
}
function brokenCtx() {
  return {} as unknown as Parameters<typeof sessionSpendTotal>[0];
}
// Captures handlers + appendCustomEntry calls.
function harness() {
  const handlers: Record<string, Function> = {};
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = { on: (ev: string, h: Function) => { handlers[ev] = h; } };
  const sm = { appendCustomEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); return "id"; } };
  return { handlers, appended, pi, sm };
}

describe("decideBudget", () => {
  it("commits below the cap", () => {
    expect(decideBudget({ spent: 10, estimated: 0, limit: 100 })).toEqual({ decision: "commit" });
  });
  it("aborts when spent + estimated exceeds the cap", () => {
    expect(decideBudget({ spent: 90, estimated: 20, limit: 100 })).toEqual({
      decision: "abort",
      reason: "budget_exceeded",
    });
  });
  it("commits exactly at the cap (not strictly greater)", () => {
    expect(decideBudget({ spent: 100, estimated: 0, limit: 100 })).toEqual({ decision: "commit" });
  });
  it("is disabled (always commits) when limit <= 0 or non-finite", () => {
    expect(decideBudget({ spent: 999, estimated: 0, limit: 0 })).toEqual({ decision: "commit" });
    expect(decideBudget({ spent: 999, estimated: 0, limit: NaN })).toEqual({ decision: "commit" });
  });
});

describe("sessionSpendTotal", () => {
  it("sums all assistant usage fields", () => {
    const ctx = fakeCtx([
      { input: 10, output: 5, cacheRead: 1, cacheWrite: 0 },
      { input: 20, output: 4, cacheRead: 0, cacheWrite: 1 },
    ]);
    expect(sessionSpendTotal(ctx)).toBe(41);
  });
  it("returns 0 for an empty branch (valid baseline, not null)", () => {
    expect(sessionSpendTotal(emptyCtx())).toBe(0);
  });
  it("returns null when the branch is unavailable", () => {
    expect(sessionSpendTotal(brokenCtx())).toBeNull();
  });
});

describe("budgetVoterExtension", () => {
  it("blocks a tool call and appends exactly one abort entry once over cap", () => {
    const { handlers, appended, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 50 })(pi as never);
    // baseline at session_start = 0 (no assistant messages yet)
    handlers.session_start({}, emptyCtx());
    // tool_call after 60 tokens of spend -> over the cap of 50
    const ctx = fakeCtx([{ input: 40, output: 20, cacheRead: 0, cacheWrite: 0 }]);
    const res = handlers.tool_call({}, ctx);
    expect(res).toEqual({ block: true, reason: "Session token budget exceeded" });
    expect(appended).toEqual([
      { customType: "abort", data: { reason: "budget_exceeded", spent: 60, limit: 50 } },
    ]);
  });
  it("does not block below the cap and writes no abort entry", () => {
    const { handlers, appended, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 1000 })(pi as never);
    handlers.session_start({}, emptyCtx());
    const ctx = fakeCtx([{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }]);
    expect(handlers.tool_call({}, ctx)).toEqual({});
    expect(appended).toEqual([]);
  });
  it("does not block when the stat reading is unavailable (defensive)", () => {
    const { handlers, pi, sm } = harness();
    budgetVoterExtension(sm as never, { limit: 1 })(pi as never);
    handlers.session_start({}, emptyCtx()); // baseline = 0
    expect(handlers.tool_call({}, brokenCtx())).toEqual({}); // total == null -> no block
  });
});
