import { spawn } from "node:child_process";
import { resolveConfig, type K8sSandboxConfig } from "./config.js";

/** Pure: kubectl args to read a Sandbox's status.selector (a label-selector string). */
export function buildSelectorArgs(name: string, namespace: string, context?: string): string[] {
  const args = ["get", "sandbox", name, "-n", namespace];
  if (context) args.push("--context", context);
  args.push("-o", "jsonpath={.status.selector}");
  return args;
}

/** Pure: kubectl args to read the first Running pod name matching a label selector. */
export function buildPodNameArgs(selector: string, namespace: string, context?: string): string[] {
  const args = ["get", "pod", "-n", namespace, "-l", selector, "--field-selector=status.phase=Running"];
  if (context) args.push("--context", context);
  args.push("-o", "jsonpath={.items[0].metadata.name}");
  return args;
}

export type RunKubectl = (args: string[]) => Promise<string>;

const defaultRun: RunKubectl = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out).toString().trim())
        : reject(new Error(`kubectl ${args.join(" ")} failed (${code}): ${Buffer.concat(err).toString().trim()}`)),
    );
  });

/**
 * Resolve sandbox config from env. Precedence:
 *  1. KAGENTI_SANDBOX_POD (explicit pod name) — no kubectl call (fallback / tests).
 *  2. KAGENTI_SANDBOX_NAME — resolve the pod from the Sandbox CR's `.status.selector`.
 *  3. neither — null (extension stays off; local tools stand).
 * Resolution runs once per leaf-session at extension init; a sandbox restart is picked up on the
 * next invocation (design §6.2).
 */
export async function resolveSandboxConfig(
  env: NodeJS.ProcessEnv,
  headCwd: string,
  run: RunKubectl = defaultRun,
): Promise<K8sSandboxConfig | null> {
  const direct = resolveConfig(env, headCwd);
  if (direct) return direct;

  const name = env.KAGENTI_SANDBOX_NAME;
  if (!name) return null;

  const namespace = env.KAGENTI_SANDBOX_NAMESPACE ?? "default";
  const context = env.KAGENTI_SANDBOX_CONTEXT || undefined;

  const selector = (await run(buildSelectorArgs(name, namespace, context))).trim();
  if (!selector) throw new Error(`Sandbox/${name} has no .status.selector yet`);
  const pod = (await run(buildPodNameArgs(selector, namespace, context))).trim();
  if (!pod) throw new Error(`no Running pod for selector '${selector}'`);

  return { pod, namespace, context, podCwd: env.KAGENTI_SANDBOX_CWD ?? "/workspace", headCwd };
}
