import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { decide, type DenyRules } from "./decide.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

type ChatMessage = { role?: string; content?: unknown };
type ChatCompletionRequest = { model?: string; messages?: ChatMessage[] };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// AuthBridge's ibac plugin embeds the proposed action (HTTP request line and/or MCP tool name +
// args) in the text of the request's `user` messages. Concatenate them to get the text decide()
// matches against.
export function extractActionText(body: ChatCompletionRequest): string {
  return (body.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

function chatCompletionEnvelope(model: string | undefined, content: string) {
  return {
    id: "ibac-stub-0",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "ibac-stub",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, rules: DenyRules): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "read_error" }));
    return;
  }

  let parsed: ChatCompletionRequest;
  try {
    parsed = JSON.parse(raw);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const actionText = extractActionText(parsed);
  const result = decide(actionText, rules);
  const content = JSON.stringify(result);
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(chatCompletionEnvelope(parsed.model, content)));
}

export function buildHandler(rules: DenyRules): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      handleChatCompletions(req, res, rules).catch((err) => {
        if (!res.headersSent) res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
      });
      return;
    }

    res.writeHead(404).end();
  };
}

export function startServer(rules: DenyRules, port = 8080): Server {
  const server = createServer(buildHandler(rules));

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  server.listen(port, () => {
    console.log(`ibac-stub listening on :${port}`);
  });

  return server;
}
