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
import { persistentExecInPod } from "./persistent-exec.js";
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
 * in a remote Kubernetes pod. Inert (local tools stand) unless a sandbox is
 * configured.
 *
 * Two-tier transport:
 *  - fastExec: a persistent in-pod bash channel for the small request/response
 *    ops (read/write/edit/ls/find), with transparent fallback to per-call exec.
 *  - streamExec: M2's per-call `kubectl exec` for the streaming/long-running ops
 *    (bash, grep, user `!`), which need onData/abort/long-running semantics.
 *
 * @param opts.config Explicit config; if omitted, resolved from process.env.
 *                    Pass `null` to force-disable.
 * @param opts.exec   Override BOTH transports (used by tests / alternate auth).
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

    const streamExec = opts?.exec ?? kubectlExecInPod(config);
    const fastExec =
      opts?.exec ?? persistentExecInPod(config, { fallback: kubectlExecInPod(config) });

    // Fast request/response ops → persistent channel.
    pi.registerTool(createReadTool(localCwd, { operations: createPodReadOps(fastExec, config) }));
    pi.registerTool(createWriteTool(localCwd, { operations: createPodWriteOps(fastExec, config) }));
    pi.registerTool(createEditTool(localCwd, { operations: createPodEditOps(fastExec, config) }));
    pi.registerTool(createLsTool(localCwd, { operations: createPodLsOps(fastExec, config) }));
    pi.registerTool(createFindTool(localCwd, { operations: createPodFindOps(fastExec, config) }));

    // Streaming / long-running ops → per-call kubectl exec (M2 path, unchanged).
    pi.registerTool(createBashTool(localCwd, { operations: createPodBashOps(streamExec, config) }));
    pi.registerTool(createPodGrepTool(localCwd, streamExec, config));
    pi.on("user_bash", () => ({ operations: createPodBashOps(streamExec, config) }));

    // Tell the model its cwd is the pod's, not the head's.
    pi.on("before_agent_start", (event) => {
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${config.podCwd} (sandbox pod ${config.namespace}/${config.pod})`,
      );
      return { systemPrompt: modified };
    });

    // Tear down the persistent kubectl process so it is never leaked.
    pi.on("session_shutdown", () => {
      const maybe = fastExec as ExecInPod & { dispose?: () => void };
      if (typeof maybe.dispose === "function") maybe.dispose();
    });
  };
}
