import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { type K8sSandboxConfig, resolveConfig } from "./config.js";
import { type ExecInPod, kubectlExecInPod } from "./exec.js";
import {
  createPodBashOps,
  createPodEditOps,
  createPodFindOps,
  createPodLsOps,
  createPodReadOps,
  createPodWriteOps,
} from "./operations.js";
import { createPodGrepTool } from "./grep-tool.js";

/**
 * Pi extension that overrides the seven built-in tools so file/search/exec run
 * in a remote Kubernetes pod via `kubectl exec`. Inert (returns immediately,
 * leaving Pi's local tools in place) unless a sandbox is configured.
 *
 * @param opts.config Explicit config; if omitted, resolved from process.env.
 *                    Pass `null` to force-disable.
 * @param opts.exec   Override the transport (used by tests / alternate auth).
 */
export function k8sSandboxExtension(opts?: {
  config?: K8sSandboxConfig | null;
  exec?: ExecInPod;
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const localCwd = process.cwd();
    const config =
      opts?.config !== undefined ? opts.config : resolveConfig(process.env, localCwd);
    if (!config) return; // off gate — local tools stand

    const exec = opts?.exec ?? kubectlExecInPod(config);

    pi.registerTool(createReadTool(localCwd, { operations: createPodReadOps(exec, config) }));
    pi.registerTool(createWriteTool(localCwd, { operations: createPodWriteOps(exec, config) }));
    pi.registerTool(createEditTool(localCwd, { operations: createPodEditOps(exec, config) }));
    pi.registerTool(createBashTool(localCwd, { operations: createPodBashOps(exec, config) }));
    pi.registerTool(createLsTool(localCwd, { operations: createPodLsOps(exec, config) }));
    pi.registerTool(createFindTool(localCwd, { operations: createPodFindOps(exec, config) }));
    pi.registerTool(createPodGrepTool(localCwd, exec, config));

    // User `!` commands also run in the pod.
    pi.on("user_bash", () => ({ operations: createPodBashOps(exec, config) }));

    // Tell the model its cwd is the pod's, not the head's.
    pi.on("before_agent_start", (event) => {
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${config.podCwd} (sandbox pod ${config.namespace}/${config.pod})`,
      );
      return { systemPrompt: modified };
    });
  };
}
