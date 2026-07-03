import { listPoolPods, resolveSandboxConfig, type RunKubectl, type K8sSandboxConfig } from "@sh/k8s-sandbox";
import { RedisLeaseStore, type LeaseStore } from "./sandbox-lease.js";

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
  heartbeat: () => Promise<void>;
  release: () => Promise<void>;
}

export interface SelectDeps {
  listPods?: (selector: string, namespace: string, context?: string, run?: RunKubectl) => Promise<string[]>;
  lease?: LeaseStore;
  run?: RunKubectl;
}

/**
 * Choose a sandbox pod for a leaf.
 *  - No `KAGENTI_SANDBOX_POOL_SELECTOR` ⇒ fall back to single-pod resolution
 *    (`KAGENTI_SANDBOX_POD`/`_NAME`); returns null if that too is unset (run local tools).
 *  - Pool configured ⇒ list Running pods, pick least-loaded under the soft cap, acquire a lease.
 *    Throws SandboxPoolSaturatedError if all pods are full.
 */
export async function selectPoolSandbox(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  runId: string,
  opts: { cap: number; ttlMs: number },
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
  if (pods.length === 0) throw new Error(`no Running pods for pool selector '${selector}'`);

  const loads = await Promise.all(pods.map(async (pod) => ({ pod, active: await lease.load(pod) })));
  for (const pod of orderByLoad(loads)) {
    if (await lease.acquire(pod, opts.cap, runId, opts.ttlMs)) {
      const config: K8sSandboxConfig = { pod, namespace, context, podCwd, headCwd };
      return {
        config,
        heartbeat: () => lease.heartbeat(pod, runId, opts.ttlMs),
        release: () => lease.release(pod, runId),
      };
    }
  }
  throw new SandboxPoolSaturatedError(selector);
}
