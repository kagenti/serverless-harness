import {
  Server,
  ServerCredentials,
  type ServerDuplexStream,
  type ServerWritableStream,
  type ServerUnaryCall,
  type sendUnaryData,
} from "@grpc/grpc-js";
import {
  SandboxWorkerService,
  SandboxExecService,
  type SandboxWorkerServer,
  type SandboxExecServer,
  type WorkerFrame,
  type ServerFrame,
  type ExecRequest,
  type ExecEvent,
  type AbortRequest,
  type AbortResponse,
} from "@sh/k8s-sandbox";
import { RedisRecordStore } from "@sh/harness";
import { createRelay, type RelayDeps, type AttachStream } from "./relay.js";

export function buildServer(deps: RelayDeps): { server: Server } {
  const relay = createRelay(deps);
  const server = new Server();

  const workerImpl: SandboxWorkerServer = {
    // AttachStream types metadata.get() as returning string[]; grpc-js's real
    // Metadata.get() returns MetadataValue[] (string | Buffer). The relay only
    // ever reads a bearer token (always sent as a string by well-behaved
    // clients), so the cast is safe here without widening relay.ts's contract.
    attach: (call: ServerDuplexStream<WorkerFrame, ServerFrame>) => relay.onAttach(call as unknown as AttachStream),
  };
  server.addService(SandboxWorkerService, workerImpl);

  const execImpl: SandboxExecServer = {
    // Server-streaming: one ExecRequest in, a stream of ExecEvents out.
    //
    // Client cancellation (harness deadline/abort) fires the call's "cancelled"
    // event. We must NOT rely on calling .return() on the routeExec generator
    // while it idles on its internal await -- that can hang forever if the
    // worker never sends another frame. Instead, on cancellation we tell the
    // worker to abort via relay.routeAbort(); the worker then emits an
    // End/Error frame for that reqId, which drives the generator's sink so it
    // yields that event and returns normally (running its `finally`, which
    // cleans up the sink). This makes worker-disconnect (Task 6) and
    // client-cancel (this task) both terminate the generator cleanly.
    exec: async (call: ServerWritableStream<ExecRequest, ExecEvent>) => {
      const req = call.request;
      const e = req.exec;
      if (!e) {
        call.destroy(new Error("ExecRequest missing exec field"));
        return;
      }
      // Registered synchronously (before the loop's first await) so a
      // cancellation that races the very first event is never missed.
      const onCancelled = () => relay.routeAbort(req.sandboxId, e.reqId);
      call.on("cancelled", onCancelled);

      try {
        for await (const ev of relay.routeExec(req.sandboxId, e.reqId, e.command, e.stdin, e.timeoutS, e.streaming)) {
          call.write(ev);
        }
        call.end();
      } catch (err) {
        call.destroy(err as Error);
      } finally {
        call.removeListener("cancelled", onCancelled);
      }
    },
    abort: (call: ServerUnaryCall<AbortRequest, AbortResponse>, cb: sendUnaryData<AbortResponse>) => {
      relay.routeAbort(call.request.sandboxId, call.request.reqId);
      cb(null, {});
    },
  };
  server.addService(SandboxExecService, execImpl);

  return { server };
}

/**
 * Default token validator: fail-closed. A sandbox authenticates only against
 * an exact, non-empty match on its per-sandbox override (`SH_RELAY_TOKEN_<id>`)
 * or the global `SH_RELAY_TOKEN`. If neither env var is set for a sandbox,
 * `expected` is `undefined` and every token — including an undefined one from
 * a tokenless worker — is rejected, instead of the two `undefined`s comparing
 * equal.
 */
export function makeDefaultValidateToken(
  env: NodeJS.ProcessEnv,
): (token: string | undefined, sandboxId: string) => boolean {
  return (token, sandboxId) => {
    const expected = env[`SH_RELAY_TOKEN_${sandboxId}`] ?? env.SH_RELAY_TOKEN;
    return expected !== undefined && token === expected;
  };
}

export async function startRelay(
  opts: { port?: number; deps?: RelayDeps } = {},
): Promise<{ port: number; shutdown: () => Promise<void> }> {
  const deps = opts.deps ?? {
    records: new RedisRecordStore(),
    validateToken: makeDefaultValidateToken(process.env),
  };
  const { server } = buildServer(deps);
  const addr = `0.0.0.0:${opts.port ?? Number(process.env.SH_RELAY_PORT ?? 8443)}`;
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(addr, ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );
  return { port, shutdown: () => new Promise((r) => server.tryShutdown(() => r())) };
}

// Bootstrap when run directly (tsx entrypoint), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  startRelay().then(({ port }) => console.log(`sandbox-relay listening on :${port}`));
}
