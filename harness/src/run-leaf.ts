import { readFileSync, writeFileSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { resolveModelSelection, requireModel, type TurnConfig } from "./run-turn.js";
import { submitVerdictExtension, type VerdictCapture } from "./submit-verdict-tool.js";
import { validateVerdict } from "./verdict.js";

export interface LeafItem { item_id: string; file: string; pattern: string }

export interface LeafEnvelope {
  sessionId: string;
  model?: string;
  provider?: string;
  inputsRef: string;
  resultRef: string;
  workspaceRef?: string;
  maxTurns?: number;
}

export type LeafResult =
  | { status: "done"; resultRef: string }
  | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error"; message?: string };

export function buildLeafPrompt(item: LeafItem, workspaceRef?: string): string {
  const root = workspaceRef ?? ".";
  return [
    `You are reviewing one candidate finding in the repository at ${root}.`,
    `Item id: ${item.item_id}`,
    `File: ${item.file}`,
    `Pattern of interest: ${item.pattern}`,
    `Open the file, decide whether the pattern is present and relevant, then report by calling`,
    `the submit_verdict tool exactly once with item_id="${item.item_id}". Do not do anything else.`,
  ].join("\n");
}

export type ProduceVerdict = (
  item: LeafItem,
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: VerdictCapture,
) => Promise<void>;

function readItem(inputsRef: string): LeafItem | null {
  try {
    const o = JSON.parse(readFileSync(inputsRef, "utf8"));
    if (o && typeof o.item_id === "string" && typeof o.file === "string" && typeof o.pattern === "string") {
      return { item_id: o.item_id, file: o.file, pattern: o.pattern };
    }
    return null;
  } catch {
    return null;
  }
}

export async function runLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceVerdict?: ProduceVerdict },
): Promise<LeafResult> {
  const item = readItem(env.inputsRef);
  if (!item) return { status: "failed", reason: "bad_inputs" };

  const capture: VerdictCapture = {};
  const produce = deps?.produceVerdict ?? realProduceVerdict;
  try {
    await produce(item, env, config, capture);
  } catch (err) {
    return { status: "failed", reason: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (!capture.verdict) return { status: "failed", reason: "no_verdict" };
  const v = validateVerdict(capture.verdict);
  if (!v.ok) return { status: "failed", reason: "invalid_verdict", message: v.error };

  writeFileSync(env.resultRef, JSON.stringify(v.value));
  return { status: "done", resultRef: env.resultRef };
}

// Real Pi session runner — mirrors harness/src/run-turn.ts session setup.
// Extensions are passed via DefaultResourceLoader's extensionFactories array,
// exactly as run-turn.ts does at lines 117-122. The submitVerdictExtension(capture)
// factory is prepended so the agent can call submit_verdict before any other extension runs.
// Exercised by the Kind smoke (Task 6), not the unit tests.
export const realProduceVerdict: ProduceVerdict = async (item, env, config, capture) => {
  const cwd = env.workspaceRef ?? config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  const model = baseModel;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const sessionManager = SessionManager.create(cwd, undefined, undefined);

  // Wire the verdict extension via DefaultResourceLoader extensionFactories —
  // the same mechanism run-turn.ts uses for flushExtension, k8sSandboxExtension, etc.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [submitVerdictExtension(capture)],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    sessionManager,
    model: model as never,
    resourceLoader,
    settingsManager,
  });

  // TODO(Task 6 / live path): wire env.maxTurns into the session run loop once the live agentic path is verified.
  await session.prompt(buildLeafPrompt(item, env.workspaceRef));
};
