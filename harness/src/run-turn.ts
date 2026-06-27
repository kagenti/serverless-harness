import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { getModel, getModels, getProviders, type AssistantMessage } from "@earendil-works/pi-ai";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "./buffered-redis-backend.js";
import { flushExtension } from "./flush-extension.js";
import { k8sSandboxExtension } from "@sh/k8s-sandbox";
import { checkpointExtension } from "./checkpoint-extension.js";
import { budgetVoterExtension, branchSpend } from "./budget-voter.js";

export interface TurnConfig {
  redisUrl?: string;
  cwd?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  model?: string;
  provider?: string;
}

export interface ModelSelection {
  provider: string;
  modelId: string;
}

/** Resolve model + provider as runtime inputs: config > env > default. */
export function resolveModelSelection(
  config?: { model?: string; provider?: string },
  env: NodeJS.ProcessEnv = process.env,
): ModelSelection {
  return {
    provider: config?.provider ?? env.SH_MODEL_PROVIDER ?? "anthropic",
    modelId: config?.model ?? env.SH_MODEL ?? "claude-opus-4-8",
  };
}

/**
 * Resolve a model from the pi-ai registry, throwing a clear error when the id is unknown.
 * getModel() returns undefined for an unknown provider/model (e.g. the dotted
 * "claude-sonnet-4.6" is a github-copilot key, not an anthropic one) — without this guard
 * the caller crashes later on `baseModel.headers`. Returns the model object on success.
 */
export function requireModel(provider: string, modelId: string) {
  const model = getModel(provider as never, modelId as never);
  if (model) return model;
  const providers = getProviders() as string[];
  if (!providers.includes(provider)) {
    throw new Error(
      `Unknown model provider "${provider}". Known providers: ${providers.join(", ")}.`,
    );
  }
  const ids = (getModels(provider as never) as Array<{ id: string }>).map((m) => m.id);
  // Surface the dot-vs-dash (or case) twin if one exists — the common mistake.
  const norm = (s: string) => s.replace(/[.\-]/g, "").toLowerCase();
  const suggestions = ids.filter((id) => norm(id) === norm(modelId));
  const hint = suggestions.length
    ? `Did you mean: ${suggestions.join(", ")}?`
    : `Known "${provider}" ids include: ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ", …" : ""}.`;
  throw new Error(`Unknown model "${provider}/${modelId}" — not in the pi-ai registry. ${hint}`);
}

export interface TurnResult {
  sessionId: string;
  response: string;
  stopReason: string;
  errorMessage?: string;
}

/**
 * Apply the LLM-gateway transform to a pi-ai model object.
 *
 * When a gateway base URL or auth token is in play (config or env), rewrite the model to
 * call the gateway with Bearer auth and strip `x-api-key` (the gateway authenticates via
 * Authorization). Also seeds `ANTHROPIC_API_KEY` from the auth token when unset, since some
 * pi-ai code paths still read the env var. Returns the base model unchanged when neither a
 * gateway base nor a token is configured (direct-key mode).
 *
 * Shared by runTurn (interactive) and runLeaf (job mode) so both honor the same credentials.
 */
export function applyModelGateway<M extends { headers?: Record<string, unknown> }>(
  baseModel: M,
  config?: Pick<TurnConfig, "anthropicBaseUrl" | "anthropicAuthToken">,
): M {
  // `||` (not `??`) so an empty-string config value falls back to the env var rather than
  // suppressing it — "" is a "not set" sentinel here, not a meaningful credential.
  const authToken = config?.anthropicAuthToken || process.env.ANTHROPIC_AUTH_TOKEN;
  // Intentional process.env mutation: some pi-ai code paths read ANTHROPIC_API_KEY at
  // invocation time, so seed it from the auth token. This now runs from two call sites
  // (runTurn and runLeaf via applyModelGateway) — do NOT "clean it up" into a local.
  if (authToken && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = authToken;
  }
  const gatewayBase = config?.anthropicBaseUrl || process.env.ANTHROPIC_BASE_URL;
  if (!gatewayBase && !authToken) return baseModel;
  return {
    ...baseModel,
    ...(gatewayBase ? { baseUrl: gatewayBase } : {}),
    ...(gatewayBase
      ? {
          // Anthropic-compatible gateways (e.g. litellm) reject the per-tool extras the
          // direct Anthropic API accepts. Without this, tool-bearing requests fail with
          // "tools.0.custom.eager_input_streaming: Extra inputs are not permitted". Disable
          // the gateway-incompatible compat flags so convertTools() omits those fields.
          compat: {
            ...(baseModel as { compat?: Record<string, unknown> }).compat,
            supportsEagerToolInputStreaming: false,
            supportsCacheControlOnTools: false,
            supportsLongCacheRetention: false,
          },
        }
      : {}),
    ...(authToken
      ? {
          headers: {
            ...baseModel.headers,
            Authorization: `Bearer ${authToken}`,
            "x-api-key": null, // strip x-api-key when using gateway Bearer auth
          } as unknown as Record<string, string>,
        }
      : {}),
  };
}

export async function runTurn(
  prompt: string,
  sessionId: string | undefined,
  config?: TurnConfig,
): Promise<TurnResult> {
  const redisUrl = config?.redisUrl ?? "redis://localhost:6379";
  const cwd = config?.cwd ?? process.cwd();

  const store = new RedisSessionBackend<FileEntry>(redisUrl);
  const backend = new BufferedRedisBackend(store);

  const sessionManager = sessionId
    ? await SessionManager.openFromCheckpoint(sessionId, backend, cwd)
    : SessionManager.create(cwd, undefined, undefined, backend);

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);

  const budgetLimit = Number(process.env.SH_BUDGET_TOKENS);
  const budgetMargin = Number(process.env.SH_BUDGET_MARGIN);
  const extensionFactories = [
    flushExtension(backend),
    k8sSandboxExtension(),
    checkpointExtension(store, sessionManager),
  ];
  if (Number.isFinite(budgetLimit) && budgetLimit > 0) {
    // session_start is not emitted in the headless path, so compute the pre-turn baseline
    // (cumulative spend already on the loaded branch) here and inject it into the voter.
    const budgetBaseline = branchSpend(sessionManager) ?? 0;
    extensionFactories.push(
      budgetVoterExtension(sessionManager, {
        limit: budgetLimit,
        baseline: budgetBaseline,
        ...(Number.isFinite(budgetMargin) && budgetMargin > 0 ? { margin: budgetMargin } : {}),
      }),
    );
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();

  const { provider, modelId } = resolveModelSelection(config);
  const baseModel = requireModel(provider, modelId);
  const model = applyModelGateway(baseModel as { headers?: Record<string, unknown> }, config);

  const { session } = await createAgentSession({
    sessionManager,
    model,
    resourceLoader,
    settingsManager,
  });

  await session.prompt(prompt);

  const lastMessage = session.state.messages.at(-1) as AssistantMessage | undefined;
  let response = "";
  let stopReason = "end_turn";
  let errorMessage: string | undefined;

  if (lastMessage?.role === "assistant") {
    stopReason = lastMessage.stopReason ?? "end_turn";
    if (stopReason === "error" || stopReason === "aborted") {
      errorMessage = lastMessage.errorMessage || `Request ${stopReason}`;
    } else {
      for (const content of lastMessage.content) {
        if (content.type === "text") {
          response += content.text;
        }
      }
    }
  }

  await backend.flush();

  return {
    sessionId: sessionManager.getSessionId(),
    response,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  };
}
