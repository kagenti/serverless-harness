import { describe, it, expect } from "vitest";
import { resolveModelSelection } from "../src/run-turn";

describe("resolveModelSelection", () => {
  it("defaults to anthropic / claude-opus-4-8 when nothing is set", () => {
    expect(resolveModelSelection(undefined, {})).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    });
  });

  it("reads env when config is absent", () => {
    expect(
      resolveModelSelection(undefined, { SH_MODEL_PROVIDER: "openai", SH_MODEL: "gpt-x" }),
    ).toEqual({ provider: "openai", modelId: "gpt-x" });
  });

  it("config overrides env and defaults", () => {
    expect(
      resolveModelSelection(
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { SH_MODEL_PROVIDER: "openai", SH_MODEL: "gpt-x" },
      ),
    ).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
  });

  it("mixes config and env per-field", () => {
    expect(resolveModelSelection({ model: "m1" }, { SH_MODEL_PROVIDER: "p1" })).toEqual({
      provider: "p1",
      modelId: "m1",
    });
  });
});
