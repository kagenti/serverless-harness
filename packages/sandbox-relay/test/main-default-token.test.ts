import { describe, expect, it } from "vitest";
import { makeDefaultValidateToken } from "../src/main.js";

describe("makeDefaultValidateToken (fail-closed default auth)", () => {
  it("rejects any token, including undefined, when no token env var is configured", () => {
    const validate = makeDefaultValidateToken({});
    expect(validate(undefined, "sbx-1")).toBe(false);
    expect(validate("", "sbx-1")).toBe(false);
    expect(validate("anything", "sbx-1")).toBe(false);
  });

  it("SH_RELAY_TOKEN set: only an exact match is accepted", () => {
    const validate = makeDefaultValidateToken({ SH_RELAY_TOKEN: "secret" });
    expect(validate("secret", "sbx-1")).toBe(true);
    expect(validate("wrong", "sbx-1")).toBe(false);
    expect(validate(undefined, "sbx-1")).toBe(false);
    expect(validate("", "sbx-1")).toBe(false);
  });

  it("SH_RELAY_TOKEN_<id> per-sandbox override takes precedence for that sandbox", () => {
    const validate = makeDefaultValidateToken({ SH_RELAY_TOKEN: "global", SH_RELAY_TOKEN_sbx1: "onlysbx1" });
    expect(validate("onlysbx1", "sbx1")).toBe(true);
    // The global token must not authenticate a sandbox that has its own override.
    expect(validate("global", "sbx1")).toBe(false);
    // A different sandbox with no override falls back to the global token.
    expect(validate("global", "sbx2")).toBe(true);
  });

  it("per-sandbox override with no global token set still fails closed for other sandboxes", () => {
    const validate = makeDefaultValidateToken({ SH_RELAY_TOKEN_sbx1: "onlysbx1" });
    expect(validate("onlysbx1", "sbx1")).toBe(true);
    expect(validate(undefined, "sbx2")).toBe(false);
    expect(validate("onlysbx1", "sbx2")).toBe(false);
  });
});
