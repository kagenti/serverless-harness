import type { RecordStore, SandboxRecord } from "@sh/harness";
import type { ExecEvent, ServerFrame, WorkerFrame } from "@sh/k8s-sandbox";

export interface AttachStream {
  metadata?: { get: (k: string) => string[] };
  on(event: "data", cb: (f: WorkerFrame) => void): unknown;
  on(event: "end", cb: () => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  write(f: ServerFrame): void;
  end(): void;
}

export interface RelayDeps {
  records: RecordStore;
  validateToken: (token: string | undefined, sandboxId: string) => boolean;
}

interface Parked {
  stream: AttachStream;
  // per-reqId sinks for in-flight execs, populated by routeExec
  sinks: Map<number, (ev: ExecEvent) => void>;
}

export interface Relay {
  onAttach(stream: AttachStream): void;
  parked(): string[];
  routeExec(
    sandboxId: string,
    reqId: number,
    command: string,
    stdin: Uint8Array,
    timeoutS: number,
    streaming: boolean,
  ): AsyncIterable<ExecEvent>;
  routeAbort(sandboxId: string, reqId: number): void;
}

function bearer(md?: { get: (k: string) => string[] }): string | undefined {
  const v = md?.get("authorization")?.[0];
  return v?.startsWith("Bearer ") ? v.slice(7) : undefined;
}

export function createRelay(deps: RelayDeps): Relay {
  const sessions = new Map<string, Parked>();

  function onAttach(stream: AttachStream): void {
    let sandboxId: string | undefined;
    stream.on("data", (frame: WorkerFrame) => {
      if (frame.hello && !sandboxId) {
        const id = frame.hello.sandboxId;
        if (!deps.validateToken(bearer(stream.metadata), id)) {
          stream.end(); // reject before parking; no presence written
          return;
        }
        sandboxId = id;
        sessions.set(id, { stream, sinks: new Map() });
        const rec: SandboxRecord = {
          sandboxId: id,
          labels: frame.hello.labels,
          capabilities: frame.hello.capabilities,
          capacityMax: frame.hello.capacityMax,
          transport: "grpc",
        };
        void deps.records.put(rec).catch((e) => console.error("presence put failed", e));
        return;
      }
      // chunk/end/error frames are dispatched to the per-reqId sink registered by routeExec
      const parked = sandboxId ? sessions.get(sandboxId) : undefined;
      if (!parked) return;
      const reqId = frame.chunk?.reqId ?? frame.end?.reqId ?? frame.error?.reqId;
      if (reqId !== undefined) parked.sinks.get(reqId)?.(toExecEvent(frame));
    });
    const teardown = () => {
      if (sandboxId) {
        // Fail any in-flight execs fast instead of leaving their routeExec
        // generators parked forever on a frame that will never arrive.
        const parked = sessions.get(sandboxId);
        if (parked) {
          for (const [reqId, sink] of parked.sinks) {
            sink({ error: { reqId, message: "worker disconnected" } } as ExecEvent);
          }
        }
        sessions.delete(sandboxId);
        void deps.records.remove(sandboxId).catch((e) => console.error("presence remove failed", e));
      }
    };
    stream.on("end", teardown);
    stream.on("error", teardown);
  }

  async function* routeExec(
    sandboxId: string,
    reqId: number,
    command: string,
    stdin: Uint8Array,
    timeoutS: number,
    streaming: boolean,
  ): AsyncGenerator<ExecEvent> {
    const parked = sessions.get(sandboxId);
    if (!parked) throw new Error(`no live worker for sandbox '${sandboxId}'`);

    const queue: ExecEvent[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    parked.sinks.set(reqId, (ev) => {
      queue.push(ev);
      if (ev.end || ev.error) done = true;
      notify?.();
    });

    parked.stream.write({ exec: { reqId, command, stdin, timeoutS, streaming } } as ServerFrame);

    try {
      while (true) {
        while (queue.length) {
          const ev = queue.shift()!;
          yield ev;
          if (ev.end || ev.error) return;
        }
        if (done) return;
        await new Promise<void>((r) => (notify = r));
      }
    } finally {
      parked.sinks.delete(reqId);
    }
  }

  function routeAbort(sandboxId: string, reqId: number): void {
    sessions.get(sandboxId)?.stream.write({ abort: { reqId } } as ServerFrame);
  }

  return { onAttach, parked: () => [...sessions.keys()], routeExec, routeAbort };
}

/** Map a worker→relay frame to the harness-facing ExecEvent oneof (Task 6 uses this). */
export function toExecEvent(frame: WorkerFrame): ExecEvent {
  if (frame.chunk) return { chunk: frame.chunk } as ExecEvent;
  if (frame.end) return { end: frame.end } as ExecEvent;
  return { error: frame.error } as ExecEvent;
}
