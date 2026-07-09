# Architecture Decision Records (ADRs)

This directory is the **permanent decision spine** of the harness. An ADR captures **one
significant decision** — the context that forced it, the choice made, and the consequences
we accepted — in a form that stays true even as the code around it changes.

## Index

Reconstructed from the design specs in [`../specs/`](../specs/) (each ADR links back to its
spec). Chronological by the spec's date; numbers are permanent.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-redis-session-backend.md) | Persist Pi session state through a pluggable Redis backend | Implemented |
| [0002](0002-k8s-sandbox-client-remote-exec.md) | Route Pi tool execution to a remote pod via `kubectl exec` | Implemented |
| [0003](0003-persistent-in-pod-channel.md) | Reuse a long-lived in-pod bash session for fast tool ops | Implemented |
| [0004](0004-knative-serverless-wrapper.md) | Expose the harness as a scale-to-zero Knative HTTP service | Implemented |
| [0005](0005-mcp-code-mode.md) | Originate MCP calls as code the model runs in the sandbox | Accepted |
| [0006](0006-generalized-credentialed-egress.md) | Placeholder-swap over a forward proxy for all credentialed egress | Accepted |
| [0007](0007-compaction-checkpoint-fast-path.md) | Ride Pi's native compaction entry as the resume checkpoint | Implemented |
| [0008](0008-experiments-harness.md) | Measure the loader as in-process reconstruction cost, not end-to-end latency | Implemented |
| [0009](0009-cluster-experiments.md) | Drive cluster experiments with bash extending `smoke.sh` | Implemented |
| [0010](0010-identity-spine.md) | Per-session SPIFFE identity, user in the attested path, minted by the orchestrator | Accepted |
| [0011](0011-harness-lockdown.md) | Defend the harness by defanging local execution, not by mediating egress | Accepted |
| [0012](0012-inference-injector.md) | A separate injector pod holds the provider key and owns public LLM egress | Accepted |
| [0013](0013-leaf-session-backend-reprioritization.md) | Reprioritize the harness as a leaf-session backend; defer the heavy credential plane | Accepted |
| [0014](0014-mvp-leaf-session-contract.md) | Prove the backend with a run-to-completion `/runs` invocation contract | Implemented |
| [0015](0015-async-leaf-completion.md) | KEDA ScaledJob over a Redis Streams queue for background leaf execution | Implemented |
| [0016](0016-human-gate.md) | Human-gate as a structured terminal plus externally-triggered continuation | Implemented |
| [0017](0017-registry-securitycontext-hardening.md) | Apply the non-root least-privilege securityContext baseline to agent pods | Implemented |
| [0018](0018-scheduled-leaf-dispatch.md) | Native Kubernetes CronJob as the scheduled dispatch start signal | Implemented |
| [0019](0019-ocp-fs-free-deployment.md) | Durable RWO EBS Sandbox CR, non-root under nonroot-v2, for the OCP deployment | Implemented |
| [0020](0020-fs-free-harness.md) | Filesystem-free harness (envelope inline + Redis, working set on Sandbox CR) | Implemented |
| [0021](0021-shared-sandbox-pool.md) | Shared sandbox pool via N Sandbox CRs with harness-side Redis-lease routing | Implemented |
| [0022](0022-workload-parameterized-sandbox-load.md) | Report the sharing ratio as an N-vs-workload curve, not a single number | Implemented |
| [0023](0023-sandbox-sharing-ratio-experiments.md) | Measure sandbox sharing capacity on runc; split Kata isolation into P4 | Implemented |
| [0024](0024-sandbox-transport-remote-exec.md) | Remote sandbox exec over a worker-dialed gRPC stream, contract as language-neutral Protobuf | Accepted |

## What an ADR is (and isn't)

| | ADR | Spec (`../specs/`) | Plan (`../plans/`) |
|---|---|---|---|
| Answers | *what we decided & why* | *what & why, in depth* (alternatives, trade-offs, deferred) | *how, in what order* |
| Size | short (one decision) | long (a whole design) | a checklist |
| Retention | **permanent, immutable** | committed, point-in-time | **local-only, ephemeral** |
| On change | write a **new** ADR that supersedes | add a `Status:` header, don't rewrite | delete once coded |

An ADR is deliberately small: it records the *decision*, not the *design*. The full design
lives in a dated spec under [`../specs/`](../specs/); the ADR links to it. Use an ADR when a
choice is (a) hard to reverse, (b) cross-cutting, or (c) likely to be questioned later ("why
Connect instead of raw gRPC?", "why is the harness filesystem-free?").

## Rules

1. **Immutable.** Once accepted, an ADR is never edited except to change its `Status` line
   (e.g. to `Superseded by ADR-0007`). To change a decision, write a **new** ADR that
   references and supersedes the old one. The record of *why we once thought otherwise* has
   value.
2. **Numbered, monotonic.** Files are `NNNN-kebab-title.md`, zero-padded, next free number.
   Numbers are never reused.
3. **One decision per ADR.** If you're recording two, write two.
4. **Link to the spec.** The ADR states the decision; the spec carries the reasoning.

## Status vocabulary

`Proposed` → `Accepted` → `Superseded by ADR-NNNN` (or `Deprecated`). Same vocabulary as
specs (see [`../specs/README.md`](../specs/README.md#documentation-lifecycle)).

## Creating one

```sh
cp docs/adrs/0000-adr-template.md docs/adrs/NNNN-your-decision.md
# fill in Context / Decision / Consequences; set Status: Accepted; link the spec
```

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
