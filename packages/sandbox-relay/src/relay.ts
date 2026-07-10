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
  // per-reqId sinks for in-flight execs (Task 6 populates these)
  sinks: Map<number, (ev: ExecEvent) => void>;
}

export interface Relay {
  onAttach(stream: AttachStream): void;
  parked(): string[];
  // routeExec/routeAbort added in Task 6
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
        void deps.records.put(rec);
        return;
      }
      // chunk/end/error frames are dispatched to per-reqId sinks in Task 6
      const parked = sandboxId ? sessions.get(sandboxId) : undefined;
      if (!parked) return;
      const reqId = frame.chunk?.reqId ?? frame.end?.reqId ?? frame.error?.reqId;
      if (reqId !== undefined) parked.sinks.get(reqId)?.(toExecEvent(frame));
    });
    const teardown = () => {
      if (sandboxId) {
        sessions.delete(sandboxId);
        void deps.records.remove(sandboxId);
      }
    };
    stream.on("end", teardown);
    stream.on("error", teardown);
  }

  return { onAttach, parked: () => [...sessions.keys()] };
}

/** Map a worker→relay frame to the harness-facing ExecEvent oneof (Task 6 uses this). */
export function toExecEvent(frame: WorkerFrame): ExecEvent {
  if (frame.chunk) return { chunk: frame.chunk } as ExecEvent;
  if (frame.end) return { end: frame.end } as ExecEvent;
  return { error: frame.error } as ExecEvent;
}
