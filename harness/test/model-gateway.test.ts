import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyModelGateway } from "../src/run-turn";

const baseModel = { id: "claude-haiku-4-5", headers: { "x-api-key": "orig" } } as never;

describe("applyModelGateway", () => {
  let savedKey: string | undefined;
  let savedBase: string | undefined;
  let savedTok: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    savedBase = process.env.ANTHROPIC_BASE_URL;
    savedTok = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = savedBase;
    if (savedTok === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = savedTok;
  });

  it("returns the base model unchanged when no gateway base or token is set", () => {
    const m = applyModelGateway(baseModel, {}) as any;
    expect(m).toBe(baseModel);
  });

  it("applies the gateway baseUrl and Bearer auth, stripping x-api-key", () => {
    const m = applyModelGateway(baseModel, {
      anthropicBaseUrl: "https://gw.example/v1",
      anthropicAuthToken: "tok-123",
    }) as any;
    expect(m.baseUrl).toBe("https://gw.example/v1");
    expect(m.headers.Authorization).toBe("Bearer tok-123");
    expect(m.headers["x-api-key"]).toBeNull();
  });

  it("reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from env when config omits them", () => {
    process.env.ANTHROPIC_BASE_URL = "https://env-gw/v1";
    process.env.ANTHROPIC_AUTH_TOKEN = "env-tok";
    const m = applyModelGateway(baseModel, {}) as any;
    expect(m.baseUrl).toBe("https://env-gw/v1");
    expect(m.headers.Authorization).toBe("Bearer env-tok");
  });

  it("seeds ANTHROPIC_API_KEY from the auth token when the key is unset", () => {
    applyModelGateway(baseModel, { anthropicAuthToken: "tok-xyz" });
    expect(process.env.ANTHROPIC_API_KEY).toBe("tok-xyz");
  });

  it("disables gateway-incompatible compat flags when a gateway base is set", () => {
    // litellm rejects per-tool eager_input_streaming / cache_control; the gateway model must
    // disable these so convertTools() omits them (otherwise tool-bearing requests 400).
    const m = applyModelGateway(baseModel, { anthropicBaseUrl: "https://gw.example/v1" }) as any;
    expect(m.compat.supportsEagerToolInputStreaming).toBe(false);
    expect(m.compat.supportsCacheControlOnTools).toBe(false);
    expect(m.compat.supportsLongCacheRetention).toBe(false);
  });

  it("does not add compat when no gateway base is set (direct API)", () => {
    const m = applyModelGateway(baseModel, { anthropicAuthToken: "tok-only" }) as any;
    expect(m.compat).toBeUndefined();
  });
});
