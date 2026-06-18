import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runTurn, type TurnConfig } from "@sh/harness/run-turn";

const PORT = parseInt(process.env.PORT || "8080", 10);
const JSON_HEADERS = { "Content-Type": "application/json" };

function buildConfig(): TurnConfig {
  return {
    redisUrl: process.env.REDIS_URL,
    cwd: process.env.HARNESS_CWD || process.cwd(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "read_error" }));
    return;
  }

  let parsed: { sessionId?: string; prompt?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const { sessionId, prompt } = parsed;
  if (!prompt) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "prompt_required" }));
    return;
  }

  try {
    const result = await runTurn(prompt, sessionId, buildConfig());
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("no session in backend") ? 404 : 500;
    res.writeHead(status, JSON_HEADERS).end(
      JSON.stringify({
        error: status === 404 ? "session_not_found" : message,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  }
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }

  if (req.method === "POST" && req.url === "/turn") {
    handleTurn(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS).end(
          JSON.stringify({ error: String(err) }),
        );
      }
    });
    return;
  }

  res.writeHead(404).end();
}

export function startServer(port = PORT): ReturnType<typeof createServer> {
  const server = createServer(handler);

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  server.listen(port, () => {
    console.log(`serverless-harness listening on :${port}`);
  });

  return server;
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("knative-server");
if (isMainModule) {
  startServer();
}
