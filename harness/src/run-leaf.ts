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
import { deriveGateRef, writeGateMarker } from "./gate-marker.js";
import type { GateCapture } from "./request-approval-tool.js";
import { computeGateState, decideSeed, readDecision, GATE_DECISION_ENTRY_TYPE } from "./gate.js";
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
  model?: string;
  provider?: string;
  inputsRef: string;
  resultRef: string;
  workspaceRef?: string;
  maxTurns?: number;
  async?: boolean;            // when true, the HTTP layer enqueues instead of running inline
  doneMarkerRef?: string;     // overrides the derived <resultRef>.status
  tenant?: string;            // namespaces the session id (non-precluding; design §7)
  gateRef?: string;           // overrides the derived <resultRef>.gate marker path (design §2.4)
  decisionRef?: string;       // present on a resume invocation; the decision file to apply (design §2.3)
}

/** The Pi/Redis session id for a leaf: tenant-prefixed (if any), then sanitized. */
export function leafSessionId(env: { sessionId: string; tenant?: string }): string {
  return toSessionId(env.tenant ? `${env.tenant}/${env.sessionId}` : env.sessionId);
}

export type LeafResult =
  | { status: "done"; resultRef: string }
  | { status: "paused"; gateRef: string; gateId: number }
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

function readItem(inputsRef: string): LeafItem | null {
  try {
    const o = JSON.parse(readFileSync(inputsRef, "utf8"));
    if (o && typeof o.item_id === "string" && typeof o.file === "string" && typeof o.pattern === "string") {
      return { item_id: o.item_id, file: o.file, pattern: o.pattern, require_approval: o.require_approval === true };
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
    const gateRef = deriveGateRef(env.resultRef, env.gateRef);
    writeGateMarker(gateRef, {
      status: "awaiting_approval",
      sessionId: env.sessionId,
      gateId: capture.gate.gateId,
      gate: { summary: capture.gate.summary, proposed_action: capture.gate.proposed_action },
      ts: new Date().toISOString(),
    });
    return { status: "paused", gateRef, gateId: capture.gate.gateId };
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
  const cwd = config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  const sid = leafSessionId(env);
  const store = new RedisSessionBackend<FileEntry>(config?.redisUrl ?? "redis://localhost:6379");
  const backend = new BufferedRedisBackend(store);
  const isVerdictEntry = (e: unknown) =>
    (e as { type?: string }).type === "custom" &&
    (e as { customType?: string }).customType === VERDICT_ENTRY_TYPE;

  const prior = await store.read(sid);
  const resuming = prior.length > 0;
  const sessionManager = resuming
    ? await SessionManager.openFromCheckpoint(sid, backend, cwd)
    : SessionManager.create(cwd, undefined, { id: sid }, backend);

  // Verdict fast-path (unchanged): recover a previously-submitted verdict on resume.
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
  const decision = env.decisionRef ? readDecision(env.decisionRef) : null;
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
