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
import type { GateCapture } from "./request-approval-tool.js";
import { computeGateState, decideSeed, validateDecision, type Decision, GATE_DECISION_ENTRY_TYPE } from "./gate.js";
import { requestApprovalExtension } from "./request-approval-tool.js";

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

export interface LeafItem { item_id: string; file: string; pattern: string; require_approval?: boolean }

export interface LeafEnvelope {
  sessionId: string;
  item: LeafItem;             // inputs inline (was inputsRef)
  decision?: Decision;        // resume/approve only (was decisionRef)
  model?: string;
  provider?: string;
  workspaceRef?: string;      // absolute path INSIDE the sandbox pod (harness never opens it)
  maxTurns?: number;
  async?: boolean;            // when true, the HTTP layer enqueues instead of running inline
  tenant?: string;            // namespaces the session id
}

/** The Pi/Redis session id for a leaf: tenant-prefixed (if any), then sanitized. */
export function leafSessionId(env: { sessionId: string; tenant?: string }): string {
  return toSessionId(env.tenant ? `${env.tenant}/${env.sessionId}` : env.sessionId);
}

export type LeafResult =
  | { status: "done"; verdict: Verdict }
  | { status: "paused"; gateId: number; gate: { summary: string; proposed_action: string } }
  | { status: "aborted" }
  | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error"; message?: string };

export function buildLeafPrompt(item: LeafItem, workspaceRef?: string): string {
  // The file/grep tools run in the sandbox pod; give the agent the absolute path so it does
  // not resolve a relative path against the harness process cwd (which the sandbox maps away).
  const filePath = workspaceRef ? `${workspaceRef.replace(/\/+$/, "")}/${item.file}` : item.file;
  const lines = [
    `You are reviewing one candidate finding in a sandboxed workspace.`,
    `Item id: ${item.item_id}`,
    `File (read this exact absolute path with the read tool): ${filePath}`,
    `Pattern of interest: ${item.pattern}`,
    `Read the file, decide whether the pattern is present and relevant.`,
  ];
  if (item.require_approval) {
    // Gated turn: steer the agent to request_approval ONLY, and withhold the submit_verdict
    // instruction — otherwise the model takes the simpler path and submits a verdict directly,
    // skipping the gate. The verdict instruction is delivered later by the approve continuation.
    lines.push(
      `A human MUST approve before you finish. Your FIRST and ONLY action now is to call the`,
      `request_approval tool exactly once, with a short summary of what you found and a`,
      `proposed_action stating the verdict you intend to submit. Do NOT submit your verdict yet —`,
      `you will be asked to submit it after the human responds. Call request_approval, then stop.`,
    );
  } else {
    lines.push(
      `Report by calling the submit_verdict tool exactly once with item_id="${item.item_id}". Do not do anything else.`,
    );
  }
  return lines.join("\n");
}

export type LeafCapture = VerdictCapture & GateCapture;

export type ProduceVerdict = (
  item: LeafItem,
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: LeafCapture,
) => Promise<void>;

export function validateItem(o: unknown): LeafItem | null {
  const x = o as Record<string, unknown> | null;
  if (x && typeof x.item_id === "string" && typeof x.file === "string" && typeof x.pattern === "string") {
    return { item_id: x.item_id, file: x.file, pattern: x.pattern, require_approval: x.require_approval === true };
  }
  return null;
}

export async function runLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceVerdict?: ProduceVerdict },
): Promise<LeafResult> {
  const item = validateItem(env.item);
  if (!item) return { status: "failed", reason: "bad_inputs" };

  const capture: LeafCapture = {};
  const produce = deps?.produceVerdict ?? realProduceVerdict;
  try {
    await produce(item, env, config, capture);
  } catch (err) {
    return { status: "failed", reason: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // Gate outcomes take precedence over verdict handling.
  if (capture.aborted) return { status: "aborted" };
  if (capture.gate) {
    return {
      status: "paused",
      gateId: capture.gate.gateId,
      gate: { summary: capture.gate.summary, proposed_action: capture.gate.proposed_action },
    };
  }

  if (!capture.verdict) return { status: "failed", reason: "no_verdict" };
  const v = validateVerdict(capture.verdict);
  if (!v.ok) return { status: "failed", reason: "invalid_verdict", message: v.error };
  return { status: "done", verdict: v.value };
}

// Real Pi session runner — mirrors harness/src/run-turn.ts session setup, made resumable
// (MVP spec §7 gate 7, §2.4 idempotency). The session is persisted to Redis under env.sessionId;
// re-invoking the same sessionId after a crash resumes from the durable log (M5) instead of
// starting fresh. Exercised by the Kind smoke, not the unit tests.
export const realProduceVerdict: ProduceVerdict = async (item, env, config, capture) => {
  // Session cwd is a harness-local path (NOT workspaceRef): the agent's file/search tools run in
  // the sandbox pod, and workspaceRef is an absolute path inside that pod (see buildLeafPrompt).
  // Pointing the session cwd at workspaceRef would make the harness try to load a path it does not
  // have. The k8sSandboxExtension uses process.cwd() as its head cwd regardless.
  const cwd = config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  // Honor the LLM gateway (base URL + Bearer auth) exactly as runTurn does, so leaf model calls
  // reach the same endpoint with the same credentials.
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  // Durable, resumable session keyed by the (sanitized) session id. BufferedRedisBackend drains
  // writes continuously, so a mid-run crash preserves progress up to the last drained entry.
  const sid = leafSessionId(env);
  const store = new RedisSessionBackend<FileEntry>(config?.redisUrl ?? "redis://localhost:6379");
  const backend = new BufferedRedisBackend(store);
  const isVerdictEntry = (e: unknown) =>
    (e as { type?: string }).type === "custom" &&
    (e as { customType?: string }).customType === VERDICT_ENTRY_TYPE;

  // Resume the session if one already exists under this id (retry / post-crash); otherwise create
  // a fresh session persisted under the sanitized id.
  const prior = await store.read(sid);
  const resuming = prior.length > 0;
  const sessionManager = resuming
    ? await SessionManager.openFromCheckpoint(sid, backend, cwd)
    : SessionManager.create(cwd, undefined, { id: sid }, backend);

  // Verdict fast-path (unchanged, M5): if a verdict was already submitted and persisted before a
  // crash, recover it from the durable log and skip re-running the agent entirely.
  if (resuming) {
    const row = await store.latestWhere(sid, isVerdictEntry);
    const recovered = verdictFromCustomEntry(row?.entry);
    if (recovered) {
      capture.verdict = recovered;
      await backend.flush();
      return;
    }
  }

  // Gate front-end (design §3): decide whether to pause, abort, or seed a prompt.
  const gateState = computeGateState(prior.map((p) => p.entry));
  const dv = env.decision ? validateDecision(env.decision) : null;
  const decision = dv && dv.ok ? dv.value : null;
  const seed = decideSeed(gateState, decision, buildLeafPrompt(item, env.workspaceRef));

  if (seed.kind === "abort") {
    if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);
    capture.aborted = true;
    await backend.flush();
    return;
  }
  if (seed.kind === "paused") {
    capture.gate = seed.gate; // re-report the pending gate; runLeaf (re)writes the marker
    await backend.flush();
    return;
  }
  // seed.kind === "seed": record the decision (once) before running the continuation/fresh turn.
  if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);

  // Enforce the gate as a hard guarantee, not a prompt suggestion: for a require_approval item the
  // submit_verdict tool is WITHHELD until the agent has passed at least one gate (a gate-decision
  // exists in the log, or one is being applied this turn). In the pre-gate turn the agent's only
  // structured-output path is request_approval, so it cannot bypass the gate even if it ignores the
  // prompt. After approve/reject the verdict tool is available so the agent can finalize.
  const allowVerdict =
    !item.require_approval || gateState.gateDecisions.length > 0 || seed.record != null;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      ...(allowVerdict ? [submitVerdictExtension(capture, sessionManager)] : []),
      requestApprovalExtension(capture, sessionManager, gateState.nextGateId),
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
    await session.prompt(seed.prompt);
    if (!capture.verdict && !capture.gate) {
      const row = await store.latestWhere(sid, isVerdictEntry);
      const recovered = verdictFromCustomEntry(row?.entry);
      if (recovered) capture.verdict = recovered;
    }
  } finally {
    await backend.flush();
  }
};
