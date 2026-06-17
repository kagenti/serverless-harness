# Serverless Harness (Pi track)

## Packages
- `packages/session-backend` — generic append-only `LogStore` + Redis Streams impl.
- `harness` — Pi `SessionStorageBackend` adapter (write-behind) + headless smoke.
- `pi-fork` — pinned Pi (base commit `406a2214`, branch `feat/session-storage-backend`) with the injectable `SessionStorageBackend` seam.

## Milestones

- **M1 — Redis SessionStorageBackend** (`packages/session-backend`, `harness`): append-only
  `LogStore` backed by Redis Streams; write-behind adapter wired into Pi's `SessionStorageBackend`
  seam. Design: `docs/specs/2026-06-16-m1-redis-session-backend-design.md`.
- **M2 — K8sSandboxClient** (`packages/k8s-sandbox`): routes Pi tool execution to
  a remote Kubernetes pod via `kubectl exec`. Env-gated (`KAGENTI_SANDBOX_POD`);
  off by default. Design: `docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md`.
