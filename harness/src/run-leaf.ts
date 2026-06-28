import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { k8sSandboxExtension } from "@sh/k8s-sandbox";
import { resolveModelSelection, requireModel, applyModelGateway, type TurnConfig } from "./run-turn.js";
import { BufferedRedisBackend } from "./buffered-redis-backend.js";
import { flushExtension } from "./flush-extension.js";
import { checkpointExtension } from "./checkpoint-extension.js";
import { submitVerdictExtension, VERDICT_ENTRY_TYPE, type VerdictCapture } from "./submit-verdict-tool.js";
import { validateVerdict, type Verdict } from "./verdict.js";

/**
 * Recover a verdict from a persisted `verdict` custom session entry (written by
 * submitVerdictExtension). Returns the validated verdict, or null if the entry is not a
 * verdict marker or its data is not schema-valid. Used to recover a verdict on resume when
 * the in-memory capture was lost to a crash.
 */
export function verdictFromCustomEntry(entry: unknown): Verdict | null {
  const e = entry as { type?: string; customType?: string; data?: unknown } | null;
  if (!e || e.type !== "custom" || e.customType !== VERDICT_ENTRY_TYPE) return null;
  const r = validateVerdict(e.data);
  return r.ok ? r.value : null;
}

/**
 * Map an envelope session_id (the idempotency key, e.g. "<run>/<item>") to a valid Pi session
 * id: Pi requires it to contain only [A-Za-z0-9._-] and to start/end alphanumeric. Slashes (used
 * by the spec's "<run_id>/<item_id>" convention) and other separators become "-". Deterministic,
 * so a retry/resume of the same envelope id maps to the same session.
 */
export function toSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return cleaned || "leaf";
}

export interface LeafItem { item_id: string; file: string; pattern: string }

export interface LeafEnvelope {
  sessionId: string;
  model?: string;
  provider?: string;
  inputsRef: string;
  resultRef: string;
  workspaceRef?: string;
  maxTurns?: number;
  async?: boolean;            // when true, the HTTP layer enqueues instead of running inline
  doneMarkerRef?: string;     // overrides the derived <resultRef>.status
  tenant?: string;            // namespaces the session id (non-precluding; design §7)
}

/** The Pi/Redis session id for a leaf: tenant-prefixed (if any), then sanitized. */
export function leafSessionId(env: { sessionId: string; tenant?: string }): string {
  return toSessionId(env.tenant ? `${env.tenant}/${env.sessionId}` : env.sessionId);
}

export type LeafResult =
  | { status: "done"; resultRef: string }
  | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error"; message?: string };

export function buildLeafPrompt(item: LeafItem, workspaceRef?: string): string {
  // The file/grep tools run in the sandbox pod; give the agent the absolute path so it does
  // not resolve a relative path against the harness process cwd (which the sandbox maps away).
  const filePath = workspaceRef ? `${workspaceRef.replace(/\/+$/, "")}/${item.file}` : item.file;
  return [
    `You are reviewing one candidate finding in a sandboxed workspace.`,
    `Item id: ${item.item_id}`,
    `File (read this exact absolute path with the read tool): ${filePath}`,
    `Pattern of interest: ${item.pattern}`,
    `Read the file, decide whether the pattern is present and relevant, then report by calling`,
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

  mkdirSync(dirname(env.resultRef), { recursive: true }); // ensure the (possibly fire-stamped) parent dir exists
  writeFileSync(env.resultRef, JSON.stringify(v.value));
  return { status: "done", resultRef: env.resultRef };
}

// Real Pi session runner — mirrors harness/src/run-turn.ts session setup, made resumable
// (MVP spec §7 gate 7, §2.4 idempotency). The session is persisted to Redis under env.sessionId;
// re-invoking the same sessionId after a crash resumes from the durable log (M5) instead of
// starting fresh. Exercised by the Kind smoke, not the unit tests.
export const realProduceVerdict: ProduceVerdict = async (item, env, config, capture) => {
  // Session cwd is a harness-local path (NOT workspaceRef): the agent's file/search tools run
  // in the sandbox pod, and workspaceRef is an absolute path inside that pod (see buildLeafPrompt).
  // Pointing the session cwd at workspaceRef would make the harness try to load a path it does
  // not have. The k8sSandboxExtension uses process.cwd() as its head cwd regardless.
  const cwd = config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  // Honor the LLM gateway (base URL + Bearer auth) exactly as runTurn does, so leaf model
  // calls reach the same endpoint with the same credentials.
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  // Durable, resumable session keyed by the (sanitized) session id. BufferedRedisBackend drains
  // writes continuously, so a mid-run crash preserves progress up to the last drained entry.
  const sid = leafSessionId(env);
  const store = new RedisSessionBackend<FileEntry>(config?.redisUrl ?? "redis://localhost:6379");
  const backend = new BufferedRedisBackend(store);
  const isVerdictEntry = (e: unknown) =>
    (e as { type?: string }).type === "custom" &&
    (e as { customType?: string }).customType === VERDICT_ENTRY_TYPE;

  // Resume the session if one already exists under this id (retry / post-crash); otherwise
  // create a fresh session persisted under the sanitized id.
  const prior = await store.read(sid);
  const resuming = prior.length > 0;
  const sessionManager = resuming
    ? await SessionManager.openFromCheckpoint(sid, backend, cwd)
    : SessionManager.create(cwd, undefined, { id: sid }, backend);

  // Fast path: if a verdict was already submitted (and persisted) before a crash, recover it
  // from the durable log and skip re-running the agent entirely.
  if (resuming) {
    const row = await store.latestWhere(sid, isVerdictEntry);
    const recovered = verdictFromCustomEntry(row?.entry);
    if (recovered) {
      capture.verdict = recovered;
      await backend.flush();
      return;
    }
  }

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);

  // Wire extensions via DefaultResourceLoader extensionFactories — the same mechanism
  // run-turn.ts uses. k8sSandboxExtension() routes read/grep/bash/edit/write into the sandbox
  // pod (KAGENTI_SANDBOX_POD), so agent-driven execution never runs in the credentialed harness
  // pod. submitVerdictExtension persists the verdict durably (for resume); flush + checkpoint
  // give M5 turn-level durability.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      submitVerdictExtension(capture, sessionManager),
      k8sSandboxExtension(),
      flushExtension(backend),
      checkpointExtension(store, sessionManager),
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    sessionManager,
    model: model as never,
    resourceLoader,
    settingsManager,
  });

  try {
    // TODO(maxTurns): wire env.maxTurns into the run loop once a turn bound is needed.
    await session.prompt(buildLeafPrompt(item, env.workspaceRef));
    // Belt-and-suspenders: if the agent submitted before a prior crash but the in-memory capture
    // is empty on this run, recover from the durable log.
    if (!capture.verdict) {
      const row = await store.latestWhere(sid, isVerdictEntry);
      const recovered = verdictFromCustomEntry(row?.entry);
      if (recovered) capture.verdict = recovered;
    }
  } finally {
    await backend.flush();
  }
};
