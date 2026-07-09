# ADR-0024: Remote sandbox exec over a worker-dialed gRPC stream, contract as language-neutral Protobuf

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** Serverless Harness team
- **Spec:** [`../specs/2026-07-08-sandbox-transport-grpc-design.md`](../specs/2026-07-08-sandbox-transport-grpc-design.md)

## Context

The harness runs every Pi tool call inside a sandbox pod via `kubectl exec`, so it must dial *into* the pod through the kube API. That rules out any sandbox behind NAT, on-prem, on a laptop, or in another cloud — and blocks the top driver, bring-your-own (untrusted third-party) sandboxes. Reaching those requires inverting connectivity (the sandbox dials *out*) with a contract that is language-neutral (any runtime can host a worker) and firewall-friendly (one outbound TLS connection on `:443`), without touching the Pi loop, the session backend, or the leaf queue. An earlier revision of this PR got the outbound-dial direction right but carried the RPC over Redis Streams behind a TypeScript interface — locking workers to TS via JSON+base64 frames and forcing Redis (a port `:443`-only egress commonly blocks) into the exec path.

## Decision

We will delegate remote command execution over a single **worker-dialed gRPC bidirectional `Attach` stream (HTTP/2 on `:443`)**, define the contract as a **Protobuf IDL (`sandbox/v1`)** rather than a language-specific interface, and land both paths behind the existing **`SandboxTransport`** seam — `KubectlTransport` (today's in-cluster fast path, renamed) and a new `GrpcRelayTransport` are two implementations of one interface. A **single-replica, presence-only** in-cluster relay bridges the worker's outbound stream to the harness's in-cluster `SandboxExec` calls and mirrors connected workers into the existing Redis sandbox pool; matching stays in `select-sandbox`. One **Go reference worker** ships as the honest proof the contract is genuinely language-neutral.

### Alternatives considered

- **Redis-Streams transport + TS `@sh/sandbox-worker`** (this PR's prior revision) — rejected: TS lock-in through JSON+base64 frames, and Redis-on-its-port is blocked by `:443`-only egress while forcing a Redis dependency into exec.
- **Connect / HTTP-1.1 fallback** — rejected: full-duplex bidi needs HTTP/2 regardless, so Connect adds a second toolchain for no gain on the streaming core.
- **Relay owning matching / multi-replica HA** — deferred: a single replica needs no presence glue beyond the pool mirror, and matching stays in the existing pool.

## Consequences

- Positive: a sandbox can live anywhere behind one outbound `:443` connection with no inbound rules; any gRPC-capable language can host a worker; the in-cluster `kubectl-exec` path is unchanged; everything above `select-sandbox` stays transport-blind; the frame semantics (`req_id` correlation, at-least-once + dedup, dual-ended timeout, per-exec output cap) carry over verbatim.
- Negative / accepted cost: a new in-cluster relay component plus a Protobuf/gRPC toolchain; single-replica relay means a restart drops all parked streams and fails in-flight execs (recovery is leaf retry — no mid-exec durability); exactly-once is impossible — at-least-once + dedup only, with partial-write risk on crash.
- Follow-up owed: untrusted-BYO SPIFFE/mTLS on the same `Attach` endpoint; multi-replica relay HA; private-mesh reachability (Headscale / WireGuard); additional-language workers; HTTP/1.1-only proxy traversal — all additive behind the same seam.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
