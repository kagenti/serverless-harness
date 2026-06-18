import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { getModel, type AssistantMessage } from "@earendil-works/pi-ai";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "./buffered-redis-backend.js";
import { flushExtension } from "./flush-extension.js";
import { k8sSandboxExtension } from "@sh/k8s-sandbox";

export interface TurnConfig {
  redisUrl?: string;
  cwd?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
}

export interface TurnResult {
  sessionId: string;
  response: string;
  stopReason: string;
  errorMessage?: string;
}

export async function runTurn(
  prompt: string,
  sessionId: string | undefined,
  config?: TurnConfig,
): Promise<TurnResult> {
  const redisUrl = config?.redisUrl ?? "redis://localhost:6379";
  const cwd = config?.cwd ?? process.cwd();

  const authToken = config?.anthropicAuthToken ?? process.env.ANTHROPIC_AUTH_TOKEN;
  if (authToken && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = authToken;
  }

  const store = new RedisSessionBackend<FileEntry>(redisUrl);
  const backend = new BufferedRedisBackend(store);

  const sessionManager = sessionId
    ? await SessionManager.openFromBackend(sessionId, backend, cwd)
    : SessionManager.create(cwd, undefined, undefined, backend);

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [flushExtension(backend), k8sSandboxExtension()],
  });
  await resourceLoader.reload();

  const baseModel = getModel("anthropic", "claude-opus-4-8");
  const gatewayBase = config?.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL;
  const model =
    gatewayBase || authToken
      ? {
          ...baseModel,
          ...(gatewayBase ? { baseUrl: gatewayBase } : {}),
          ...(authToken
            ? {
                headers: {
                  ...baseModel.headers,
                  Authorization: `Bearer ${authToken}`,
                  "x-api-key": null,
                } as Record<string, string>,
              }
            : {}),
        }
      : baseModel;

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
