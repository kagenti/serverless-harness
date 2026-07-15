# Connecting a worker

How to connect your own **SandboxTransport worker** to a harness running on
OpenShift. This picks up where [`README-ocp.md`](README-ocp.md) leaves off:
`setup-ocp.sh` already deployed the harness, Redis, and the **relay** — this
guide covers the three steps that make a worker reachable, plus how to verify it.

## Background

A worker executes commands inside a sandbox and returns bytes. It holds **no LLM
key and no orchestration** — the harness keeps the brain (the agent loop + model)
central and delegates only command execution. This is what lets an untrusted,
bring-your-own sandbox run anywhere, in any language.

The worker dials the relay's `SandboxWorker.Attach` and keeps one full-duplex
gRPC stream open: it sends a `Hello`, then loops on server frames (`Exec`,
`Abort`), returning output chunks and a terminal `End`. The wire contract is
`proto/sandbox/v1/sandbox.proto` (message/service definitions in §4, semantics in
§8). The reference worker is a single Go static binary, but any language that
speaks the proto works.

```
 harness ──SandboxExec.Exec──▶ relay ──ServerFrame{exec}──▶ worker ──▶ bash
   ▲                             (park)                        │
   └─────────── stdout/stderr chunks + End ◀───────────────────┘
```

The relay is single-replica and presence-only: it bridges the worker's `Attach`
to the harness's `SandboxExec.Exec`/`Abort`, mirrors connected workers into the
Redis sandbox pool (`sh:sandbox:records`), and removes them on stream close. It
does no matching — leasing stays in the harness pool / `select-sandbox`.

## Prerequisites

- A harness deployed on OpenShift via [`setup-ocp.sh`](setup-ocp.sh) (see
  [`README-ocp.md`](README-ocp.md)). That already runs the relay as a ClusterIP
  Service `sandbox-relay.<ns>.svc:8443` (plaintext h2c) and a Redis the relay
  writes presence into.
- Your worker image, published where the cluster can pull it.

## Step 1 — Set the relay token (required)

The relay auth is **fail-closed**. It ships with no token set, so until you
provide one it rejects *every* Attach before parking the stream. Set a token on
the relay Deployment:

```bash
oc set env deploy/sandbox-relay SH_RELAY_TOKEN=dev-token -n default
```

Use a per-sandbox token instead if you want each worker to authenticate
separately — `SH_RELAY_TOKEN_<SANDBOX_ID>` takes precedence over the global
`SH_RELAY_TOKEN` for that sandbox id:

```bash
oc set env deploy/sandbox-relay SH_RELAY_TOKEN_sbx-dev-1=dev-token -n default
```

## Step 2 — Enable the remote-sandbox path on the harness

The relay is inert until the harness opts in. Point the harness at the relay and
turn the path on:

```bash
oc set env ksvc/serverless-harness \
  SH_REMOTE_SANDBOX=1 \
  SH_RELAY_ADDR=sandbox-relay.default.svc:8443 \
  -n default
```

This rolls a new Knative revision. With `SH_REMOTE_SANDBOX=1` and a worker
present in the pool, `select-sandbox` can lease the remote sandbox and drive a
leaf through `GrpcRelayTransport`.

## Step 3 — Deploy your worker

Copy [`worker-example.yaml`](worker-example.yaml), drop in your image, and apply
it. The worker reads three environment variables:

| Variable | Value | Notes |
|----------|-------|-------|
| `SANDBOX_ID` | e.g. `sbx-dev-1` | Stable id; the pool record and presence key are keyed on it. |
| `RELAY_ADDR` | `sandbox-relay.default.svc:8443` | In-cluster relay Service. Plaintext h2c — no TLS in-cluster. |
| `SANDBOX_TOKEN` | `dev-token` | Sent as `authorization: Bearer <token>`. **Must** match Step 1. |

```bash
# edit worker-example.yaml: set image, SANDBOX_ID, SANDBOX_TOKEN
oc apply -f deploy/knative/worker-example.yaml -n default
```

Run one worker per `SANDBOX_ID` — the relay rejects a second live Attach for the
same id. To run several, give each its own `SANDBOX_ID` (and matching
`SH_RELAY_TOKEN_<id>` on the relay).

## Step 4 — Verify

**Presence** — the live Attach stream *is* the registration. Once the worker
connects, its id appears in the Redis presence hash and disappears when the
stream closes:

```bash
oc exec deploy/redis -n default -- redis-cli HGETALL sh:sandbox:records
# → field "sbx-dev-1" = {"transport":"grpc",...}
```

**Drive an exec** without the full harness, straight through the relay — port-
forward the relay Service and use `grpcurl` (the relay does not register gRPC
reflection, so pass the proto):

```bash
oc port-forward svc/sandbox-relay 8443:8443 -n default &
grpcurl -plaintext -proto proto/sandbox/v1/sandbox.proto \
  -d '{"sandbox_id":"sbx-dev-1","exec":{"req_id":1,"command":"echo hi","timeout_s":10,"streaming":true}}' \
  localhost:8443 sandbox.v1.SandboxExec/Exec
```

**End to end** — with the path enabled (Step 2), send the harness a `/turn` whose
work lands a leaf on the sandbox; the leaf executes through your worker. See the
smoke test in [`README-ocp.md`](README-ocp.md#smoke-test).

## The wire contract your worker must satisfy

From `proto/sandbox/v1/sandbox.proto` (§8) and what the harness-side
`GrpcRelayTransport` ([`packages/k8s-sandbox/src/grpc-relay-transport.ts`](../../packages/k8s-sandbox/src/grpc-relay-transport.ts))
expects:

- **stdout/stderr split** — stdout → `Chunk{stream: STREAM_STDOUT}`; stderr →
  `Chunk{stream: STREAM_STDERR}`. The harness collects stdout into the returned
  buffer and streams stderr to `onData` (excluded from stdout).
- **terminate** each exec with `End{req_id, exit_code}`. `exit_code < 0` means
  signal/none (mapped to `null`). Failures → `ExecError{req_id, message}`.
- **abort** — on `ServerFrame{abort}`, SIGKILL the child and emit a terminal
  frame for that `req_id`.
- **timeout** — kill the child at `exec.timeout_s` (the harness enforces its own
  deadline too — dual-ended).
- **dedup / at-least-once** — cache `req_id → End`; on a redelivered `req_id`
  after a reconnect, re-emit the cached terminal result rather than re-running.
- **stdin** — feed `exec.stdin` bytes to the child's stdin. `Heartbeat` frames
  are liveness-only; the harness owns lease counts.

## Running the worker outside the cluster

The steps above assume the worker runs as a pod in the same cluster, dialing the
relay's ClusterIP over plaintext h2c. To run it on your own infrastructure
instead, expose the relay through an OpenShift **Route on :443** with TLS and
**HTTP/2 enabled on the router** — full-duplex bidi Attach needs HTTP/2
end-to-end — and point `RELAY_ADDR` at the Route host. This is noticeably more
fiddly; start in-cluster and graduate only if you need external reachability.

## Reference

- **Proto (source of truth):** `proto/sandbox/v1/sandbox.proto` — §4 messages/
  services, §8 wire semantics.
- **Go stubs:** `gen/go/sandbox/v1/` (module
  `github.com/kagenti/serverless-harness/gen/go`); a `contract_test.go` lives
  alongside them.
- **Relay behavior to interoperate with:** `packages/sandbox-relay/src/relay.ts`
  (park / presence / routing), `main.ts` (fail-closed token validator).
- **Harness-side expectations:** `packages/k8s-sandbox/src/grpc-relay-transport.ts`
  (reqId correlation, `Chunk.stream` split, dedup, deadline, per-exec output cap).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Worker connects but the Attach is immediately closed | Token unset or mismatched. Set `SH_RELAY_TOKEN` on the relay (Step 1) and give the worker the same value as `SANDBOX_TOKEN`. Auth is fail-closed. |
| No field in `sh:sandbox:records` | The Attach never succeeded (see above), the worker isn't sending `authorization: Bearer <token>` metadata, or it isn't sending `Hello` with `sandbox_id` as the first frame. |
| Presence is there but the harness never uses the worker | `SH_REMOTE_SANDBOX` / `SH_RELAY_ADDR` not set on the harness ksvc (Step 2). Confirm with `oc set env ksvc/serverless-harness --list -n default`. |
| A second worker for the same id won't connect | Expected — one live Attach per `SANDBOX_ID`. Give each worker a distinct id. |
| `exit_code` comes back `null` | The child was signalled (or the worker sent `exit_code < 0`). Not an error by itself. |
