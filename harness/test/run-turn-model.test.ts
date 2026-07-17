import { describe, it, expect } from "vitest";
import { resolveModelSelection, requireModel } from "../src/run-turn";

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

describe("requireModel", () => {
  it("returns the model for a known anthropic id", () => {
    const m = requireModel("anthropic", "claude-opus-4-8");
    expect((m as { id: string }).id).toBe("claude-opus-4-8");
  });

  it("throws a clear error for a known provider but unknown model id (dot-vs-dash trap)", () => {
    // 'claude-sonnet-4.6' (dot) is a github-copilot key, not anthropic; the anthropic id is the dash form.
    expect(() => requireModel("anthropic", "claude-sonnet-4.6")).toThrowError(
      /Unknown model "anthropic\/claude-sonnet-4\.6".*claude-sonnet-4-6/s,
    );
  });

  it("throws naming valid providers when the provider is unknown", () => {
    expect(() => requireModel("litellm", "whatever")).toThrowError(
      /Unknown model provider "litellm".*anthropic/s,
    );
  });
});

describe("requireModel with SH_MODEL_CUSTOM (self-hosted endpoint)", () => {
  it("requires ANTHROPIC_BASE_URL when SH_MODEL_CUSTOM=1", () => {
    expect(() =>
      requireModel("anthropic", "meta-llama/Llama-3.3-70B-Instruct", { SH_MODEL_CUSTOM: "1" }),
    ).toThrowError(/SH_MODEL_CUSTOM=1 requires ANTHROPIC_BASE_URL/);
  });

  it("synthesizes an anthropic-messages model from SH_MODEL + ANTHROPIC_BASE_URL", () => {
    const m = requireModel("anthropic", "meta-llama/Llama-3.3-70B-Instruct", {
      SH_MODEL_CUSTOM: "1",
      ANTHROPIC_BASE_URL: "http://vllm.my-ns.svc:8000",
    }) as {
      id: string;
      name: string;
      api: string;
      provider: string;
      baseUrl: string;
      contextWindow: number;
      maxTokens: number;
    };
    expect(m.id).toBe("meta-llama/Llama-3.3-70B-Instruct");
    expect(m.name).toBe("meta-llama/Llama-3.3-70B-Instruct");
    expect(m.api).toBe("anthropic-messages");
    expect(m.baseUrl).toBe("http://vllm.my-ns.svc:8000");
    // provider defaults to "anthropic" so pi's key lookup resolves ANTHROPIC_API_KEY.
    expect(m.provider).toBe("anthropic");
    // Conservative defaults when overrides are unset.
    expect(m.contextWindow).toBe(131072);
    expect(m.maxTokens).toBe(8192);
  });

  it("honors SH_MODEL_PROVIDER / SH_MODEL_CONTEXT_WINDOW / SH_MODEL_MAX_TOKENS overrides", () => {
    const m = requireModel("anthropic", "some/model", {
      SH_MODEL_CUSTOM: "1",
      ANTHROPIC_BASE_URL: "http://endpoint:8000",
      SH_MODEL_PROVIDER: "vllm",
      SH_MODEL_CONTEXT_WINDOW: "65536",
      SH_MODEL_MAX_TOKENS: "4096",
    }) as { provider: string; contextWindow: number; maxTokens: number };
    expect(m.provider).toBe("vllm");
    expect(m.contextWindow).toBe(65536);
    expect(m.maxTokens).toBe(4096);
  });
});
