import { describe, it, expect } from "vitest";
import { verdictTerminationExtension } from "../src/verdict-termination-extension";
import type { VerdictCapture } from "../src/submit-verdict-tool";

function fakePi() {
  const handlers: Record<string, Function> = {};
  const pi = { on: (ev: string, h: Function) => { handlers[ev] = h; } };
  return { pi: pi as any, handlers };
}

describe("verdictTerminationExtension", () => {
  it("does not block tool calls before a verdict is captured and under the turn cap", () => {
    const capture: VerdictCapture = {};
    const { pi, handlers } = fakePi();
    verdictTerminationExtension(capture, { maxTurns: 5 })(pi);
    const result = handlers["tool_call"]({});
    expect(result).toEqual({});
  });

  it("blocks tool calls once a verdict has already been captured", () => {
    const capture: VerdictCapture = { verdict: { item_id: "i1", verdict: "CLEAR", reason: "r" } };
    const { pi, handlers } = fakePi();
    verdictTerminationExtension(capture, { maxTurns: 5 })(pi);
    const result = handlers["tool_call"]({});
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/verdict already submitted/i);
  });

  it("blocks tool calls once maxTurns is exceeded without a verdict", () => {
    const capture: VerdictCapture = {};
    const { pi, handlers } = fakePi();
    verdictTerminationExtension(capture, { maxTurns: 2 })(pi);
    // turn_start fires once per turn; simulate 3 turns (exceeds cap of 2)
    handlers["turn_start"]();
    handlers["turn_start"]();
    handlers["turn_start"]();
    const result = handlers["tool_call"]({});
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/turn limit/i);
  });

  it("does not block at exactly the turn cap (only after exceeding it)", () => {
    const capture: VerdictCapture = {};
    const { pi, handlers } = fakePi();
    verdictTerminationExtension(capture, { maxTurns: 2 })(pi);
    handlers["turn_start"]();
    handlers["turn_start"]();
    const result = handlers["tool_call"]({});
    expect(result).toEqual({});
  });

  it("applies a default turn cap when maxTurns is omitted (never leaves the loop unbounded)", () => {
    const capture: VerdictCapture = {};
    const { pi, handlers } = fakePi();
    verdictTerminationExtension(capture)(pi);
    for (let i = 0; i < 41; i++) handlers["turn_start"]();
    const result = handlers["tool_call"]({});
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/turn limit/i);
  });
});
