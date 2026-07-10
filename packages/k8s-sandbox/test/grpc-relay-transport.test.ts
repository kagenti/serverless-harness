import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runConformance, type FakeBehavior, type FakeHandle } from "./conformance.js";
import {
  GrpcRelayTransport,
  type ExecClientLike,
} from "../src/grpc-relay-transport.js";
import {
  Stream,
  type AbortRequest,
  type ExecEvent,
  type ExecRequest,
} from "../src/gen/sandbox/v1/sandbox.js";

/** Build a fake ExecClientLike that scripts a FakeBehavior onto ExecEvent frames. */
function fakeClient(behavior: FakeBehavior): {
  client: ExecClientLike;
  stdinSeen: () => Buffer | undefined;
  aborted: () => number[];
} {
  let stdin: Buffer | undefined;
  const aborted: number[] = [];
  const client: ExecClientLike = {
    exec(request: ExecRequest) {
      stdin = request.exec ? Buffer.from(request.exec.stdin) : undefined;
      const reqId = request.exec?.reqId ?? 0;
      const stream = new EventEmitter() as EventEmitter & { cancel: () => void };
      stream.cancel = () => {};
      // Emit scripted frames on the next tick so listeners attach first.
      queueMicrotask(() => {
        if (behavior.hang) return; // never completes
        for (const s of behavior.stdout ?? [])
          stream.emit("data", { chunk: { reqId, data: Buffer.from(s), stream: Stream.STREAM_STDOUT } } as ExecEvent);
        for (const s of behavior.stderr ?? [])
          stream.emit("data", { chunk: { reqId, data: Buffer.from(s), stream: Stream.STREAM_STDERR } } as ExecEvent);
        stream.emit("data", { end: { reqId, exitCode: behavior.exitCode ?? 0 } } as ExecEvent);
        stream.emit("end");
      });
      return stream;
    },
    abort(request: AbortRequest, cb: (err: Error | null) => void) {
      aborted.push(request.reqId);
      cb(null);
      return {};
    },
  };
  return { client, stdinSeen: () => stdin, aborted: () => aborted };
}

const grpcFactory = (behavior: FakeBehavior): FakeHandle => {
  const { client, stdinSeen } = fakeClient(behavior);
  return { transport: GrpcRelayTransport("sbx-1", client), stdinSeen };
};

runConformance("GrpcRelayTransport", grpcFactory);

function manualClient() {
  let stream!: EventEmitter & { cancel: () => void };
  // The transport assigns reqId from its own module-scoped counter (shared with
  // every other exec() call made earlier in this test file, e.g. the
  // runConformance battery above), so the id it actually uses is whatever that
  // counter is at, not a literal we can predict. Capture it from the request
  // GrpcRelayTransport hands to exec() so assertions can compare against the
  // real id instead of guessing it.
  let lastReqId: number | undefined;
  const aborted: number[] = [];
  const client = {
    exec(request?: { exec?: { reqId: number } }) {
      lastReqId = request?.exec?.reqId;
      stream = Object.assign(new EventEmitter(), { cancel: () => {} });
      return stream;
    },
    abort(req: { reqId: number }, cb: (e: Error | null) => void) {
      aborted.push(req.reqId);
      cb(null);
      return {};
    },
  };
  return {
    client,
    emit: (ev: ExecEvent) => stream.emit("data", ev),
    aborted: () => aborted,
    reqId: () => lastReqId,
  };
}

describe("GrpcRelayTransport extra semantics", () => {
  it("dedups: a late End for a settled reqId is dropped", async () => {
    const { client, emit } = manualClient();
    const t = GrpcRelayTransport("sbx-1", client as never);
    const p = t.exec("echo hi");
    emit({ chunk: { reqId: 1, data: Buffer.from("hi"), stream: Stream.STREAM_STDOUT } } as ExecEvent);
    emit({ end: { reqId: 1, exitCode: 0 } } as ExecEvent);
    const r = await p;
    expect(r.stdout.toString()).toBe("hi");
    // A duplicate terminal frame after settlement must not throw or change the result.
    expect(() => emit({ end: { reqId: 1, exitCode: 9 } } as ExecEvent)).not.toThrow();
  });

  it("output cap: aborts, truncates, appends [output truncated]", async () => {
    const { client, emit, aborted, reqId } = manualClient();
    const t = GrpcRelayTransport("sbx-1", client as never, { outputCapBytes: 4 });
    const p = t.exec("cat big");
    emit({ chunk: { reqId: reqId()!, data: Buffer.from("12345"), stream: Stream.STREAM_STDOUT } } as ExecEvent);
    const r = await p;
    expect(r.stdout.toString()).toContain("[output truncated]");
    expect(r.exitCode).toBeNull();
    expect(aborted()).toContain(reqId());
  });

  it("harness deadline fires independently of worker timeout_s", async () => {
    vi.useFakeTimers();
    const { client } = manualClient();
    const t = GrpcRelayTransport("sbx-1", client as never, { deadlineMs: 500 });
    const p = t.exec("sleep 999"); // no exec opts.timeout ⇒ deadlineMs governs
    const assertion = expect(p).rejects.toThrow(/^timeout:/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    vi.useRealTimers();
  });
});
