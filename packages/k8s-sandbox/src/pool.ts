import { type RunKubectl, defaultRunKubectl } from "./resolve-pod.js";

/** Pure: kubectl args to list Running pod names matching a label selector (one name per line). */
export function buildPoolPodsArgs(selector: string, namespace: string, context?: string): string[] {
  const args = ["get", "pod", "-n", namespace, "-l", selector, "--field-selector=status.phase=Running"];
  if (context) args.push("--context", context);
  args.push("-o", "jsonpath={range .items[*]}{.metadata.name}{'\\n'}{end}");
  return args;
}

/** Pure: parse newline-separated pod names from kubectl stdout. */
export function parsePodNames(stdout: string): string[] {
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** List Running pod names in the pool (all pods matching the shared pool label). */
export async function listPoolPods(
  selector: string,
  namespace: string,
  context?: string,
  run: RunKubectl = defaultRunKubectl,
): Promise<string[]> {
  return parsePodNames(await run(buildPoolPodsArgs(selector, namespace, context)));
}
