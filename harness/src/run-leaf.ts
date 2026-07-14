import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { RedisSessionBackend } from "@sh/session-backend";
import { k8sSandboxExtension, kubectlExecInPod } from "@sh/k8s-sandbox";
import { selectPoolSandbox, SandboxPoolSaturatedError } from "./select-sandbox.js";
import { convergeWorkspace, cleanupWorkspace, captureWorkspaceDiff } from "./converge.js";
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
  workspaceRef?: string;      // derived from the worktree in P2 when repoUrl+ref are given
  repoUrl?: string;           // P2: git remote to converge the sandbox repo copy from
  ref?: string;               // P2: commit/branch/tag the leaf's worktree is pinned to
  maxTurns?: number;
  async?: boolean;            // when true, the HTTP layer enqueues instead of running inline
  tenant?: string;            // namespaces the session id
  kind?: "converge" | "solve"; // absent/"converge" => existing behavior; "solve" => runSolveLeaf
  problemStatement?: string;   // required when kind === "solve": the task the agent must implement
}

/** The Pi/Redis session id for a leaf: tenant-prefixed (if any), then sanitized. */
export function leafSessionId(env: { sessionId: string; tenant?: string }): string {
  return toSessionId(env.tenant ? `${env.tenant}/${env.sessionId}` : env.sessionId);
}

export type LeafResult =
  | { status: "done"; verdict: Verdict }
  | { status: "paused"; gateId: number; gate: { summary: string; proposed_action: string } }
  | { status: "aborted" }
  | { status: "solved"; patch: string }
  | { status: "failed"; reason: "no_verdict" | "invalid_verdict" | "bad_inputs" | "error" | "saturated"; message?: string };

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

export function buildSolvePrompt(problemStatement: string, workspaceRef: string): string {
  // The agent's tools run in the sandbox pod and its session cwd is a harness-local path, so the
  // worktree root must be given as an absolute in-pod path the model edits under (cf. buildLeafPrompt).
  const root = workspaceRef.replace(/\/+$/, "");
  return [
    `You are fixing a software issue in a checked-out repository.`,
    `Repository root (an absolute path in your sandbox): ${root}`,
    `Use your bash, read, and edit tools with absolute paths under that root. You may run the`,
    `project's own tests to check your work.`,
    ``,
    `## Issue`,
    problemStatement,
    ``,
    `Implement a fix by editing files under ${root}. When you are confident the fix is complete,`,
    `stop — do not ask questions and do not call any reporting tool.`,
  ].join("\n");
}

export type LeafCapture = VerdictCapture & GateCapture;

export type ProduceVerdict = (
  item: LeafItem,
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: LeafCapture,
) => Promise<void>;

export type SolveCapture = { patch?: string };
export type ProduceSolve = (
  env: LeafEnvelope,
  config: TurnConfig | undefined,
  capture: SolveCapture,
) => Promise<void>;

export function validateItem(o: unknown): LeafItem | null {
  if (typeof o !== "object" || o === null) return null;
  const x = o as Record<string, unknown>;
  if (typeof x.item_id === "string" && typeof x.file === "string" && typeof x.pattern === "string") {
    return { item_id: x.item_id, file: x.file, pattern: x.pattern, require_approval: x.require_approval === true };
  }
  return null;
}

export async function runLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceVerdict?: ProduceVerdict; produceSolve?: ProduceSolve },
): Promise<LeafResult> {
  if (env.kind === "solve") return runSolveLeaf(env, config, deps);
  const item = validateItem(env.item);
  if (!item) return { status: "failed", reason: "bad_inputs" };

  const capture: LeafCapture = {};
  const produce = deps?.produceVerdict ?? realProduceVerdict;
  try {
    await produce(item, env, config, capture);
  } catch (err) {
    // Saturation is a distinct, transient signal: the sync /runs path bounded-waits and returns
    // 503 Retry-After on it (spec §4.3), and classifyOutcome keeps it retryable for the async
    // path (drains as leases free). Every other throw is a generic "error".
    if (err instanceof SandboxPoolSaturatedError) {
      return { status: "failed", reason: "saturated", message: err.message };
    }
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

export async function runSolveLeaf(
  env: LeafEnvelope,
  config?: TurnConfig,
  deps?: { produceSolve?: ProduceSolve },
): Promise<LeafResult> {
  if (!env.problemStatement || !env.repoUrl || !env.ref) return { status: "failed", reason: "bad_inputs" };
  const capture: SolveCapture = {};
  const produce = deps?.produceSolve ?? realProduceSolve;
  try {
    await produce(env, config, capture);
  } catch (err) {
    if (err instanceof SandboxPoolSaturatedError) return { status: "failed", reason: "saturated", message: err.message };
    return { status: "failed", reason: "error", message: err instanceof Error ? err.message : String(err) };
  }
  return { status: "solved", patch: capture.patch ?? "" };
}

// Real solve runner: lease a sandbox, converge the per-leaf worktree, run the agent with ONLY the
// sandbox tools (no verdict/gate extensions), then capture the staged diff. Mirrors realProduceVerdict's
// session/pool wiring. Exercised by the Kind smoke, not unit tests.
export const realProduceSolve: ProduceSolve = async (env, config, capture) => {
  const cwd = config?.cwd ?? process.cwd();
  const { provider, modelId } = resolveModelSelection({
    model: env.model ?? config?.model,
    provider: env.provider ?? config?.provider,
  });
  const baseModel = requireModel(provider, modelId);
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  const sid = leafSessionId(env);

  // A solve leaf MUST have a real sandbox worktree — fail fast (before any Redis/session work) if the
  // pool is unconfigured. selectPoolSandbox returns null when no sandbox is configured (run-leaf.ts:209).
  const selected = await selectPoolSandbox(process.env, cwd, sid, {
    cap: Number(process.env.KAGENTI_SANDBOX_CAP ?? "20"),
    ttlMs: Number(process.env.KAGENTI_SANDBOX_LEASE_TTL_MS ?? "60000"),
  });
  if (!selected) throw new Error("solve leaf requires a configured sandbox pool");

  const store = new RedisSessionBackend<FileEntry>(config?.redisUrl ?? "redis://localhost:6379");
  const backend = new BufferedRedisBackend(store);
  const prior = await store.read(sid);
  const sessionManager = prior.length > 0
    ? await SessionManager.openFromCheckpoint(sid, backend, cwd)
    : SessionManager.create(cwd, undefined, { id: sid }, backend);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const exec = kubectlExecInPod(selected.config);
    const workspaceRef = await convergeWorkspace(exec, env.repoUrl!, env.ref!, sid);
    const hbMs = Number(process.env.KAGENTI_SANDBOX_HEARTBEAT_MS ?? "20000");
    heartbeat = setInterval(() => { void selected.heartbeat(); }, hbMs);

    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        k8sSandboxExtension({ config: selected.config }),
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
      await session.prompt(buildSolvePrompt(env.problemStatement!, workspaceRef));
      capture.patch = await captureWorkspaceDiff(exec, sid);
    } finally {
      await backend.flush();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await cleanupWorkspace(kubectlExecInPod(selected.config), sid);
    await selected.release();
  }
};

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

  // --- P2: choose a sandbox pod (pool lease) before building the prompt/session. Placed after the
  // verdict fast-path so a recovered verdict does not lease a pod. Returns null ⇒ no sandbox
  // configured (local tools). Throws SandboxPoolSaturatedError when a configured pool is full.
  const selected = await selectPoolSandbox(process.env, cwd, sid, {
    cap: Number(process.env.KAGENTI_SANDBOX_CAP ?? "20"),
    ttlMs: Number(process.env.KAGENTI_SANDBOX_LEASE_TTL_MS ?? "60000"),
  });
  const converging = selected != null && !!env.repoUrl && !!env.ref;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  try {
    // Ref-pinned lazy converge (spec §5): fetch the ref into the shared object store and add this
    // leaf's worktree; workspaceRef becomes the derived worktree path. All FS work happens in the
    // pod via exec — the harness opens nothing.
    let workspaceRef = env.workspaceRef;
    if (converging) {
      const exec = kubectlExecInPod(selected!.config);
      workspaceRef = await convergeWorkspace(exec, env.repoUrl!, env.ref!, sid);
    }
    if (selected) {
      const hbMs = Number(process.env.KAGENTI_SANDBOX_HEARTBEAT_MS ?? "20000");
      heartbeat = setInterval(() => { void selected.heartbeat(); }, hbMs);
    }

    // Gate front-end (design §3): decide whether to pause, abort, or seed a prompt.
    const gateState = computeGateState(prior.map((p) => p.entry));
    const dv = env.decision ? validateDecision(env.decision) : null;
    const decision = dv && dv.ok ? dv.value : null;
    const seed = decideSeed(gateState, decision, buildLeafPrompt(item, workspaceRef));

    if (seed.kind === "abort") {
      if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);
      capture.aborted = true;
      await backend.flush();
      return;
    }
    if (seed.kind === "paused") {
      capture.gate = seed.gate;
      await backend.flush();
      return;
    }
    if (seed.record) sessionManager.appendCustomEntry(GATE_DECISION_ENTRY_TYPE, seed.record);

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
        k8sSandboxExtension({ config: selected?.config ?? null }),
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
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (converging) await cleanupWorkspace(kubectlExecInPod(selected!.config), sid);
    if (selected) await selected.release();
  }
};
