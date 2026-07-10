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
