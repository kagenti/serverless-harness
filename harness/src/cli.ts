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
import { getModel } from "@earendil-works/pi-ai";
import { RedisSessionBackend } from "@sh/session-backend";
import { BufferedRedisBackend } from "./buffered-redis-backend.js";
import { flushExtension } from "./flush-extension.js";

async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    throw new Error('usage: cli.ts "<prompt>"   (set PI_SESSION_ID to resume)');
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
    extensionFactories: [flushExtension(backend)],
  });
  await resourceLoader.reload();

  const model = getModel("anthropic", "claude-opus-4-8");

  const { session } = await createAgentSession({
    sessionManager,
    model,
    resourceLoader,
    settingsManager,
  });

  // Mirror print-mode.ts: drive one prompt to completion.
  await session.prompt(prompt);

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
