# SandboxTransport: language-neutral remote exec over gRPC

**Date:** 2026-07-08
**Status:** Design — approved for planning
**Scope:** The interface between the harness and the sandbox(es), enabling sandboxes to
run outside the harness's cluster (self-hosted / laptop / on-prem / other cloud /
bring-your-own), while keeping the in-cluster `kubectl-exec` path unchanged.
**Supersedes:** the Redis-Streams transport previously proposed in this PR
(`2026-07-07-sandbox-transport-remote-exec-design.md`). See §12 for why.

## 1. Problem & goal

Today the harness executes every Pi tool call (read / write / bash / grep) inside a
sandbox pod via `kubectl exec` (`packages/k8s-sandbox/src/exec.ts`,
`ExecInPod = (command, opts) => Promise<{ stdout, exitCode }>`). The **harness initiates
the connection into the pod through the kube API**. This only works when the harness can
reach the sandbox's API server, which rules out sandboxes behind NAT, on-prem, on a
laptop, or in another cloud.

**Goal:** let a sandbox live anywhere by inverting connectivity — the sandbox dials *out*
to a broker the harness also talks to — with a protocol that is **language-neutral**
(any runtime can host a worker) and **firewall-friendly** (a single outbound TLS
connection on `:443`), without changing the Pi orchestration loop, the session backend,
or the leaf queue.

### Drivers (priority order)

1. **Bring-your-own (untrusted 3rd-party) sandbox** — external parties host their own
   sandbox and register it. *Top priority.*
2. **Decoupling / heterogeneity** — a clean, language-independent harness↔sandbox
   contract so a sandbox can be any runtime (VM, Firecracker, remote Docker) in any
   language.
3. **Bursting to external compute** — latency-tolerant overflow onto owned capacity.
4. **Reachability** — sandboxes the harness cannot dial into.

## 2. Key decisions (settled during brainstorming)

- **Brain stays central.** The Pi loop + LLM calls remain in the harness; only command
  execution is delegated. This is the *trust-correct* choice for driver #1: the LLM key
  and control loop never leave the harness; an untrusted sandbox only ever receives
  commands and returns bytes.
- **The contract is a Protobuf IDL, not a TypeScript interface.** Any language with gRPC
  codegen (Go, Python, Rust, Java, TS, …) can implement a worker. The `.proto` is the
  source of truth; TypeScript is just one generated client. This is what makes driver #2
  real.
- **gRPC-native over HTTP/2 on `:443`.** One outbound TLS connection carrying a
  full-duplex bidirectional stream. HTTP/2-on-443 traverses most modern egress and NAT.
  *(Connect / HTTP-1.1 fallback was considered and rejected — see §5 — because our
  streaming core is full-duplex, which requires HTTP/2 regardless.)*
- **A single-replica relay, presence-only.** A new in-cluster process bridges the
  worker's outbound stream to the harness's in-cluster calls. It does **not** own
  matching or leasing — it mirrors connected workers into the **existing sandbox pool**,
  and the existing `select-sandbox` logic does the matching unchanged.
- **One reference worker, in Go.** A single static binary with no runtime dependencies,
  droppable into any sandbox image — and the honest proof that the contract is genuinely
  language-neutral rather than secretly TS-shaped.
- **Per-sandbox bearer token at the edge.** The worker authenticates on connect;
  SPIFFE/mTLS for untrusted BYO upgrades into the *same* seam later.
- **Latency posture: mixed.** `kubectl-exec` stays as the fast in-cluster implementation;
  the remote path is added behind the same interface and degrades gracefully.

## 3. Architecture

```
Sandbox (laptop / on-prem / other cloud / same cluster)
   worker (Go static binary) — implements SandboxWorker.Attach client
      │  outbound only, TLS :443, HTTP/2
      │  ServerFrame{Exec|Abort} ↓   WorkerFrame{Hello|Heartbeat|Chunk|End|Error} ↑
      ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Kubernetes                                                             │
│   relay (Deployment, 1 replica)                                        │
│     SandboxWorker.Attach     ← workers dial in (bidi stream)           │
│     SandboxExec.Exec/Abort   ← harness calls (in-cluster)              │
│     in-memory session table: sandbox_id → live Attach stream           │
│     mirrors presence → existing Redis sandbox pool                     │
│        │ in-cluster gRPC                    │ presence write/remove     │
│        ▼                                    ▼                           │
│   Harness (central brain, Pi loop + LLM)   Redis sandbox pool          │
│     SandboxTransport.exec(...)  ← the ONE seam                         │
│       ├─ [local]  KubectlTransport   (existing kubectlExecInPod)       │
│       └─ [remote] GrpcRelayTransport (new; calls SandboxExec)          │
│     select-sandbox → leases pod OR remote record → returns a transport │
└──────────────────────────────────────────────────────────────────────┘
```

### Component boundaries

| Unit | Purpose | Depends on |
|------|---------|-----------|
| `SandboxTransport` (interface) | The exec seam Pi sees. No transport knowledge above it. | — |
| `KubectlTransport` | Local/in-cluster fast path. Rename of today's `kubectlExecInPod`. | kubectl |
| `GrpcRelayTransport` | Harness side: turn one `exec()` into a `SandboxExec.Exec` call + stream reassembly + correlation. | relay (in-cluster gRPC) |
| `relay` | Bridge worker's outbound `Attach` stream ↔ harness `Exec`; mirror presence into the pool. | gRPC, Redis pool |
| Go worker (reference) | Sandbox side: dial `Attach`, run commands locally, stream frames, honor abort. | local shell |
| `select-sandbox` (existing) | Now returns a **transport**, not a pod name. Sees pods + remote records; leases least-loaded. | pool/lease logic |

### The harness-facing interface (unchanged from PR #78)

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

This is today's `ExecInPod` capability surface verbatim, plus `close()`. Pi depends on all
of it (streaming via `onData`; abort via `signal`; `timeout`; `stdin` for writes), so the
interface preserves all of it. `GrpcRelayTransport` and `KubectlTransport` are two
implementations of this one interface.

### Architectural invariants

- **Single worker per sandbox; one exec in flight per sandbox.** Preserves
  shell/cwd/env/filesystem ordering and makes req order == execution order. Mirrors
  today's `persistent-exec.ts`.
- **Everything above `select-sandbox` is transport-blind.** `run-leaf`, `run-turn`,
  `converge` receive a `SandboxTransport` and never learn how bytes reach the sandbox.
  `converge` (repo sync) already goes through exec, so it rides the transport for free.
- **The relay is a stateless byte-bridge.** It parses only enough to route by
  `sandbox_id`; the exec is effectively end-to-end between harness and worker.

### What does NOT change

The Pi orchestration loop, `run-turn`, the session backend (`RedisSessionBackend`), the
leaf queue (`@sh/work-queue`), and the sandbox **pool/lease** logic. The change slots
strictly *below* the current `ExecInPod` call sites (`converge.ts`, `run-leaf.ts`,
`run-turn.ts`, `select-sandbox.ts`).

## 4. The Protobuf contract (`sandbox/v1`)

Two services. No registry service and no `Selector` message — matching stays in the
harness pool (§6).

```protobuf
syntax = "proto3";
package sandbox.v1;

// Worker (any language) dials the relay and holds ONE bidi stream.
// worker→relay carries results/liveness; relay→worker carries commands.
service SandboxWorker {
  rpc Attach(stream WorkerFrame) returns (stream ServerFrame);
}

// Harness asks the relay to run a command on a connected sandbox and
// streams the output back. The relay bridges to the worker's Attach
// stream, keyed by sandbox_id. In-cluster only.
service SandboxExec {
  rpc Exec(ExecRequest) returns (stream ExecEvent);   // server-streaming output
  rpc Abort(AbortRequest) returns (AbortResponse);
}

// ---- worker → relay ----
message WorkerFrame {
  oneof msg {
    Hello     hello     = 1;   // sent first: identity + capabilities
    Heartbeat heartbeat = 2;   // liveness; also keeps NAT/proxy state open
    Chunk     chunk     = 3;   // streamed stdout for an exec
    End       end       = 4;   // terminal success for an exec
    ExecError error     = 5;   // exec/channel failure
  }
}

// ---- relay → worker ----
message ServerFrame {
  oneof msg {
    Exec  exec  = 1;           // run one command
    Abort abort = 2;           // cancel an in-flight exec
  }
}

message Hello {
  string sandbox_id            = 1;
  map<string,string> labels    = 2;   // team=alpha, env=prod, region=us-east
  repeated string capabilities = 3;   // ["python3","kubectl","gpu","node20"]
  string image                 = 4;   // sandbox image tag/digest
  string arch                  = 5;   // amd64 | arm64
  uint32 capacity_max          = 6;   // max concurrent execs the worker allows
  string trust                 = 7;   // "trusted" | "untrusted"
}

message Heartbeat {}                   // liveness/keepalive only; harness owns lease counts

message Exec {
  uint64 req_id    = 1;                // monotonic; correlation + dedup key
  string command   = 2;
  bytes  stdin     = 3;                // raw bytes (protobuf is binary — no base64)
  uint32 timeout_s = 4;
  bool   streaming = 5;                // true for bash/grep; false for read/write
}
message Abort     { uint64 req_id = 1; }
message Chunk     { uint64 req_id = 1; bytes data = 2; }        // 0..n, only if streaming
message End       { uint64 req_id = 1; sint32 exit_code = 2; }  // exit_code < 0 = signal/none
message ExecError { uint64 req_id = 1; string message = 2; }

// ---- harness ↔ relay (SandboxExec) ----
message ExecRequest { string sandbox_id = 1; Exec exec = 2; }   // sandbox_id from the lease
message ExecEvent   { oneof event { Chunk chunk = 1; End end = 2; ExecError error = 3; } }
message AbortRequest  { string sandbox_id = 1; uint64 req_id = 2; }
message AbortResponse {}
```

**Notes**

- **Binary, not base64.** `bytes stdin` / `bytes data` ride protobuf's native binary
  encoding — smaller and faster than the JSON+base64 frames of the superseded design.
- **The worker does not self-report `capacity_in_use`.** The harness owns the leases (the
  pool ZSET already tracks how many it has granted each sandbox), so `Hello` carries only
  `capacity_max`, and `Heartbeat` is pure liveness/keepalive.

## 5. Connectivity: one bidi `Attach` stream, worker-dialed

The constraint: the **worker can only dial out**, but the **harness must push commands to
the worker**. A single **bidirectional streaming RPC where the worker is the client**
resolves this — commands flow to the worker on the *server→client* half of the stream the
worker itself opened:

```
Worker (client, dials OUT :443)                     Relay (server, in-cluster)
   │  Attach(stream WorkerFrame) ───────────────────────▶│  worker→relay: results & liveness
   │◀─────────────────────────── returns (stream ServerFrame)  relay→worker: commands
```

The worker opens one long-lived bidi stream and **never listens for inbound
connections**. Commands arrive on the response side of its own outbound call — the
outbound-only property we want, expressed in a standard RPC primitive.

**Why gRPC-native and not Connect.** Connect's headline advantage is a plain-HTTP/1.1
fallback that traverses HTTP-inspecting proxies. But **full-duplex bidi streaming
requires HTTP/2 regardless of framework** — Connect only offers unary + server-streaming
over HTTP/1.1. Since our core *is* a full-duplex stream, Connect buys us little for the
part that matters while adding a second toolchain. We therefore use gRPC-native over
HTTP/2 on `:443`. If a concrete "must traverse HTTP/1.1-only proxy" requirement ever
appears, the fallback is to decompose `Attach` into a server-streaming "receive commands"
call plus unary "post results" calls — a future protocol variant behind the same seam,
explicitly out of scope here.

## 6. The relay (single-replica, presence-only)

A new in-cluster `Deployment`, **one replica**. It is a matchmaker-free byte bridge:

1. **Accepts `Attach`.** On `Hello`, validates the bearer token ↔ `sandbox_id` binding
   (§8), then parks the live stream in an in-memory session table `sandbox_id → stream`.
2. **Mirrors presence into the existing Redis sandbox pool.** It writes a lightweight
   record (`sandbox_id`, labels, capabilities, `capacity_max`, `transport:"grpc"`) into
   the same pool store `select-sandbox` already reads, and **removes it when the stream
   closes**. The live `Attach` stream *is* the registration — no separate heartbeat key,
   no reaper.
3. **Routes `SandboxExec.Exec`.** Looks up the live stream by `sandbox_id`, sends
   `ServerFrame{Exec}`, and forwards the worker's `Chunk`/`End`/`Error` back as the
   `stream ExecEvent` response. `Abort` is routed the same way.

**Why single-replica.** With exactly one replica there is no "which replica holds this
worker's stream" problem, so the relay needs **no presence glue** (no K8s-API watch, no
Redis pub/sub) beyond the pool mirror above. This is the deliberate day-one simplification
(§13).

**Relay restart = in-flight execs fail.** When the single replica restarts, all parked
streams drop; workers reconnect and re-register; any `Exec` in flight fails. This degrades
into existing recovery: the leaf fails and re-leases a healthy sandbox on retry (see the
error table, §10). There is **no mid-exec durability** — stated plainly so nobody expects
it.

### Harness integration: `select-sandbox` barely moves

`select-sandbox` already leases from the pool via Redis. It now:

```
lease from pool (in-cluster pods + mirrored remote records) →
  record.transport == "kubectl" → KubectlTransport(config)      (local, fast — unchanged)
  record.transport == "grpc"    → GrpcRelayTransport(sandbox_id) (routes via the relay)
```

The pool remains the single source of truth for matching; a remote sandbox is just
another pool entry that happens to resolve to a different transport.

## 7. The Go worker (reference implementation)

A thin, single-purpose static binary. It holds **no LLM key and no orchestration** — it
only executes commands and returns bytes (the property that makes "central brain"
trust-correct). It:

1. On start: read `SANDBOX_ID`, `RELAY_ADDR`, `SANDBOX_TOKEN` from env; dial
   `SandboxWorker.Attach` over TLS `:443` with `Authorization: Bearer <token>`.
2. Send `Hello` (id, labels, capabilities, `capacity_max`, `trust`).
3. Loop on `ServerFrame`:
   - `Exec` → run `bash -c <command>` locally (feeding `stdin`), stream stdout back as
     `Chunk`* then `End{exit_code}` when `streaming`; otherwise a single `End` carrying
     full stdout. Enforce `timeout_s` locally (SIGKILL on expiry).
   - `Abort` → SIGKILL the in-flight child for that `req_id`.
4. Send `Heartbeat` periodically (liveness + NAT/proxy keepalive).
5. Maintain a bounded `req_id → End` dedup cache; **re-emit the cached result** instead of
   re-running on a redelivered `req_id` (§9).

Persistent-shell semantics (a single long-lived `bash` preserving cwd/env across execs)
are an implementation choice inside the worker; the wire contract only requires ordered,
one-in-flight execs.

## 8. Wire semantics (correlation, dedup, timeout, output cap, abort)

The frame *semantics* are carried from the superseded design verbatim — only the encoding
(protobuf) and transport (gRPC bidi) changed.

- **Correlation & ordering.** Each `exec()` gets a monotonic `req_id`. One exec in flight
  ⇒ req order == execution order. `req_id` doubles as the idempotency key.
- **Streaming vs one-shot.** Streaming ops (bash/grep) emit `Chunk`* then `End`; the
  harness replays each `Chunk` into `opts.onData`, matching today's `ExecInPod` contract
  byte-for-byte. Non-streaming ops (read/write) emit a single `End` with full stdout.
- **At-least-once → dedup.** A reconnect mid-exec can redeliver a command. The worker's
  bounded `req_id → End` cache re-emits the cached terminal result rather than re-running.
  *Honest limitation:* if the worker died mid-write, exactly-once is impossible — the
  contract is at-least-once + dedup-by-`req_id`, and partial filesystem effects on crash
  are possible (same risk class as a leaf re-run today).
- **Dual-ended timeout.** The worker kills its local child at `timeout_s`; the harness has
  its own deadline and synthesizes a timeout `error` if no `End` arrives — it never hangs
  on a silent or malicious worker.
- **Poisoned-output defense.** The harness enforces a **total-output cap per exec**; on
  exceed it issues `Abort`, truncates, and surfaces an `[output truncated]` marker to Pi.
  This is the concrete mitigation for the driver-#1 threat of a malicious sandbox flooding
  the model's context. `Chunk` size is capped so a single frame stays small (backpressure).
- **Abort/end races.** A late `End` for an aborted `req_id` is dropped; an `Abort` for an
  already-ended `req_id` is a no-op.

## 9. Security & reachability

**Mode A — public relay on `:443` (the only mode day-one).** The worker dials
`https://relay.<domain>` with TLS and `Authorization: Bearer <per-sandbox token>`. The
relay validates the token ↔ `sandbox_id` binding on `Attach` before parking the stream.
The worker-facing `Attach` endpoint is the **single public attack surface**; the
harness-facing `SandboxExec` service is **in-cluster only**, guarded by NetworkPolicy.

| Property | Value |
|----------|-------|
| Inbound rules on sandbox | none (outbound only) |
| Egress required | `:443` only |
| Encryption | TLS 1.3 |
| Worker identity (day-one) | per-sandbox bearer token, scoped to `sandbox_id` |
| Public attack surface | relay `Attach` on `:443` |

**Upgrade path for untrusted BYO.** SPIFFE/SPIRE **mTLS** with per-connection identity
slots into the *same* `Attach` endpoint — same protocol, stronger credential on the TLS
handshake, no wire change. Deferred (§13); the bearer token is the seam it replaces.

**Reachability is pluggable beneath the RPC.** A private-mesh mode (self-hosted
**Headscale** / plain **WireGuard**) for fleets that refuse any public relay endpoint can
be added later without a protocol change. No paid external dependency is introduced;
Tailscale is explicitly out of scope.

## 10. Error handling & lifecycle

| Failure | Detection | Behavior |
|---------|-----------|----------|
| Worker disconnects (crash / network) | `Attach` stream closes | Presence record removed from pool; worker reconnects and re-registers. In-flight `Exec` fails; leaf retry re-leases a healthy sandbox. |
| Command redelivered after reconnect | duplicate `req_id` at worker | Dedup cache re-emits cached `End`; else re-run (at-least-once). Partial-write risk documented (§8). |
| Relay restart | all parked streams drop | Workers reconnect; in-flight execs fail → leaf retry. No mid-exec durability. |
| Worker never connects / gone | no live stream for `sandbox_id`; harness deadline | Pool entry absent or evicted; `Exec` rejects; leaf retry re-leases elsewhere. |
| In-flight exec exceeds timeout | dual deadline (§8) | Worker SIGKILLs local child; harness synthesizes timeout — never hangs on a silent worker. |
| Output cap exceeded (poisoned/runaway) | harness byte counter on `ExecEvent` | Harness `Abort`s, truncates, surfaces `[output truncated]` to Pi. |
| Abort races with `End` | `req_id` correlation | Late `End` for an aborted `req_id` dropped; `Abort` for an ended `req_id` is a no-op. |
| Bad / missing token | relay validates on `Attach` | Stream rejected before it is parked; no pool entry created. |

**Lifecycle.** The `GrpcRelayTransport` is created at lease time; `close()` on leaf
completion stops reading the `ExecEvent` stream. The worker's lifetime is independent — it
outlives individual leases and serves whatever the pool assigns, matching the existing
shared-pool model.

## 11. Testing

| Layer | What | How |
|-------|------|-----|
| Pure unit | Frame reassembly, dedup cache, output-cap counter, timeout math, transport selection | Plain vitest / Go test, no I/O. |
| Contract | `GrpcRelayTransport` + Go worker against a real relay, worker pointed at a local bash | Round-trip every op (read/write/bash/grep), abort mid-stream, timeout, reconnect→dedup, output-cap. Core suite. |
| Conformance | The *same* battery run against **both** `KubectlTransport` and `GrpcRelayTransport` | One shared spec proving identical `SandboxTransport` contract — this is what makes them safely swappable (driver #2). |
| Live gate | Real Go worker pod dialing the in-cluster relay over `:443`; one leaf end-to-end on Kind, then OCP | Follows the existing leaf-smoke pattern; manifest-shape vitest parses the relay + worker Deployment YAML directly (no kustomize in CI). |

## 12. Why this supersedes the Redis-Streams design

The previous revision of this PR inverted connectivity correctly but tied down two things
that limited reach and portability:

1. **Language lock-in.** The contract was a TypeScript `SandboxTransport` interface with
   JSON+base64 frames; a worker had to be TS (or hand-reimplement the frames). Driver #2
   (heterogeneity / BYO in any language) could not be met.
2. **Redis as the wire.** Redis Streams carried the RPC. Redis on its port is commonly
   blocked by egress firewalls that allow only `:443`, and it forced a Redis availability
   dependency into the exec path.

This design keeps the outbound-dial insight and the frame *semantics* (`req_id`, dedup,
dual timeout, output cap — §8) **verbatim**, and changes only the encoding and transport:
protobuf over one gRPC bidi stream on `:443`. What survives unchanged from the earlier
work is the `SandboxTransport` interface and the `KubectlTransport` rename (a pure,
behavior-preserving refactor). What is **dropped** is the Redis-specific machinery — the
`RedisChannelTransport` and the TS `@sh/sandbox-worker` are **not built**; Redis returns
to being only the pool/session/leaf-queue substrate, never the exec wire.

## 13. Rollout & scope

**Flagged, off by default, sequenced by trust:**

1. `SandboxTransport` interface + `KubectlTransport` rename. **Pure refactor, zero
   behavior change** — ships first, provably inert (conformance suite green, existing e2e
   green).
2. `sandbox/v1` proto + relay (single replica) + `GrpcRelayTransport` + Go worker +
   presence mirror, behind a flag (`SH_REMOTE_SANDBOX`, off by default). No effect until a
   worker connects.
3. Enable on Kind/OCP for **trusted-unreachable** workers (per-sandbox bearer token +
   `:443` relay endpoint).
4. **Deferred (explicit non-goals for this spec):**
   - Untrusted-BYO isolation → SPIFFE/SPIRE **mTLS** per-connection identity on the same
     `Attach` endpoint.
   - **Multi-replica relay / HA** → adds a presence map (K8s API or Redis pub/sub) to
     route across replicas; unnecessary until relay load or availability demands it.
   - **Private-mesh reachability** (Headscale / WireGuard) for fleets that refuse a public
     endpoint.
   - **Additional-language workers** (e.g. Python for ML/data sandboxes) — the proto
     already permits them; only the Go reference worker ships now.
   - **HTTP/1.1-only proxy traversal** → the Connect / split-stream variant of §5.

**Scope boundaries (YAGNI):** no multi-replica relay, no presence glue beyond the pool
mirror, no Tailscale, no registry/matching service, no `Selector`, no changes to the Pi
loop or leaf queue. This spec is exactly: the interface + the `GrpcRelayTransport` + the
single-replica relay + the Go worker + the presence mirror.

## 14. References

- Superseded PR revision — `2026-07-07-sandbox-transport-remote-exec-design.md` (Redis
  Streams; removed in this update).
- Shared sandbox pool — `2026-07-02-p2-shared-sandbox-pool-design.md`
- Identity spine (SPIFFE/SPIRE + AuthBridge) — `2026-06-26-identity-spine-design.md`
- Protobuf / gRPC — https://protobuf.dev , https://grpc.io
- SPIFFE / SPIRE — https://spiffe.io

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
