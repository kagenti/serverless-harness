/**
 * Headless one-shot CLI entry.
 *
 * Usage:
 *   tsx src/cli.ts "your prompt here"
 *
 * Environment:
 *   REDIS_URL       Redis connection URL (default: redis://localhost:6379)
 *   PI_SESSION_ID   Set to resume an existing session
 *
 * Prints SESSION_ID=<id> on success so callers can capture it for resumption.
 */
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

async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    throw new Error('usage: cli.ts "<prompt>"   (set PI_SESSION_ID to resume)');
  }

  // Gateway bridge (smoke only): pinned Pi reads ANTHROPIC_API_KEY (not
  // ANTHROPIC_AUTH_TOKEN) and throws if it is unset. When a Bearer-token gateway is
  // configured via ANTHROPIC_AUTH_TOKEN, mirror it into ANTHROPIC_API_KEY so the
  // provider's key guard passes; the wire auth is forced to Bearer on the model below.
  if (process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
  }

  const store = new RedisSessionBackend<FileEntry>(process.env.REDIS_URL);
  const backend = new BufferedRedisBackend(store);
  const cwd = process.cwd();
  const resumeId = process.env.PI_SESSION_ID;

  const sessionManager = resumeId
    ? await SessionManager.openFromBackend(resumeId, backend, cwd)
    : SessionManager.create(cwd, undefined, undefined, backend);

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);

  // Wire flush extension through DefaultResourceLoader — the only supported
  // injection point. createAgentSession does not accept extensionFactories directly.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // k8sSandboxExtension() is inert unless KAGENTI_SANDBOX_POD is set, so the
    // default (Config A, local execution) is unchanged.
    extensionFactories: [flushExtension(backend), k8sSandboxExtension()],
  });
  await resourceLoader.reload();

  // Pinned Pi has no ANTHROPIC_BASE_URL hook and defaults to x-api-key auth. When a
  // gateway is configured, point the base URL at it and force Authorization: Bearer
  // (the `"x-api-key": null` deletes the default header via Pi's mergeHeaders, the same
  // pattern its cloudflare path uses). Env-gated: with neither var set, model is as-is.
  const baseModel = getModel("anthropic", "claude-opus-4-8");
  const gatewayBase = process.env.ANTHROPIC_BASE_URL;
  const gatewayToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const model =
    gatewayBase || gatewayToken
      ? {
          ...baseModel,
          ...(gatewayBase ? { baseUrl: gatewayBase } : {}),
          ...(gatewayToken
            ? {
                headers: {
                  ...baseModel.headers,
                  Authorization: `Bearer ${gatewayToken}`,
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

  // Mirror print-mode.ts: drive one prompt to completion.
  await session.prompt(prompt);

  // Print the assistant's final reply so the smoke is observable (mirrors print-mode.ts).
  const lastMessage = session.state.messages.at(-1) as AssistantMessage | undefined;
  if (lastMessage?.role === "assistant") {
    if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
      // eslint-disable-next-line no-console
      console.error(lastMessage.errorMessage || `Request ${lastMessage.stopReason}`);
    } else {
      for (const content of lastMessage.content) {
        if (content.type === "text") {
          // eslint-disable-next-line no-console
          console.log(content.text);
        }
      }
    }
  }

  await backend.flush(); // belt-and-suspenders before exit
  // eslint-disable-next-line no-console
  console.log(`SESSION_ID=${sessionManager.getSessionId()}`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
