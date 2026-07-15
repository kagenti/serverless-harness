import { describe, expect, it, vi } from "vitest";
import type { K8sSandboxConfig } from "../src/config.js";
import type { SandboxTransport } from "../src/transport.js";
import { k8sSandboxExtension } from "../src/extension.js";

const cfg: K8sSandboxConfig = {
  pod: "sbx-0",
  namespace: "default",
  context: undefined,
  podCwd: "/workspace",
  headCwd: "/head",
};

/** Minimal ExtensionAPI stub recording registrations + event handlers. */
function fakePi() {
  const tools: unknown[] = [];
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const pi = {
    registerTool: (t: unknown) => tools.push(t),
    on: (name: string, h: (...a: unknown[]) => unknown) => {
      handlers[name] = h;
    },
  } as unknown as Parameters<ReturnType<typeof k8sSandboxExtension>>[0];
  return { pi, tools, handlers };
}

const okTransport = (close = vi.fn(async () => {})): SandboxTransport => ({
  exec: async () => ({ stdout: Buffer.from(""), exitCode: 0 }),
  close,
});

describe("k8sSandboxExtension", () => {
  it("registers the seven pod tools and wires the lifecycle handlers", () => {
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: okTransport() })(pi);
    expect(tools).toHaveLength(7);
    expect(typeof handlers.user_bash).toBe("function");
    expect(typeof handlers.before_agent_start).toBe("function");
    expect(typeof handlers.session_shutdown).toBe("function");
  });

  it("closes the fast channel on session_shutdown", async () => {
    const close = vi.fn(async () => {});
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: okTransport(close) })(pi);
    await handlers.session_shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is inert (registers nothing) when config is null", () => {
    const { pi, tools } = fakePi();
    k8sSandboxExtension({ config: null })(pi);
    expect(tools).toHaveLength(0);
  });
});
