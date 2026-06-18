# M4: Knative Serverless Wrapper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the serverless harness as a Knative Serving HTTP service that scales to zero between turns, proving the core serverless thesis on a local Kind cluster.

**Architecture:** Extract the shared turn logic from `cli.ts` into a reusable `runTurn()` function. Build a new `@sh/knative-server` package with a minimal Node HTTP server. Containerize with a multi-stage Dockerfile and deploy as a Knative Service on Kind with Kourier networking.

**Tech Stack:** TypeScript, Node.js 20, pnpm workspaces, vitest, Docker, Knative Serving, Kourier, Kind, Redis

**Spec:** `docs/specs/2026-06-17-m4-knative-serverless-wrapper-design.md`

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `harness/src/run-turn.ts` | Reusable turn logic: create/resume session, run prompt, return result |
| `harness/test/run-turn.test.ts` | Integration test for `runTurn()` with real Redis |
| `packages/knative-server/package.json` | Package manifest for `@sh/knative-server` |
| `packages/knative-server/tsconfig.json` | TypeScript config |
| `packages/knative-server/vitest.config.ts` | Vitest config |
| `packages/knative-server/src/server.ts` | HTTP server (`POST /turn`, `GET /health`, graceful shutdown) |
| `packages/knative-server/src/index.ts` | Package exports |
| `packages/knative-server/test/server.test.ts` | Unit tests (mocked `runTurn`) |
| `Dockerfile` | Multi-stage container build |
| `deploy/knative/service.yaml` | Knative Service manifest |
| `deploy/knative/redis.yaml` | Redis Deployment + Service for Kind |
| `deploy/knative/sandbox.yaml` | Sandbox pod (copy of k8s-sandbox/deploy/sandbox.yaml) |
| `deploy/knative/setup-kind.sh` | One-shot setup: Knative + Redis + build + deploy |
| `deploy/knative/smoke.sh` | Live smoke test: scale 0→1→0 + session recall |

### Modified files

| File | Change |
|------|--------|
| `harness/src/cli.ts` | Replace inline logic with `runTurn()` call |
| `pnpm-workspace.yaml` | Already covers `packages/*` — no change needed |

---

## Task 1: Extract `runTurn()` from `cli.ts`

**Files:**
- Create: `harness/src/run-turn.ts`
- Modify: `harness/src/cli.ts`

- [ ] **Step 1: Create `harness/src/run-turn.ts` with the full implementation**

```ts
// harness/src/run-turn.ts
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

  // Gateway bridge: mirror token into API_KEY env for Pi's key guard.
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
```

- [ ] **Step 2: Rewrite `harness/src/cli.ts` as a thin wrapper**

```ts
// harness/src/cli.ts
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
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `pnpm -C harness test`

Expected: All tests pass (the `integration.test.ts` and `buffered-redis-backend.test.ts` do not import from `cli.ts`, so they are unaffected by the refactor).

- [ ] **Step 4: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add harness/src/run-turn.ts harness/src/cli.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Feat: Extract runTurn() from cli.ts for reuse by HTTP server"
```

---

## Task 2: Integration test for `runTurn()`

**Files:**
- Create: `harness/test/run-turn.test.ts`

**Prerequisites:** Task 1 complete. Redis running on localhost:6379 (the same `sh-redis` container used by existing integration tests).

- [ ] **Step 1: Write the integration test**

```ts
// harness/test/run-turn.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { RedisSessionBackend } from "@sh/session-backend";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { runTurn } from "../src/run-turn.js";

const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const store = new RedisSessionBackend<FileEntry>(REDIS);
const createdSessions: string[] = [];

afterAll(async () => {
  for (const sid of createdSessions) {
    await store.reset(sid);
  }
  await store.close();
});

describe("runTurn()", () => {
  it("creates a new session when sessionId is undefined", async () => {
    const result = await runTurn("Say exactly: PONG", undefined, {
      redisUrl: REDIS,
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.response).toContain("PONG");
    expect(result.stopReason).toBe("end_turn");
    createdSessions.push(result.sessionId);
  });

  it("resumes an existing session from Redis", async () => {
    // Create a session first
    const first = await runTurn("Remember the code word: ZEBRA42", undefined, {
      redisUrl: REDIS,
    });
    createdSessions.push(first.sessionId);

    // Resume and ask for recall
    const second = await runTurn(
      "What was the code word I told you?",
      first.sessionId,
      { redisUrl: REDIS },
    );

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.response).toContain("ZEBRA42");
  });

  it("throws when sessionId does not exist in Redis", async () => {
    await expect(
      runTurn("hello", "nonexistent-session-id-12345", { redisUrl: REDIS }),
    ).rejects.toThrow("no session in backend");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm -C harness exec vitest run test/run-turn.test.ts`

Expected: All three tests pass. (Requires `ANTHROPIC_API_KEY` set for the LLM calls in tests 1 and 2; test 3 fails fast at the Redis lookup without an LLM call.)

Note: Tests 1 and 2 make real LLM calls. They will be slow (~10–30s each). This is acceptable for an integration test — these are not run in CI without credentials.

- [ ] **Step 3: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add harness/test/run-turn.test.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Test: Add runTurn() integration tests with real Redis"
```

---

## Task 3: Create `@sh/knative-server` package scaffold

**Files:**
- Create: `packages/knative-server/package.json`
- Create: `packages/knative-server/tsconfig.json`
- Create: `packages/knative-server/vitest.config.ts`
- Create: `packages/knative-server/src/index.ts`

- [ ] **Step 1: Create `packages/knative-server/package.json`**

```json
{
  "name": "@sh/knative-server",
  "type": "module",
  "version": "0.0.0",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "start": "node --import tsx src/server.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@sh/harness": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/knative-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `packages/knative-server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `packages/knative-server/src/index.ts`**

```ts
// packages/knative-server/src/index.ts
export { startServer } from "./server.js";
```

- [ ] **Step 5: Add `@sh/harness` exports field to `harness/package.json`**

The `@sh/knative-server` package depends on `@sh/harness` for `runTurn`. The harness
package needs an `exports` field so the workspace link resolves:

Edit `harness/package.json` to add `exports`:

```json
{
  "name": "@sh/harness",
  "type": "module",
  "version": "0.0.0",
  "exports": {
    ".": "./src/index.ts",
    "./run-turn": "./src/run-turn.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@sh/session-backend": "workspace:*",
    "@sh/k8s-sandbox": "workspace:*",
    "@earendil-works/pi-ai": "link:../pi-fork/packages/ai",
    "@earendil-works/pi-coding-agent": "link:../pi-fork/packages/coding-agent"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Also create `harness/src/index.ts` if it does not exist:

```ts
// harness/src/index.ts
export { runTurn, type TurnConfig, type TurnResult } from "./run-turn.js";
```

- [ ] **Step 6: Run `pnpm install` to link the new package**

Run: `pnpm -C /Users/paolo/Projects/aiplatform/serverless-harness install`

Expected: Lockfile updates, workspace link for `@sh/knative-server` resolves.

- [ ] **Step 7: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/knative-server/ harness/package.json harness/src/index.ts pnpm-lock.yaml
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Feat: Scaffold @sh/knative-server package"
```

---

## Task 4: Implement the HTTP server

**Files:**
- Create: `packages/knative-server/src/server.ts`

- [ ] **Step 1: Write the server implementation**

```ts
// packages/knative-server/src/server.ts
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

// Auto-start when run directly (not imported for tests)
const isMainModule =
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("knative-server");
if (isMainModule) {
  startServer();
}
```

- [ ] **Step 2: Update `packages/knative-server/src/index.ts`**

```ts
// packages/knative-server/src/index.ts
export { startServer } from "./server.js";
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm -C packages/knative-server exec tsc --noEmit`

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/knative-server/src/server.ts packages/knative-server/src/index.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Feat: Implement HTTP server for Knative serverless wrapper"
```

---

## Task 5: Unit tests for the HTTP server

**Files:**
- Create: `packages/knative-server/test/server.test.ts`

- [ ] **Step 1: Write the unit tests (mocked `runTurn`)**

```ts
// packages/knative-server/test/server.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";

// Mock runTurn before importing server
vi.mock("@sh/harness/run-turn", () => ({
  runTurn: vi.fn(),
}));

import { startServer } from "../src/server.js";
import { runTurn } from "@sh/harness/run-turn";

const mockedRunTurn = vi.mocked(runTurn);
let server: ReturnType<typeof startServer>;
let baseUrl: string;

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("Content-Type", "application/json");
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

beforeAll(async () => {
  server = startServer(0); // port 0 = random available port
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const res = await request("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });
});

describe("POST /turn", () => {
  it("returns 200 with session result on success", async () => {
    mockedRunTurn.mockResolvedValueOnce({
      sessionId: "test-session-1",
      response: "Hello!",
      stopReason: "end_turn",
    });

    const res = await request("POST", "/turn", { prompt: "Hi" });
    expect(res.status).toBe(200);

    const json = JSON.parse(res.body);
    expect(json.sessionId).toBe("test-session-1");
    expect(json.response).toBe("Hello!");
    expect(json.stopReason).toBe("end_turn");
  });

  it("passes sessionId to runTurn when provided", async () => {
    mockedRunTurn.mockResolvedValueOnce({
      sessionId: "existing-session",
      response: "Resumed!",
      stopReason: "end_turn",
    });

    const res = await request("POST", "/turn", {
      sessionId: "existing-session",
      prompt: "Continue",
    });
    expect(res.status).toBe(200);
    expect(mockedRunTurn).toHaveBeenCalledWith(
      "Continue",
      "existing-session",
      expect.any(Object),
    );
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await request("POST", "/turn", { sessionId: "abc" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("prompt_required");
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const url = new URL("/turn", baseUrl);
        const req = http.request(url, { method: "POST" }, (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({
              status: r.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        });
        req.on("error", reject);
        req.write("not valid json{{{");
        req.end();
      },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_json");
  });

  it("returns 404 when session not found", async () => {
    mockedRunTurn.mockRejectedValueOnce(
      new Error("Cannot resume: no session in backend for id xyz"),
    );

    const res = await request("POST", "/turn", {
      sessionId: "xyz",
      prompt: "hello",
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("session_not_found");
  });

  it("returns 500 on unexpected errors", async () => {
    mockedRunTurn.mockRejectedValueOnce(new Error("LLM timeout"));

    const res = await request("POST", "/turn", { prompt: "hello" });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toBe("LLM timeout");
  });
});

describe("unknown routes", () => {
  it("returns 404", async () => {
    const res = await request("GET", "/unknown");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm -C packages/knative-server test`

Expected: All 7 tests pass. No Redis or LLM calls — fully mocked.

- [ ] **Step 3: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add packages/knative-server/test/server.test.ts
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Test: Add unit tests for knative-server HTTP layer"
```

---

## Task 6: Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
.git
*.log
deploy
docs
```

- [ ] **Step 2: Create the multi-stage Dockerfile**

```dockerfile
# Stage 1: install + build pi-fork
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Copy manifests first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY pi-fork/package.json pi-fork/pnpm-workspace.yaml ./pi-fork/
COPY pi-fork/packages/ai/package.json ./pi-fork/packages/ai/
COPY pi-fork/packages/agent/package.json ./pi-fork/packages/agent/
COPY pi-fork/packages/tui/package.json ./pi-fork/packages/tui/
COPY pi-fork/packages/coding-agent/package.json ./pi-fork/packages/coding-agent/
COPY packages/session-backend/package.json ./packages/session-backend/
COPY packages/k8s-sandbox/package.json ./packages/k8s-sandbox/
COPY packages/knative-server/package.json ./packages/knative-server/
COPY harness/package.json ./harness/

RUN pnpm install --frozen-lockfile

# Copy full source
COPY pi-fork/ ./pi-fork/
COPY packages/ ./packages/
COPY harness/ ./harness/

# Build pi-fork (required order per M1 gotcha)
RUN pnpm -C pi-fork/packages/ai build && \
    pnpm -C pi-fork/packages/agent build && \
    pnpm -C pi-fork/packages/tui build && \
    pnpm -C pi-fork/packages/coding-agent build

# Stage 2: slim runtime
FROM node:20-alpine
RUN apk add --no-cache kubectl
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--import", "tsx", "packages/knative-server/src/server.ts"]
```

- [ ] **Step 3: Verify the image builds**

Run: `docker build -t serverless-harness:local /Users/paolo/Projects/aiplatform/serverless-harness`

Expected: Build completes without errors. (Note: this requires the pi-fork submodule to be checked out.)

- [ ] **Step 4: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add Dockerfile .dockerignore
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Feat: Add multi-stage Dockerfile for Knative deployment"
```

---

## Task 7: Knative manifests

**Files:**
- Create: `deploy/knative/service.yaml`
- Create: `deploy/knative/redis.yaml`
- Create: `deploy/knative/sandbox.yaml`

- [ ] **Step 1: Create `deploy/knative/` directory structure**

Run: `mkdir -p /Users/paolo/Projects/aiplatform/serverless-harness/deploy/knative`

- [ ] **Step 2: Create `deploy/knative/redis.yaml`**

```yaml
# deploy/knative/redis.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "128Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: default
spec:
  selector:
    app: redis
  ports:
    - port: 6379
      targetPort: 6379
```

- [ ] **Step 3: Create `deploy/knative/sandbox.yaml`**

```yaml
# deploy/knative/sandbox.yaml
apiVersion: v1
kind: Pod
metadata:
  name: sandbox-0
  namespace: default
  labels:
    app: sandbox
spec:
  containers:
    - name: sandbox
      image: alpine:3.20
      command: ["sleep", "infinity"]
      resources:
        requests:
          memory: "64Mi"
          cpu: "50m"
        limits:
          memory: "256Mi"
```

Note: This is a minimal sandbox for the smoke test. The real sandbox image (with ripgrep) from `packages/k8s-sandbox/deploy/sandbox.yaml` can be used instead for full tool testing.

- [ ] **Step 4: Create `deploy/knative/service.yaml`**

```yaml
# deploy/knative/service.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: serverless-harness
  namespace: default
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: "0"
        autoscaling.knative.dev/max-scale: "5"
        autoscaling.knative.dev/scale-to-zero-pod-retention-period: "30s"
    spec:
      containerConcurrency: 1
      timeoutSeconds: 300
      serviceAccountName: serverless-harness
      containers:
        - image: serverless-harness:local
          ports:
            - containerPort: 8080
          env:
            - name: REDIS_URL
              value: "redis://redis.default.svc:6379"
            - name: KAGENTI_SANDBOX_POD
              value: "sandbox-0"
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llm-credentials
                  key: api-key
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 2
            periodSeconds: 5
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
---
# ServiceAccount + RBAC for kubectl exec into sandbox pod
apiVersion: v1
kind: ServiceAccount
metadata:
  name: serverless-harness
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: serverless-harness-sandbox
  namespace: default
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: serverless-harness-sandbox
  namespace: default
subjects:
  - kind: ServiceAccount
    name: serverless-harness
    namespace: default
roleRef:
  kind: Role
  name: serverless-harness-sandbox
  apiGroup: rbac.authorization.k8s.io
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add deploy/knative/
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Feat: Add Knative Service + Redis + sandbox manifests"
```

---

## Task 8: Kind + Knative setup script

**Files:**
- Create: `deploy/knative/setup-kind.sh`

- [ ] **Step 1: Write the setup script**

```bash
#!/usr/bin/env bash
# deploy/knative/setup-kind.sh
# One-shot setup: installs Knative Serving on Kind, deploys Redis + sandbox + harness.
#
# Prerequisites:
#   - kind cluster running (e.g., `kind create cluster --name sh-knative`)
#   - kubectl configured to the kind cluster
#   - docker available (for image build + kind load)
#   - ANTHROPIC_API_KEY env var set
#
# Usage:
#   ./deploy/knative/setup-kind.sh [--skip-build] [--cluster-name <name>]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-sh-knative}"
SKIP_BUILD="${SKIP_BUILD:-false}"
KNATIVE_VERSION="v1.14.1"

# Parse args
for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --cluster-name) shift; CLUSTER_NAME="$1" ;;
    --cluster-name=*) CLUSTER_NAME="${arg#*=}" ;;
  esac
  shift 2>/dev/null || true
done

echo "=== M4 Knative Setup (cluster: $CLUSTER_NAME) ==="

# 1. Create kind cluster if it doesn't exist
if ! kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  echo "--- Creating kind cluster: $CLUSTER_NAME ---"
  kind create cluster --name "$CLUSTER_NAME"
fi
kubectl config use-context "kind-${CLUSTER_NAME}"

# 2. Install Knative Serving
echo "--- Installing Knative Serving $KNATIVE_VERSION ---"
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-crds.yaml"
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-core.yaml"

# 3. Install Kourier (networking layer)
echo "--- Installing Kourier ---"
kubectl apply -f "https://github.com/knative/net-kourier/releases/download/knative-${KNATIVE_VERSION}/kourier.yaml"

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Wait for Knative components
echo "--- Waiting for Knative Serving to be ready ---"
kubectl wait --for=condition=Available deployment --all -n knative-serving --timeout=120s

# 4. Deploy Redis
echo "--- Deploying Redis ---"
kubectl apply -f "$SCRIPT_DIR/redis.yaml"
kubectl wait --for=condition=Available deployment/redis -n default --timeout=60s

# 5. Deploy sandbox pod
echo "--- Deploying sandbox pod ---"
kubectl apply -f "$SCRIPT_DIR/sandbox.yaml"
kubectl wait --for=condition=Ready pod/sandbox-0 -n default --timeout=60s

# 6. Build and load harness image
if [ "$SKIP_BUILD" != "true" ]; then
  echo "--- Building serverless-harness image ---"
  docker build -t serverless-harness:local "$REPO_ROOT"
  echo "--- Loading image into kind ---"
  kind load docker-image serverless-harness:local --name "$CLUSTER_NAME"
fi

# 7. Create LLM credentials secret
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY must be set"
  exit 1
fi
kubectl create secret generic llm-credentials \
  --from-literal=api-key="$ANTHROPIC_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# 8. Deploy Knative Service
echo "--- Deploying serverless-harness Knative Service ---"
kubectl apply -f "$SCRIPT_DIR/service.yaml"

# 9. Wait for service to become ready
echo "--- Waiting for Knative Service to be ready ---"
kubectl wait ksvc/serverless-harness --for=condition=Ready --timeout=120s

# 10. Print access info
KOURIER_IP=$(kubectl get svc kourier -n kourier-system -o jsonpath='{.spec.clusterIP}' 2>/dev/null || echo "pending")
echo ""
echo "=== Setup complete ==="
echo ""
echo "Knative Service URL (in-cluster):"
echo "  http://serverless-harness.default.svc.cluster.local"
echo ""
echo "Kourier ClusterIP: $KOURIER_IP"
echo ""
echo "To access from host, run in a separate terminal:"
echo "  kubectl port-forward -n kourier-system svc/kourier 8080:80"
echo ""
echo "Then send requests with the Host header:"
echo "  curl -H 'Host: serverless-harness.default.example.com' \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"prompt\": \"Hello\"}' \\"
echo "       http://localhost:8080/turn"
echo ""
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x /Users/paolo/Projects/aiplatform/serverless-harness/deploy/knative/setup-kind.sh`

- [ ] **Step 3: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add deploy/knative/setup-kind.sh
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Feat: Add Kind + Knative setup script"
```

---

## Task 9: Live smoke test script

**Files:**
- Create: `deploy/knative/smoke.sh`

- [ ] **Step 1: Write the smoke test**

```bash
#!/usr/bin/env bash
# deploy/knative/smoke.sh
# Live smoke: proves scale 0→1→0 and session recall across cold starts.
#
# Prerequisites: setup-kind.sh completed, port-forward running:
#   kubectl port-forward -n kourier-system svc/kourier 8080:80
#
# Usage:
#   ./deploy/knative/smoke.sh [--port 8080]

set -euo pipefail

PORT="${PORT:-8080}"
HOST_HEADER="Host: serverless-harness.default.example.com"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0

for arg in "$@"; do
  case $arg in
    --port) shift; PORT="$1" ;;
    --port=*) PORT="${arg#*=}" ;;
  esac
  shift 2>/dev/null || true
done

claim() {
  echo ""
  echo "--- Claim $1: $2 ---"
}

pass() {
  echo "  PASS"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

# Helper: wait for scale-to-zero
wait_for_zero_pods() {
  echo "  Waiting for scale-to-zero (up to 90s)..."
  for i in $(seq 1 18); do
    COUNT=$(kubectl get pods -l serving.knative.dev/service=serverless-harness \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [ "$COUNT" = "0" ]; then
      echo "  Scaled to zero after ~$((i * 5))s"
      return 0
    fi
    sleep 5
  done
  echo "  WARNING: did not scale to zero within 90s"
  return 1
}

# ============================================================
claim 1 "Health endpoint responds"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" -H "$HOST_HEADER" "$BASE/health")
if [ "$HEALTH" = "200" ]; then pass; else fail "got HTTP $HEALTH"; fi

# ============================================================
claim 2 "POST /turn creates a new session"
RESP=$(curl -s -H "$HOST_HEADER" -H "Content-Type: application/json" \
  -d '{"prompt":"Remember the number 7777. Reply only with OK."}' \
  "$BASE/turn")

SESSION_ID=$(echo "$RESP" | jq -r '.sessionId // empty')
RESPONSE=$(echo "$RESP" | jq -r '.response // empty')

if [ -n "$SESSION_ID" ] && echo "$RESPONSE" | grep -qi "ok"; then
  pass
  echo "  sessionId=$SESSION_ID"
else
  fail "sessionId=$SESSION_ID response=$RESPONSE"
fi

# ============================================================
claim 3 "Pod scales to zero after idle"
wait_for_zero_pods && pass || fail "pods did not scale to zero"

# ============================================================
claim 4 "Cold-start resume recalls session state from Redis"
RESP2=$(curl -s -H "$HOST_HEADER" -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"prompt\":\"What number did I ask you to remember? Reply with just the number.\"}" \
  "$BASE/turn")

RESPONSE2=$(echo "$RESP2" | jq -r '.response // empty')
SID2=$(echo "$RESP2" | jq -r '.sessionId // empty')

if [ "$SID2" = "$SESSION_ID" ] && echo "$RESPONSE2" | grep -q "7777"; then
  pass
else
  fail "sessionId=$SID2 (expected $SESSION_ID) response=$RESPONSE2"
fi

# ============================================================
claim 5 "Pod scaled up from zero for claim 4"
COUNT=$(kubectl get pods -l serving.knative.dev/service=serverless-harness \
  --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -ge "1" ]; then
  pass
else
  fail "expected >=1 running pod, got $COUNT"
fi

# ============================================================
claim 6 "404 on unknown session"
RESP3=$(curl -s -w "\n%{http_code}" -H "$HOST_HEADER" -H "Content-Type: application/json" \
  -d '{"sessionId":"does-not-exist-xyz","prompt":"hello"}' \
  "$BASE/turn")
HTTP_CODE=$(echo "$RESP3" | tail -1)
if [ "$HTTP_CODE" = "404" ]; then pass; else fail "got HTTP $HTTP_CODE"; fi

# ============================================================
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then exit 1; fi
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x /Users/paolo/Projects/aiplatform/serverless-harness/deploy/knative/smoke.sh`

- [ ] **Step 3: Commit**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add deploy/knative/smoke.sh
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Test: Add live smoke script for Knative scale-to-zero verification"
```

---

## Task 10: Run setup + smoke on Kind

**Files:** None (execution-only task)

**Prerequisites:** Tasks 1–9 complete and committed. Docker running. `ANTHROPIC_API_KEY` set.

- [ ] **Step 1: Run the setup script**

Run: `cd /Users/paolo/Projects/aiplatform/serverless-harness && ./deploy/knative/setup-kind.sh`

Expected: Completes with "Setup complete" and prints access instructions. All components (Knative, Redis, sandbox, harness service) are Ready.

- [ ] **Step 2: Start port-forward in background**

Run: `kubectl port-forward -n kourier-system svc/kourier 8080:80 &`

Expected: Port-forward starts, no errors.

- [ ] **Step 3: Run the smoke test**

Run: `./deploy/knative/smoke.sh`

Expected: All 6 claims pass. Output shows the full 0→1→0→1 lifecycle.

- [ ] **Step 4: Record results**

Create `deploy/knative/SMOKE.md` documenting:
- Date, cluster name, Knative version
- Cold-start latency (time from curl send to first response byte for claim 4)
- All claims PASS/FAIL
- Any issues encountered

- [ ] **Step 5: Commit the smoke record**

```bash
git -C /Users/paolo/Projects/aiplatform/serverless-harness add deploy/knative/SMOKE.md
git -C /Users/paolo/Projects/aiplatform/serverless-harness commit -s -m "Docs: Record M4 Knative smoke test results"
```

---

## Verification checklist (post-completion)

- [ ] All existing tests pass: `pnpm -C harness test` and `pnpm -C packages/k8s-sandbox test`
- [ ] New unit tests pass: `pnpm -C packages/knative-server test`
- [ ] Integration test passes: `pnpm -C harness exec vitest run test/run-turn.test.ts`
- [ ] TypeScript compiles: `pnpm -C packages/knative-server exec tsc --noEmit`
- [ ] Live smoke passes all 6 claims
- [ ] Pod scales 0→1→0 (observed in smoke claim 3 + 5)
- [ ] `cli.ts` still works headless: `pnpm -C harness exec tsx src/cli.ts "hello"` prints a response

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
