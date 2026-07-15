import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/main.js";
import type { RecordStore } from "@sh/harness";

const records: RecordStore = { put: async () => {}, remove: async () => {}, list: async () => [] };

/** Grabs the exact bound handler grpc-js registered for a full method path. */
function getHandler(server: unknown, path: string): (call: unknown) => unknown {
  const handlers = (server as { handlers: Map<string, { func: (call: unknown) => unknown }> }).handlers;
  const entry = handlers.get(path);
  if (!entry) throw new Error(`no handler registered for ${path}`);
  return entry.func;
}

describe("relay server wiring", () => {
  it("registers both gRPC services", () => {
    const { server } = buildServer({ records, validateToken: () => true });
    // grpc-js Server keeps registered handlers in a private `handlers` Map keyed
    // by full method path (e.g. "/sandbox.v1.SandboxWorker/Attach"). The brief's
    // original snippet assumed a plain Record with Object.keys(), but the
    // installed @grpc/grpc-js (1.14.x) stores it as a Map -- adapted accordingly.
    const handlers = (server as unknown as { handlers: Map<string, unknown> }).handlers;
    expect(handlers).toBeInstanceOf(Map);
    const names = [...handlers.keys()];
    expect(names.some((n) => n.includes("SandboxWorker"))).toBe(true);
    expect(names.some((n) => n.includes("SandboxExec"))).toBe(true);
  });
});

/** Fake bidi Attach stream, same shape used by relay-attach/relay-exec tests. */
function fakeAttach() {
  const s = new EventEmitter() as EventEmitter & {
    metadata: { get: () => string[] };
    write: (f: unknown) => void;
    end: () => void;
    written: unknown[];
  };
  s.metadata = { get: () => [] };
  s.written = [];
  s.write = (f) => s.written.push(f);
  s.end = () => s.emit("end");
  return s;
}

/** Fake server-streaming call, the shape main.ts's exec handler expects. */
function fakeExecCall(request: unknown) {
  const c = new EventEmitter() as EventEmitter & {
    request: unknown;
    write: (ev: unknown) => void;
    end: () => void;
    destroy: (err: Error) => void;
    written: unknown[];
    ended: boolean;
    destroyed?: Error;
  };
  c.request = request;
  c.written = [];
  c.ended = false;
  c.write = (ev) => c.written.push(ev);
  c.end = () => (c.ended = true);
  c.destroy = (err) => (c.destroyed = err);
  return c;
}

describe("relay server exec cancellation wiring (via the real registered handler)", () => {
  it("aborts the worker on client cancel and cleanly drains the generator", async () => {
    const { server } = buildServer({ records, validateToken: () => true });
    const attach = getHandler(server, "/sandbox.v1.SandboxWorker/Attach");
    const exec = getHandler(server, "/sandbox.v1.SandboxExec/Exec");

    const worker = fakeAttach();
    attach(worker);
    worker.emit("data", {
      hello: { sandboxId: "sbx-1", labels: {}, capabilities: [], image: "", arch: "amd64", capacityMax: 1, trust: "trusted" },
    });

    const call = fakeExecCall({
      sandboxId: "sbx-1",
      exec: { reqId: 1, command: "sleep 100", stdin: new Uint8Array(), timeoutS: 0, streaming: true },
    });
    exec(call);

    // routeExec has parked its sink and written ServerFrame{exec} to the worker.
    await vi.waitFor(() => expect((worker.written.at(-1) as { exec?: { reqId: number } })?.exec?.reqId).toBe(1));

    // Harness (client) cancels its own call -- e.g. its deadline fired.
    call.emit("cancelled");

    // The handler must NOT just call .return() on the idling generator; it must
    // tell the worker to abort so the worker's own reply drives cleanup.
    await vi.waitFor(() => expect((worker.written.at(-1) as { abort?: { reqId: number } })?.abort?.reqId).toBe(1));

    // Worker honors the abort with an error frame for that reqId.
    worker.emit("data", { error: { reqId: 1, message: "aborted" } });

    // The generator yields that event and returns -- exec handler writes it and ends.
    await vi.waitFor(() => expect((call.written.at(-1) as { error?: { message: string } })?.error?.message).toBe("aborted"));
    await vi.waitFor(() => expect(call.ended).toBe(true));
    expect(call.destroyed).toBeUndefined();
  });

  it("destroys the call when routeExec throws (e.g. absent sandbox)", async () => {
    const { server } = buildServer({ records, validateToken: () => true });
    const exec = getHandler(server, "/sandbox.v1.SandboxExec/Exec");

    const call = fakeExecCall({
      sandboxId: "ghost",
      exec: { reqId: 1, command: "x", stdin: new Uint8Array(), timeoutS: 0, streaming: true },
    });
    exec(call);

    await vi.waitFor(() => expect(call.destroyed).toBeInstanceOf(Error));
    expect(call.destroyed?.message).toMatch(/no live worker/);
    expect(call.ended).toBe(false);
  });
});
