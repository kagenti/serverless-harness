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
