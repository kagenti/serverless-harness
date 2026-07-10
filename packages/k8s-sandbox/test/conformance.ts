import { describe, expect, it, vi, afterEach } from "vitest";
import type { SandboxTransport } from "../src/transport.js";

/**
 * A scripted sandbox backend, transport-agnostic. Each transport's conformance
 * factory maps these fields onto its own wire (KubectlTransport → a fake child
 * process; ST5's GrpcRelayTransport → scripted ExecEvent frames).
 */
export interface FakeBehavior {
  /** chunks emitted on stdout (collected into the returned `stdout` buffer) */
  stdout?: string[];
  /** chunks emitted on stderr (streamed to onData, NOT in the returned buffer) */
  stderr?: string[];
  /** exit code delivered on completion */
  exitCode?: number | null;
  /** never complete — used to exercise timeout/abort */
  hang?: boolean;
}

export interface FakeHandle {
  transport: SandboxTransport;
  /** the stdin the transport forwarded to the backend, once exec has run */
  stdinSeen: () => Buffer | undefined;
}

export type TransportFactory = (behavior: FakeBehavior) => FakeHandle;

/**
 * The shared SandboxTransport contract. ST2 runs it against KubectlTransport;
 * ST5 will run this SAME battery against GrpcRelayTransport. That identical pass
 * is what makes the two implementations safely swappable (spec §11, driver #2).
 */
export function runConformance(label: string, make: TransportFactory): void {
  afterEach(() => vi.useRealTimers());

  describe(`SandboxTransport conformance: ${label}`, () => {
    it("returns collected stdout and the exit code", async () => {
      const { transport } = make({ stdout: ["foo", "bar"], exitCode: 0 });
      const r = await transport.exec("echo hi");
      expect(r.stdout.toString()).toBe("foobar");
      expect(r.exitCode).toBe(0);
    });

    it("streams stdout and stderr to onData; stderr is excluded from stdout", async () => {
      const { transport } = make({ stdout: ["out"], stderr: ["err"], exitCode: 0 });
      const chunks: string[] = [];
      const r = await transport.exec("cmd", { onData: (c) => chunks.push(c.toString()) });
      expect(r.stdout.toString()).toBe("out"); // stderr NOT collected
      expect(chunks).toContain("out");
      expect(chunks).toContain("err"); // stderr streamed
    });

    it("forwards stdin to the backend", async () => {
      const { transport, stdinSeen } = make({ stdout: [], exitCode: 0 });
      await transport.exec("base64 -d", { stdin: Buffer.from("payload") });
      expect(stdinSeen()?.toString()).toBe("payload");
    });

    it("propagates a non-zero exit code", async () => {
      const { transport } = make({ stdout: [], exitCode: 3 });
      const r = await transport.exec("false");
      expect(r.exitCode).toBe(3);
    });

    it("rejects with timeout:<n> when the command exceeds the timeout", async () => {
      vi.useFakeTimers();
      const { transport } = make({ hang: true });
      const p = transport.exec("sleep 999", { timeout: 2 });
      const assertion = expect(p).rejects.toThrow("timeout:2");
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
    });

    it("rejects with 'aborted' when the signal fires", async () => {
      const { transport } = make({ hang: true });
      const ac = new AbortController();
      const p = transport.exec("sleep 999", { signal: ac.signal });
      ac.abort();
      await expect(p).rejects.toThrow("aborted");
    });

    it("close() resolves and is idempotent", async () => {
      const { transport } = make({ stdout: [], exitCode: 0 });
      await expect(transport.close()).resolves.toBeUndefined();
      await expect(transport.close()).resolves.toBeUndefined();
    });
  });
}
