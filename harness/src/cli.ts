import { runTurn } from "./run-turn.js";

async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    throw new Error('usage: cli.ts "<prompt>"   (set PI_SESSION_ID to resume)');
  }

  const result = await runTurn(prompt, process.env.PI_SESSION_ID, {
    redisUrl: process.env.REDIS_URL,
    cwd: process.cwd(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  });

  if (result.errorMessage) {
    console.error(result.errorMessage);
  } else {
    console.log(result.response);
  }
  console.log(`SESSION_ID=${result.sessionId}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
