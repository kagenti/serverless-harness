# SandboxTransport: pluggable exec seam + Redis remote sandbox

**Date:** 2026-07-07
**Status:** Design — approved for planning
**Scope:** The interface between the harness and the sandbox(es), enabling sandboxes to run outside the harness's cluster (self-hosted / reachable-only-outbound), while keeping the in-cluster path unchanged.

## 1. Problem & goal

Today the harness executes every Pi tool call (read / write / bash / grep) inside a
sandbox pod via `kubectl exec` (`packages/k8s-sandbox/src/exec.ts`,
`ExecInPod = (command, opts) => Promise<{ stdout, exitCode }>`). The **harness
initiates the connection into the pod through the kube API**. This only works when
the harness can reach the sandbox's API server, which rules out sandboxes behind
NAT, on-prem, on a laptop, or in another cloud.

**Goal:** let a sandbox live anywhere by inverting connectivity — the sandbox dials
*out* to a broker the harness also talks to — without changing the Pi orchestration
loop, the session backend, or the leaf queue.

### Drivers (priority order)

1. **Bring-your-own (untrusted 3rd-party) sandbox** — external parties host their own
   sandbox and register it. *Top priority.*
2. **Decoupling / heterogeneity** — a clean harness↔sandbox contract so sandboxes can
   be non-k8s runtimes (VM, Firecracker, remote Docker).
3. **Bursting to external compute** — latency-tolerant overflow onto owned capacity.
4. **Reachability** — sandboxes the harness cannot dial into.

### Key decisions (settled during brainstorming)

- **Brain stays central.** The Pi loop + LLM calls remain in the harness; only command
  execution is delegated. This is the *trust-correct* choice for driver #1: the LLM key
  and control loop never leave the harness; an untrusted sandbox only ever receives
  commands and returns bytes.
- **Mirror threat acknowledged.** A malicious sandbox can return poisoned/oversized
  stdout into the model's context, and anything the brain sends (a token written to a
  file, injected env) is exposed to the sandbox. The return path and what-crosses are
  security surfaces, addressed below (output cap; trust-sequenced rollout).
- **Latency posture: mixed.** Transport must degrade gracefully — keep `kubectl-exec`
  as the fast in-cluster implementation, add a remote implementation behind one
  interface.
- **The queue/worker-with-Redis pattern already exists in-repo** (`@sh/work-queue`,
  Redis Streams consumer group with `claim`/`ack`/`touch`/`xAutoClaim`/dead-letter) but
  at the **leaf** level (whole independent runs, load-balanced). The exec seam is
  **stateful and ordered** (persistent shell cwd/env, filesystem), so it needs a
  **per-sandbox, single-worker request/response channel**, not the shared consumer
  group. Same Redis primitives, different topology.

## 2. Architecture

```
harness (central brain, Pi loop + LLM)
  │
  │ SandboxTransport.exec(cmd, {stdin,onData,signal,timeout})   ← the ONE seam
  │
  ├─ [local]  KubectlTransport      (existing kubectlExecInPod, unchanged)
  └─ [remote] RedisChannelTransport (new, harness side of the RPC)
                    │
                    │  sbx:<id>:req  (harness → worker)   Redis Streams
                    │  sbx:<id>:res  (worker → harness)
                    ▼
        @sh/sandbox-worker  (new; runs INSIDE the sandbox, dials OUT to Redis)
                    │
                    └─ executes bash -c <cmd> locally, streams frames back
```

### Component boundaries

| Unit | Purpose | Depends on |
|------|---------|-----------|
| `SandboxTransport` (interface) | The exec seam Pi sees. No transport knowledge above it. | — |
| `KubectlTransport` | Local/in-cluster fast path. Rename of today's `kubectlExecInPod`. | kubectl |
| `RedisChannelTransport` | Harness side: turn one `exec()` into req/res frames + correlation. | `@sh/work-queue` primitives, redis |
| `@sh/sandbox-worker` | Sandbox side: claim req frames, run locally, stream res frames, honor abort. | redis, local shell |
| `select-sandbox` (existing) | Now returns a **transport**, not a pod name. Chooses local vs redis per lease. | pool/lease logic |

### The interface (fixed core)

```ts
interface SandboxTransport {
  exec(command: string, opts?: {
    stdin?: Buffer;
    onData?: (chunk: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number; // seconds
  }): Promise<{ stdout: Buffer; exitCode: number | null }>;
  close(): Promise<void>;
}
```

This is today's `ExecInPod` capability surface, verbatim, plus `close()`. Pi depends on
all of it (streaming via `onData`; abort via `signal`; `timeout`; `stdin` for writes),
so the interface must preserve all of it.

### Architectural invariants

- **Single worker per sandbox.** The `sbx:<id>:req|res` streams are per-sandbox and
  owned by exactly one worker. This preserves shell/cwd/env/filesystem ordering, which
  the load-balanced leaf queue explicitly does not guarantee. `xAutoClaim` reclaim is
  used **only for crash recovery of that one worker**, never to load-balance across
  workers.
- **One exec in flight per sandbox.** Mirrors `persistent-exec.ts` today; bounds memory
  and makes req order == execution order.
- **Everything above `select-sandbox` is transport-blind.** `run-leaf`, `run-turn`,
  `converge` receive a `SandboxTransport` and never learn how bytes reach the sandbox.
  `converge` (repo sync) already goes through exec, so it rides the transport for free.

### What does NOT change

The Pi orchestration loop, `run-turn`, the session backend (`RedisSessionBackend`), and
the leaf queue (`@sh/work-queue`). The change slots strictly *below* the current
`ExecInPod` call sites (`converge.ts`, `run-leaf.ts`, `run-turn.ts`, `select-sandbox.ts`).

## 3. Wire protocol (`sbx:<id>:req` / `sbx:<id>:res`)

Reuses `packages/k8s-sandbox/src/framing.ts` (`wrapCommand` / `FrameParser`,
`\x01`-marker + base64 body, exit via `${PIPESTATUS[0]}`) inside the worker: the worker
runs the existing persistent bash locally and Redis simply replaces the kubectl
stdin/stdout pipe. The one extension: the persistent channel is one-shot per command
(no `onData` streaming) — for a *remote* sandbox we want live output, so the protocol
adds incremental `chunk` frames.

**Correlation & ordering.** Each `exec()` gets a monotonic `reqId` (like
`persistent-exec`'s `seq`). One exec in flight ⇒ req order == execution order. `reqId`
doubles as the idempotency key.

**Frames** (JSON envelopes; byte payloads base64-encoded):

| Direction | `kind` | Fields | Purpose |
|-----------|--------|--------|---------|
| harness → `req` | `exec` | `reqId, command, stdinB64?, timeout, streaming` | run one command |
| harness → `req` | `abort` | `reqId` | cancel the in-flight exec |
| worker → `res` | `chunk` | `reqId, dataB64` | streamed stdout (0..n; only when `streaming`) |
| worker → `res` | `end` | `reqId, exitCode` | terminal success |
| worker → `res` | `error` | `reqId, message` | channel/exec failure → harness fallback or reject |

- **Non-streaming ops** (read/write) emit a single `end` carrying full stdout — the
  current one-shot frame.
- **Streaming ops** (bash/grep) emit `chunk`* then `end`; the harness replays each
  `chunk` into `opts.onData`, matching today's `ExecInPod` contract byte-for-byte.

**Abort & timeout.** The worker's req-read loop runs independently of the in-flight
child, so an `abort` frame is seen mid-exec → local `SIGKILL` (same effect as today's
`signal` → `child.kill`). Timeout is enforced **on both ends**: the worker kills locally
at `timeout`; the harness has its own deadline and synthesizes a timeout `error` if no
`end` arrives — it never hangs on a silent or malicious worker.

**At-least-once → dedup.** The `req` stream uses a consumer group with **one consumer
(the worker)**; `xAutoClaim` reclaims an unacked req only for worker crash recovery.
Because a redelivered write is not idempotent, the worker keeps a bounded last-N
`reqId → end` cache and **re-emits the cached result instead of re-running**.
*Honest limitation:* if the worker died mid-write, exactly-once is impossible — the
contract is at-least-once + dedup-by-`reqId`, and partial filesystem effects on crash
are possible (same risk class as a leaf re-run today).

**Poisoned-output defense (untrusted return path).** The harness enforces a
**total-output cap per exec**; on exceed it sends `abort`, truncates, and surfaces an
`[output truncated]` marker to Pi. This is the concrete mitigation for the driver-#1
threat of a malicious sandbox flooding the model's context.

## 4. The sandbox worker & transport selection

### `@sh/sandbox-worker` (new; runs inside the sandbox, dials out)

A thin, single-purpose process — a pump between Redis and one local persistent bash.
It holds **no LLM key and no orchestration**; it only executes commands and returns
bytes (the property that made "central brain" trust-correct).

1. On start: read `SANDBOX_ID` + `REDIS_URL` from env; `ensureGroup()` on
   `sbx:<id>:req`; connect; write + heartbeat a registration record.
2. Loop: `claim` next req frame (blocking read + `xAutoClaim` reclaim for
   self-recovery).
3. `exec` frame → feed `wrapCommand(reqId, command, stdin)` into the local persistent
   bash (reuse `framing.ts`); pipe the framed stdout back out as `chunk`/`end` frames on
   `sbx:<id>:res`; `ack` after `end`.
4. `abort` frame → `SIGKILL` the local child.
5. Maintain the bounded `reqId → end` dedup cache; re-emit on redelivery.

### Transport selection (`select-sandbox`, modified)

`select-sandbox` already leases a sandbox from the pool via Redis. It now returns a
`SandboxTransport` instead of a pod name/config:

```
lease sandbox → inspect its registration record →
  kind: "kubectl"  → KubectlTransport(config)        (local, fast — unchanged path)
  kind: "redis"    → RedisChannelTransport(sandboxId) (remote worker)
```

The pool's lease record gains a `transport: "kubectl" | "redis"` field (and, for redis,
the `sandboxId`).

### Registration (v1: trusted-unreachable)

A remote worker, on startup, writes a registration record to Redis
(`sandbox:registry:<id>` with `transport:"redis"`, capacity, labels) and heartbeats it.
The pool's lease logic considers registered remote sandboxes alongside in-cluster pods;
missed heartbeats de-register. **This registry is the seam where Approach B / SPIFFE
authenticated registration later slots in for untrusted BYO — same record, stronger
identity.**

## 5. Error handling & lifecycle

| Failure | Detection | Behavior |
|---------|-----------|----------|
| Remote worker crash mid-exec | req frame unacked; `xAutoClaim` after `minIdleMs` | Redelivered to restarted worker. Dedup cache re-emits if already completed; else re-run (at-least-once). Partial-write risk documented. |
| Worker never starts / gone | missed heartbeat; harness deadline with no `end` | Lease marked unhealthy, sandbox evicted from pool; in-flight `exec` rejects with timeout `error`. Leaf retry re-leases a healthy sandbox. |
| Redis unreachable (harness) | connect/command error | `RedisChannelTransport.exec` rejects; leaf fails and re-queues via existing leaf `WorkQueue`. Redis is a documented availability dependency for remote execs. |
| Redis unreachable (worker) | connect error | Worker exits non-zero; supervisor restarts it; registry heartbeat lapses meanwhile. |
| In-flight exec exceeds timeout | dual deadline (§3) | Worker SIGKILLs local child; harness synthesizes timeout — never hangs on a silent worker. |
| Output cap exceeded (poisoned/runaway) | harness byte counter on `res` | Harness sends `abort`, truncates, surfaces `[output truncated]` to Pi. |
| Abort races with `end` | `reqId` correlation | Late `end` for an aborted `reqId` is dropped; abort for an already-ended `reqId` is a no-op. |
| Stale frames from a prior lease | `reqId`/session scoping | Worker resets stream position on (re)registration; harness ignores frames whose `reqId` predates the current transport instance. |

**Lifecycle.** The transport is created at lease time; `close()` on leaf completion
(dispose local bash / stop reading `res`). The worker's lifetime is independent — it
outlives individual leases and serves whatever the pool assigns, matching the existing
shared-pool model.

**Backpressure.** One exec in flight per sandbox (natural from a single persistent bash)
bounds memory; `chunk` size is capped so a single `res` entry stays small.

## 6. Testing

| Layer | What | How |
|-------|------|-----|
| Pure unit | Frame protocol, dedup cache, output-cap counter, timeout math, transport-selection logic | Plain vitest, no I/O. Extends existing `framing.ts` tests. |
| Contract | `RedisChannelTransport` + `@sh/sandbox-worker` against a real Redis, worker pointed at a local bash | Round-trip every op (read/write/bash/grep), abort mid-stream, timeout, redelivery→dedup, output-cap. Core suite. |
| Conformance | The *same* battery run against **both** `KubectlTransport` and `RedisChannelTransport` | One shared spec proving identical `SandboxTransport` contract — this is what makes them safely swappable (driver #2). |
| Live gate | Real worker pod dialing out to in-cluster Redis; one leaf end-to-end on Kind, then OCP | Follows the existing leaf-smoke pattern; manifest-shape vitest parses the worker Deployment YAML directly (no kustomize in CI). |

## 7. Rollout & scope

**Flagged, off by default, sequenced by trust:**

1. `SandboxTransport` interface + `KubectlTransport` rename. **Pure refactor, zero
   behavior change** — ships first, provably inert (conformance suite green, existing
   e2e green).
2. `@sh/sandbox-worker` + `RedisChannelTransport` + registry, behind
   `SH_REMOTE_SANDBOX=off` by default. No effect until a remote worker registers.
3. Enable on Kind/OCP for **trusted-unreachable** workers (Redis ACL per `sbx:<id>:*`
   prefix + heartbeat registration).
4. **Deferred (explicit non-goal for this spec):** untrusted BYO isolation → Approach B
   (SPIFFE-authenticated registration + per-connection identity via SPIRE/AuthBridge),
   slotting into the same registry seam.

**Scope boundaries (YAGNI):** no multi-worker-per-sandbox, no cross-region Redis, no
reverse-tunnel / gRPC (Approach B), no changes to the Pi loop or leaf queue. This spec
is exactly: the interface + one remote transport + the worker + the registry.

## 8. Deferred: Approach B (for untrusted BYO)

Recorded so the sequencing is explicit, not lost. When untrusted 3rd-party sandboxes
(driver #1) become real, Redis-as-shared-multi-tenant-bus is the weak point (coarse
ACLs; a scoping bug = cross-tenant exec injection). Approach B — the sandbox holds a
persistent outbound gRPC/WebSocket stream to a harness-side relay, with **per-connection
identity via mTLS/SPIFFE** (infra already operated via SPIRE + AuthBridge) — answers the
trust concern directly and gives protocol-native streaming/backpressure/abort. It plugs
into the **same registration seam** defined in §4, behind the **same `SandboxTransport`
interface** from §2, so adopting it is additive, not a rewrite.
