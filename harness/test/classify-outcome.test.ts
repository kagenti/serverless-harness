import { describe, it, expect } from "vitest";
import { classifyOutcome } from "../src/classify-outcome";

describe("classifyOutcome", () => {
  it("done → ack + done marker", () => {
    expect(classifyOutcome({ status: "done", resultRef: "/out" })).toEqual({
      ack: true, marker: { status: "done", reason: null }, retryable: false,
    });
  });
  for (const reason of ["bad_inputs", "no_verdict", "invalid_verdict"] as const) {
    it(`failed:${reason} → ack + failed marker (deterministic)`, () => {
      expect(classifyOutcome({ status: "failed", reason })).toEqual({
        ack: true, marker: { status: "failed", reason }, retryable: false,
      });
    });
  }
  it("failed:error → no ack, retryable, no marker (yet)", () => {
    expect(classifyOutcome({ status: "failed", reason: "error", message: "boom" })).toEqual({
      ack: false, marker: null, retryable: true,
    });
  });
  it("paused → ack, no terminal marker (runLeaf wrote the gate marker)", () => {
    expect(classifyOutcome({ status: "paused", gateRef: "/out.gate", gateId: 0 })).toEqual({
      ack: true, marker: null, retryable: false,
    });
  });
  it("aborted → ack + aborted terminal marker", () => {
    expect(classifyOutcome({ status: "aborted" })).toEqual({
      ack: true, marker: { status: "aborted", reason: null }, retryable: false,
    });
  });
});
