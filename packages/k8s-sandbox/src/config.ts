export interface K8sSandboxConfig {
  /** Pod name to exec into. */
  pod: string;
  /** Kubernetes namespace. */
  namespace: string;
  /** kube context, or undefined to use current-context. */
  context: string | undefined;
  /** Working directory inside the pod (announced to the model). */
  podCwd: string;
  /** The harness process cwd; head paths under it map to podCwd. */
  headCwd: string;
}

/**
 * Resolve sandbox config from environment. Returns null when
 * KAGENTI_SANDBOX_POD is unset — the gate that keeps the extension inert
 * (all tools run locally) unless a sandbox pod is explicitly configured.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, headCwd: string): K8sSandboxConfig | null {
  const pod = env.KAGENTI_SANDBOX_POD;
  if (!pod) return null;
  return {
    pod,
    namespace: env.KAGENTI_SANDBOX_NAMESPACE ?? "default",
    context: env.KAGENTI_SANDBOX_CONTEXT || undefined,
    podCwd: env.KAGENTI_SANDBOX_CWD ?? "/workspace",
    headCwd,
  };
}
