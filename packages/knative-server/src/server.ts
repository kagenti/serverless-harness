import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn, type TurnConfig } from "@sh/harness/run-turn";
import { runLeaf, type LeafEnvelope } from "@sh/harness/run-leaf";
import { RedisWorkQueue } from "@sh/work-queue";
import { readDoneMarker, deriveDoneMarkerPath } from "@sh/harness/done-marker";
import { readGateMarker } from "@sh/harness/gate-marker";

const PORT = parseInt(process.env.PORT || "8080", 10);
// Status markers live under the orchestrator-owned work root; the status endpoint refuses
// to read anything outside it (path-traversal guard on the untrusted doneMarker query param).
const WORK_ROOT = process.env.LEAF_WORK_DIR ?? "/work";
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

function isLeafEnvelope(o: any): o is LeafEnvelope {
  return o && typeof o.sessionId === "string" && typeof o.inputsRef === "string" && typeof o.resultRef === "string";
}

let queue: RedisWorkQueue | undefined;
function getQueue(): RedisWorkQueue {
  if (!queue) queue = new RedisWorkQueue(process.env.REDIS_URL);
  return queue;
}

async function handleEnqueueLeafParsed(body: any, res: ServerResponse): Promise<void> {
  if (!isLeafEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }
  const q = getQueue();
  await q.ensureGroup();
  await q.enqueue(body);
  res.writeHead(202, JSON_HEADERS).end(JSON.stringify({
    status: "accepted", sessionId: body.sessionId, resultRef: body.resultRef,
    doneMarker: deriveDoneMarkerPath(body.resultRef, body.doneMarkerRef),
  }));
}

async function handleRunLeafParsed(body: any, _raw: string, res: ServerResponse): Promise<void> {
  if (!isLeafEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }
  const result = await runLeaf(body, buildConfig());
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
}

// Confine an untrusted marker path to the work root (path-traversal guard). Returns null if outside.
function confineToWorkRoot(p: string): string | null {
  const resolved = resolvePath(p);
  if (resolved !== WORK_ROOT && !resolved.startsWith(`${WORK_ROOT}/`)) return null;
  return resolved;
}

function handleLeafStatus(url: URL, res: ServerResponse): void {
  const doneMarker = url.searchParams.get("doneMarker");
  if (!doneMarker) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "doneMarker_required" })); return; }
  const resolved = confineToWorkRoot(doneMarker);
  if (!resolved) { res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ error: "doneMarker_forbidden" })); return; }

  const marker = readDoneMarker(resolved);
  if (marker) {
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: marker.status, reason: marker.reason ?? undefined }));
    return;
  }

  // No terminal marker yet — if a gate marker path is supplied, report awaiting_approval.
  const gateMarker = url.searchParams.get("gateMarker");
  if (gateMarker) {
    const g = confineToWorkRoot(gateMarker);
    if (!g) { res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ error: "gateMarker_forbidden" })); return; }
    const gm = readGateMarker(g);
    if (gm) {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: gm.status, gateId: gm.gateId }));
      return;
    }
  }

  // Best-effort non-terminal state for visibility.
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "queued" }));
}

// Pre-rename wire paths kept as aliases (issue #37). The public execution route is now the
// industry-standard "run" noun (`/runs`); the internal `runLeaf`/`LeafEnvelope` vocabulary is
// unchanged. Aliases warn once per path and are removed in a later release.
const DEPRECATED_ROUTE_ALIASES: Record<string, string> = {
  "/run-leaf": "/runs",
  "/run-leaf/status": "/runs/status",
};
const warnedDeprecatedRoutes = new Set<string>();
function warnDeprecatedRoute(oldPath: string): void {
  if (warnedDeprecatedRoutes.has(oldPath)) return;
  warnedDeprecatedRoutes.add(oldPath);
  console.warn(
    `[deprecation] ${oldPath} is deprecated and will be removed in a future release; use ${DEPRECATED_ROUTE_ALIASES[oldPath]} instead`,
  );
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";

  if (req.method === "GET" && url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }

  // Run-status endpoint: canonical `/runs/status`, plus the deprecated `/run-leaf/status` alias.
  if (req.method === "GET" && (url.startsWith("/runs/status") || url.startsWith("/run-leaf/status"))) {
    if (url.startsWith("/run-leaf/status")) warnDeprecatedRoute("/run-leaf/status");
    handleLeafStatus(new URL(url, "http://localhost"), res);
    return;
  }

  // Run endpoint: canonical `POST /runs`, plus the deprecated `POST /run-leaf` alias.
  if (req.method === "POST" && (url === "/runs" || url === "/run-leaf")) {
    if (url === "/run-leaf") warnDeprecatedRoute("/run-leaf");
    const route = async () => {
      const raw = await readBody(req);
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* handled below */ }
      if (parsed && parsed.async === true) return handleEnqueueLeafParsed(parsed, res);
      return handleRunLeafParsed(parsed, raw, res);
    };
    route().catch((err) => { if (!res.headersSent) res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) })); });
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

// Exact entrypoint match (matches cron-dispatch.ts) — avoids a fragile substring
// match that would misfire for any argv path containing "knative-server".
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  startServer();
}
