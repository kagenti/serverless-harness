import { credentials } from "@grpc/grpc-js";
import {
  listPoolPods,
  resolveSandboxConfig,
  GrpcRelayTransport,
  SandboxExecClient,
  type RunKubectl,
  type K8sSandboxConfig,
  type SandboxTransport,
  type ExecClientLike,
} from "@sh/k8s-sandbox";
import { RedisLeaseStore, type LeaseStore } from "./sandbox-lease.js";
import { RedisRecordStore, type RecordStore, type SandboxRecord } from "./pool-records.js";

/** Pure: pods ordered ascending by active load (stable — ties keep input order). */
export function orderByLoad(loads: { pod: string; active: number }[]): string[] {
  return loads
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => a.active - b.active || a.i - b.i)
    .map((l) => l.pod);
}

/** Thrown when a pool is configured but every pod is at the soft cap. */
export class SandboxPoolSaturatedError extends Error {
  constructor(selector: string) {
    super(`sandbox pool '${selector}' saturated: all pods at capacity`);
    this.name = "SandboxPoolSaturatedError";
  }
}

export interface SelectedSandbox {
  config: K8sSandboxConfig;
  /** Present ONLY for a leased grpc presence record; undefined for pods. */
  transport?: SandboxTransport;
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
}

export interface SelectDeps {
  listPods?: (selector: string, namespace: string, context?: string, run?: RunKubectl) => Promise<string[]>;
  lease?: LeaseStore;
  run?: RunKubectl;
  /** Mirrored grpc presence records; defaults to a RedisRecordStore. Only consulted when opts.remoteSandbox is true. */
  records?: RecordStore;
  /** Builds the exec client for a leased grpc record; defaults to a real SandboxExecClient at SH_RELAY_ADDR. */
  makeExecClient?: (sandboxId: string) => ExecClientLike;
}

/** Lazily builds a real gRPC exec client — only reached on the grpc branch when the flag is on. */
function defaultExecClient(_sandboxId: string, env: NodeJS.ProcessEnv): ExecClientLike {
  const addr = env.SH_RELAY_ADDR ?? "sandbox-relay.default.svc.cluster.local:8443";
  return new SandboxExecClient(addr, credentials.createInsecure()) as unknown as ExecClientLike;
}

/**
 * Choose a sandbox pod for a leaf.
 *  - No `KAGENTI_SANDBOX_POOL_SELECTOR` ⇒ fall back to single-pod resolution
 *    (`KAGENTI_SANDBOX_POD`/`_NAME`); returns null if that too is unset (run local tools).
 *  - Pool configured ⇒ list Running pods (plus mirrored grpc records when `opts.remoteSandbox`
 *    is true), pick least-loaded under the soft cap, acquire a lease. Throws
 *    SandboxPoolSaturatedError if every candidate is full.
 */
export async function selectPoolSandbox(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  runId: string,
  opts: { cap: number; ttlMs: number; remoteSandbox?: boolean },
  deps: SelectDeps = {},
): Promise<SelectedSandbox | null> {
  const selector = env.KAGENTI_SANDBOX_POOL_SELECTOR;
  if (!selector) {
    const config = await resolveSandboxConfig(env, headCwd, deps.run);
    return config ? { config, heartbeat: async () => {}, release: async () => {} } : null;
  }

  const namespace = env.KAGENTI_SANDBOX_NAMESPACE ?? "default";
  const context = env.KAGENTI_SANDBOX_CONTEXT || undefined;
  const podCwd = env.KAGENTI_SANDBOX_CWD ?? "/workspace";
  const list = deps.listPods ?? listPoolPods;
  const lease = deps.lease ?? new RedisLeaseStore(env.REDIS_URL);

  const pods = await list(selector, namespace, context, deps.run);

  // Inertness: when the flag is off, never construct a RedisRecordStore or call .list() —
  // the pod path must stay byte-for-byte identical to today (no extra Redis connection).
  const remoteOn = opts.remoteSandbox === true;
  const grpcRecs: SandboxRecord[] = remoteOn ? await (deps.records ?? new RedisRecordStore(env.REDIS_URL)).list() : [];
  const grpcById = new Map(grpcRecs.map((r) => [r.sandboxId, r]));

  const candidates = [...pods, ...grpcRecs.map((r) => r.sandboxId)];
  if (candidates.length === 0) throw new Error(`no Running pods for pool selector '${selector}'`);

  const loads = await Promise.all(candidates.map(async (name) => ({ pod: name, active: await lease.load(name) })));
  for (const name of orderByLoad(loads)) {
    if (await lease.acquire(name, opts.cap, runId, opts.ttlMs)) {
      const config: K8sSandboxConfig = { pod: name, namespace, context, podCwd, headCwd };
      const rec = grpcById.get(name);
      const transport = rec
        ? GrpcRelayTransport(name, (deps.makeExecClient ?? ((id: string) => defaultExecClient(id, env)))(name))
        : undefined;
      return {
        config,
        transport,
        heartbeat: () => lease.heartbeat(name, runId, opts.ttlMs),
        release: () => lease.release(name, runId),
      };
    }
  }
  throw new SandboxPoolSaturatedError(selector);
}
