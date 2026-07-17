# remote-worker — minimal HELLO WORLD SandboxTransport worker

A tiny Go worker that connects to the serverless-harness **relay** and, for every
`Exec` it receives, streams back `HELLO WORLD` (plus an echo of the input) as a
continuous stdout stream. It runs no shell and holds no secrets — it exists to
prove the worker↔relay↔harness path end to end, especially **from a laptop
against the harness running in ykt1**.

## How a worker connects (review of README-worker.md + sandbox.proto)

The worker **dials out** to the relay and keeps ONE full-duplex gRPC stream open
(`SandboxWorker.Attach`, `proto/sandbox/v1/sandbox.proto`):

```
 harness ──SandboxExec.Exec──▶ relay ──ServerFrame{Exec}──▶ worker
   ▲                            (parks the worker's Attach stream)   │
   └────────── Chunk(stdout/stderr) … + End(exit_code) ◀────────────┘
```

- **worker → relay** (`WorkerFrame`): `Hello` (sent first), then `Heartbeat`,
  `Chunk`, `End`, `ExecError`.
- **relay → worker** (`ServerFrame`): `Exec` (run one command), `Abort` (cancel).
- **Auth** is fail-closed: the worker sends gRPC metadata
  `authorization: Bearer <SANDBOX_TOKEN>`; it must match the relay's
  `SH_RELAY_TOKEN` (or `SH_RELAY_TOKEN_<SANDBOX_ID>`).
- **Registration = the live stream.** When `Attach` succeeds after a valid
  `Hello`, the relay writes the worker into the Redis presence hash
  (`sh:sandbox:records`) keyed by `sandbox_id`, and removes it on stream close.
- **No matching in the relay.** It only bridges `SandboxExec.Exec/Abort`
  (harness side) ⇄ the parked `Attach` stream (worker side), keyed by
  `sandbox_id`. Leasing/selection stays in the harness pool.

### Wire contract the worker must honor (proto §8)

| Rule | This worker |
|------|-------------|
| `Hello` first, with `sandbox_id` | ✅ sends it before anything else |
| stdout → `Chunk{stream: STREAM_STDOUT}`, stderr → `STREAM_STDERR` | ✅ emits stdout chunks |
| terminate each exec with `End{req_id, exit_code}` | ✅ `End{exit_code: 0}` |
| failures → `ExecError{req_id, message}` | ✅ (not used by the happy path) |
| `Abort` → terminal frame for that `req_id` | ✅ emits `End{exit_code: -1}` (signalled) |
| dedup / at-least-once: cache `req_id → End`, re-emit on redelivery | ✅ in-memory cache |
| `Heartbeat` for liveness | ✅ every 15s |

## The HELLO WORLD behavior (intentionally trivial)

On each `Exec{req_id, command, stdin, …}` the worker:
1. streams stdout chunks `"HELLO "`, `"WORLD\n"` (150ms apart, to show *streaming*),
2. echoes the input to prove input→output: `"you asked: <command>\n"` and, if
   present, `"stdin: <bytes>"`,
3. sends `End{req_id, exit_code: 0}`.

It ignores the actual command — there is no shell. That's the point: a minimal,
safe, any-language-shaped worker.

## Running locally on this laptop, against ykt1  ← the interesting part

The worker **dials the relay**; the relay never dials the worker. So a laptop
worker does **not** need any inbound route — we just need the laptop to reach the
relay. In-cluster that's the ClusterIP `sandbox-relay.default.svc:8443`; from a
laptop we tunnel to it with `oc port-forward`. The harness→relay→worker execs
then ride *back down* the worker-initiated stream through the same tunnel.

```
 laptop:  remote-worker ──dial──▶ localhost:8443 ─┐
                                                   │  oc port-forward (h2c tunnel)
 ykt1:                            sandbox-relay:8443 ◀┘   ◀── harness SandboxExec.Exec
```

Prereqs: harness + relay already deployed in ykt1 `default` (they are — see the
project CLAUDE.md "Serverless Harness" section). Then:

```bash
export KUBECONFIG=.kube/config-ykt1

# 1. Relay token (fail-closed). Global token covers all sandbox ids.
oc set env deploy/sandbox-relay SH_RELAY_TOKEN=dev-token -n default

# 2. Enable the remote-sandbox path on the harness (rolls a new revision).
oc set env ksvc/serverless-harness \
  SH_REMOTE_SANDBOX=1 SH_RELAY_ADDR=sandbox-relay.default.svc:8443 -n default

# 3. Tunnel the relay to the laptop (leave running).
oc port-forward svc/sandbox-relay 8443:8443 -n default &

# 4. Run the worker on the laptop, dialing the tunnel (plaintext h2c).
cd remote-worker
RELAY_ADDR=localhost:8443 SANDBOX_ID=sbx-laptop-1 SANDBOX_TOKEN=dev-token \
  go run .
```

Verify:

```bash
# Presence — the live Attach registered the worker:
oc exec deploy/redis -n default -- redis-cli HGETALL sh:sandbox:records
#   → field "sbx-laptop-1" present

# Drive an exec straight through the relay (separate terminal; reuse the port-forward):
grpcurl -plaintext -proto proto/sandbox/v1/sandbox.proto \
  -d '{"sandbox_id":"sbx-laptop-1","exec":{"req_id":1,"command":"anything","timeout_s":10,"streaming":true}}' \
  localhost:8443 sandbox.v1.SandboxExec/Exec
#   → streams: HELLO / WORLD / you asked: anything, then End{exit_code:0}

# End to end: POST /turn to the harness Route so a leaf leases sbx-laptop-1.
# (NOTE: /turn's LLM step needs LiteLLM egress, currently blocked from ykt1 —
#  the worker path itself is exercised by the grpcurl check above.)
```

`run-local.sh` wraps steps 1–4.

### Running it as an in-cluster pod — the verified full path (2026-07-16)

For the full **harness → leaf → relay → worker** path, run the worker as a pod
(relay→worker stays in-cluster). Automated by the scripts here:

```bash
./build-image.sh          # cross-compile linux/amd64 + OpenShift internal-registry build
./deploy-incluster.sh     # SA + nonroot-v2 SCC + Deployment; verifies Redis presence
# drive a leaf:
curl -sk -H 'Content-Type: application/json' \
  -d '{"sessionId":"leaf-1","item":{"item_id":"i1","file":"/workspace/README.md","pattern":"hello"},"maxTurns":2}' \
  https://serverless-harness-default.<domain>/runs
```

Verified on ykt1: the leaf's file tools ran on the worker —
`test -r …`, `file --mime-type …`, `cat …` all hit the worker and returned
`HELLO WORLD`; the leaf verdict came back `FLAGGED` ("pattern hello present as
HELLO WORLD"). Worker pod log showed the three `exec req_id=…` frames.

> **Required egress rule (upstream gap).** The harness `serverless-harness-egress`
> NetworkPolicy is default-deny egress. As shipped it allows DNS, Redis, and
> :443/:6443 — but **not the relay**, so with `SH_REMOTE_SANDBOX=1` every remote
> exec is silently default-denied (harness→relay blocked) and times out. This repo's
> `deploy/knative/harness-egress-policy.yaml` now adds the missing rule
> (`app=sandbox-relay` :8443). If you deployed before that fix, patch it live:
> ```bash
> oc patch networkpolicy serverless-harness-egress -n default --type=json \
>   -p '[{"op":"add","path":"/spec/egress/-","value":{"ports":[{"port":8443,"protocol":"TCP"}],"to":[{"podSelector":{"matchLabels":{"app":"sandbox-relay"}}}]}}]'
> ```

**Laptop via port-forward** (the earlier section) is a quick transport check
(presence + a `grpcurl` exec) — the same egress rule is still required for a
harness-driven leaf, since the block is on the harness→relay leg regardless of
where the worker runs.

For a worker on *other* infrastructure (not this cluster), expose the relay via an
OpenShift Route on :443 with TLS + HTTP/2 and point `RELAY_ADDR` at the Route
host (see README-worker.md "Running the worker outside the cluster"); the worker
then dials with TLS (`RELAY_TLS=1`) instead of `insecure`.

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `RELAY_ADDR` | `localhost:8443` | relay address (tunnel, ClusterIP, or Route host) |
| `SANDBOX_ID` | `sbx-laptop-1` | stable id; one live Attach per id |
| `SANDBOX_TOKEN` | `dev-token` | Bearer token; must match the relay |
| `RELAY_TLS` | `0` | `1` to dial with TLS (for a Route :443); `0` = plaintext h2c |

## Files

- `main.go` — the worker (~150 lines, stdlib + grpc only).
- `go.mod` — module; uses the in-repo stubs via `replace … => ../gen/go`.
- `run-local.sh` — laptop setup (relay token, enable path, port-forward, run).
- `build-image.sh` — cross-compile linux/amd64 + package via OpenShift internal-registry
  binary build (or `--push <ref>` for an external registry).
- `deploy-incluster.sh` — create SA + `nonroot-v2` SCC, apply the Deployment, verify presence.
- `worker-deployment.yaml` — in-cluster Deployment template (filled by `deploy-incluster.sh`).
- `Dockerfile` — multi-stage build from repo root (builds Go in-cluster).
- `Dockerfile.runtime` — packages the prebuilt binary (used by `build-image.sh`).

## Limitations (by design)

Stub only: no real command execution, no per-exec timeout enforcement (it always
finishes in ~0.3s), no TLS-client-cert, minimal dedup (in-memory). It demonstrates
the transport, not a production sandbox.
