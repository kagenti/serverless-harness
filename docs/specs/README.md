# Serverless Harness — Milestone Registry

**This document is the source of truth for milestone numbering and status.** It supersedes the
milestone table in the parent research doc
([Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) §5, "M7–M12"),
whose numbering collided with the built work and was partly reframed by the June-26
credential-plane re-examination.

## Why a registry

Two work streams accreted overlapping `M`-numbers:

- The **built** harness work ran `M1–M7`.
- The **design-only** zero-trust credential plane (parent research doc) *also* started at `M7`, and
  later specs (`m10-mcp-code-mode`, `m13-…-egress`) reused/diverged from the parent's numbers.

Net effect: `M7` meant two different things, `M10` meant two different things (the parent's MCP
*gateway* vs. the spec that *superseded* it with code-mode), `M13` was self-labeled "provisional,"
and the June-26 harness specs had no number at all.

**Resolution:** freeze the built track as **Phase 1 (`M1–M7`)**; give the credential plane its own
**Phase 2 (`Z`-prefix)**. No spec files are renamed — dated, descriptive filenames stay, so existing
cross-references keep working. Pre-existing `M10`/`M13` labels are recorded here as **aliases**.

---

## Phase 1 — Decoupled Harness (BUILT, frozen)

The decoupled scale-to-zero pattern. These are done and referenced across commits, memory, and
`EXPERIMENTS.md`. **Frozen — do not renumber.**

| ID | Title | Spec |
|----|-------|------|
| M1 | Redis session backend | [`2026-06-16-m1-redis-session-backend-design.md`](2026-06-16-m1-redis-session-backend-design.md) |
| M2 | `K8sSandboxClient` (Pi Operations → remote pod) | [`2026-06-17-m2-k8s-sandbox-client-design.md`](2026-06-17-m2-k8s-sandbox-client-design.md) |
| M3 | Persistent in-pod channel | [`2026-06-17-m3-persistent-channel-design.md`](2026-06-17-m3-persistent-channel-design.md) |
| M4 | Knative serverless wrapper (`runTurn`) | [`2026-06-17-m4-knative-serverless-wrapper-design.md`](2026-06-17-m4-knative-serverless-wrapper-design.md) |
| M5 | Compaction-checkpoint fast path + budget voter | [`2026-06-23-m5-compaction-checkpoint-design.md`](2026-06-23-m5-compaction-checkpoint-design.md) |
| M6 | Experiments E2/E5 (`@sh/experiments`) | [`2026-06-24-m6-experiments-design.md`](2026-06-24-m6-experiments-design.md) |
| M7 | Cluster experiments E1/E3/E4 | [`2026-06-25-m7-cluster-experiments-design.md`](2026-06-25-m7-cluster-experiments-design.md) |

> **Collision note:** Phase-1 `M7` (*cluster experiments*, built) is **not** the parent doc's `M7`
> (*egress/identity spine*, design). The latter is now **Z1** below.

---

## Leaf-Session Backend (BUILT)

The MVP leaf-session contract and the three pipeline archetypes it was tested against
([Pipeline Archetypes](2026-06-26-pipeline-archetypes-requirements.md)) — all shipped. These realize
the [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) §5 MVP core and §8
promote-post-MVP (human-gate, cron trigger). They are the **MVP/charter track**, distinct from the
`M`-numbered built harness (Phase 1) and the `Z`-numbered credential plane (Phase 2).

| Slice | Spec | PR(s) |
|----|-------|-------|
| MVP leaf-session invocation contract (run-to-completion, structured output, volume envelope) + gate-7 durable resume | [`2026-06-26-mvp-leaf-session-contract-design.md`](2026-06-26-mvp-leaf-session-contract-design.md) | #10, #11 |
| Async leaf completion (KEDA `ScaledJob` + Redis Streams queue, done-marker) | [`2026-06-27-async-leaf-completion-design.md`](2026-06-27-async-leaf-completion-design.md) | #12 |
| Scheduled leaf dispatch (cron trigger on-ramp, Archetype C) | [`2026-06-28-scheduled-leaf-dispatch-design.md`](2026-06-28-scheduled-leaf-dispatch-design.md) | #13 |
| Human-gate (gate-while-idle, Archetype B) | [`2026-06-28-human-gate-design.md`](2026-06-28-human-gate-design.md) | #14 |

All three archetypes (A parallel-fan-out, B human-gate, C scheduled) from the evidence base are now
built. Hardening hygiene across these is tracked in
[`2026-06-28-registry-hardening-hygiene-design.md`](2026-06-28-registry-hardening-hygiene-design.md).

---

## Two-tier Rearchitecture (`P`-prefix)

The [two-tier FS-free harness epic](https://github.com/kagenti/serverless-harness/issues/49): split
the fleet into an FS-free **harness** (agent brain — credentials, model loop, network I/O only) and a
durable **sandbox** (sole filesystem/syscall surface). Started as "run Archetype-A on OpenShift"; the
OCP RWX pain turned out to be a *symptom* of harness filesystem I/O, not the problem. Distinct from
the `M`-numbered built harness (Phase 1) and the `Z`-numbered credential plane (Phase 2): this is an
**architecture** track, dependency-ordered `P1 → P2 → P0′ → P3`.

| ID | Title | Status | Spec / issue |
|----|-------|--------|--------------|
| **P1** | **FS-free harness** — leaf envelope + human-gate off the filesystem (inline + Redis); sandbox working set `emptyDir` → agent-sandbox `Sandbox` CR durable PVC | **design ✅** | [`2026-07-02-p1-fs-free-harness-design.md`](2026-07-02-p1-fs-free-harness-design.md) (#45) |
| **P2** | **Shared sandbox pool + routing** — N distinct `Sandbox` CRs (per-sandbox RWO copy, no RWX), harness-side pick + Redis leases, ref-pinned lazy converge, static-N config knob | **design ✅** | [`2026-07-02-p2-shared-sandbox-pool-design.md`](2026-07-02-p2-shared-sandbox-pool-design.md) (#46) |
| **P0′** | OpenShift deployment of the FS-free harness — **P1 slice** (single durable RWO sandbox on OCP 4.20.8, full leaf smoke via Route) | **design ✅** | [`2026-07-02-p0prime-ocp-fs-free-deployment-design.md`](2026-07-02-p0prime-ocp-fs-free-deployment-design.md) (#47) |
| **P3** | **Sandbox sharing-ratio experiments** — measure the per-sandbox concurrency knee (→ `KAGENTI_SANDBOX_CAP`) and derived provisioning ratio N on runc; E6 saturation curve + E7 converge contention (delivers the deferred P2 live mixed-ref validation); in-cluster git-daemon substrate; Kind-dev → OCP-authoritative | **built ✅** (PR #58, OCP PR #61) | [`2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`](2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md) (#48) |
| **P3.1** | **E6 workload-parameterized sandbox-load** — replace the trivial marker-check leaf with real Archetype-A code-review variants (L0/L1/L2); report N as a curve over per-leaf sandbox work (not one optimistic number); raise `max-scale`, warm baseline, multi-sample, sustained-decline `detectKnee` | **design ✅** | [`2026-07-03-e6-workload-parameterized-sandbox-load-design.md`](2026-07-03-e6-workload-parameterized-sandbox-load-design.md) (#62) |
| **P4** | Kata/VM isolation + intra-pod cross-leaf hardening (infra-gated: bare-metal pool vs Kata peer-pods vs gVisor — no nested KVM on the m6i cluster); Kata-overhead delta on P3's baseline; conditional RWX revisit | planned | #57 |

> **Supersedes** the local un-pushed `docs/archetype-a-ocp-support` branch (NFS-RWX-for-harness):
> after P1 the harness mounts nothing, so the harness never co-mounts `/work`. Reference only.

---

## SandboxTransport (`ST`-prefix)

Make the sandbox reachable from **anywhere** by inverting connectivity: the sandbox worker dials
*out* over one gRPC bidi stream (HTTP/2 on `:443`), a single-replica in-cluster relay bridges it to
the harness, and both paths land behind the existing `SandboxTransport` seam
(`KubectlTransport` local + `GrpcRelayTransport` remote). Extends the shared-sandbox model (P2) to
untrusted bring-your-own / NAT / on-prem / other-cloud sandboxes without touching the Pi loop,
session backend, or leaf queue. Contract is a **language-neutral Protobuf IDL** (`sandbox/v1`), not
a TypeScript interface.

| ID | Title | Status | Spec / issue |
|----|-------|--------|--------------|
| **ST** | **SandboxTransport — language-neutral remote sandbox exec over gRPC** — worker-dialed `Attach` stream, single-replica presence-only relay mirroring into the existing pool, `SandboxTransport` seam, Go reference worker; per-sandbox bearer token day-one (SPIFFE/mTLS additive later) | **design ✅** | [`2026-07-08-sandbox-transport-grpc-design.md`](2026-07-08-sandbox-transport-grpc-design.md) (#78); [ADR-0024](../adrs/0024-sandbox-transport-remote-exec.md); epic #89 |

> **Two build tracks, separate contributors.** The **backend** (TypeScript / in-cluster — proto,
> `SandboxTransport` seam + `KubectlTransport` rename, relay + `GrpcRelayTransport` + presence mirror:
> issues #84–#86) and the **worker** (Go / sandbox side — reference worker: #87) build in parallel
> off the shared `sandbox/v1` contract, joined by the integration + live gate (#88). This mirrors the
> Z2/Z3 (harness) vs. Z4/Z5 (sandbox) split. Implementation **plans are local-only** (`../plans/`,
> gitignored) and authored per contributor.

---

## Phase 2 — Zero-Trust Credential Plane (`Z`-prefix)

> **Roadmap anchor:** [Leaf-Session Backend Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) (evidence base: [Pipeline Archetypes & Requirements](2026-06-26-pipeline-archetypes-requirements.md)) tests the design against three independent agentic-pipeline archetypes and **reprioritizes** this track: the harness's core role is a **leaf-session backend for external orchestrators**. **Z1 (per-user identity) defers** until multi-tenant hosting; **Z6 _extras_ defer** — the core clean-context-subagent need (one archetype plans it) is met by a **re-entrant leaf-session contract**, not new machinery. Z3/Z5 stay "keep-light."
>
> **First buildable milestone:** [MVP Thin Slice — Leaf-Session Invocation Contract](2026-06-26-mvp-leaf-session-contract-design.md) (Archetype A) — proves an external orchestrator can dispatch N parallel, parameterized, run-to-completion leaf sessions with structured (volume-envelope) results, retry, and coverage audit, on scale-to-zero. Reuses M2–M6; defers the whole credential plane.

Principle (parent §2): *no component influenced by model output ever holds a raw secret.* Secrets
live only in identity-keyed egress points. Dependency-ordered:

| ID | Title | Status | Spec / source | Alias |
|----|-------|--------|---------------|-------|
| **Z1** | Identity spine — per-session SPIFFE bound to user; `CredentialInjector` interface; orchestrator + reconstruct-on-wake | **design ✅** | [`2026-06-26-identity-spine-design.md`](2026-06-26-identity-spine-design.md) | parent M7 (reframed) |
| **Z2** | **Harness lock-down** — fail-closed redirection, secret-free container, default-deny egress, distroless, scoped RBAC; argues the harness needs **no** egress proxy | **design ✅** | [`2026-06-26-harness-lockdown-design.md`](2026-06-26-harness-lockdown-design.md) | — |
| **Z3** | **Inference injector** — shared provider-key chokepoint; multi-provider table, `x-sh-provider` routing, strip-then-set, mTLS, streaming, audit-only | **design ✅** | [`2026-06-26-inference-injector-design.md`](2026-06-26-inference-injector-design.md) | parent M8 |
| **Z4** | MCP code-mode in the sandbox (placeholder-swap; **supersedes** the parent's MCP *gateway*) | design ✅ | [`2026-06-18-m10-mcp-code-mode-design.md`](2026-06-18-m10-mcp-code-mode-design.md) | M10 (spec); parent M10 (superseded) |
| **Z5** | Generalized credentialed egress (sandbox forward proxy + baked CA; subsumes the parent's sandbox-credential milestone; generalizes Z4's mechanism) | design ✅ | [`2026-06-19-m13-generalized-credentialed-egress-design.md`](2026-06-19-m13-generalized-credentialed-egress-design.md) | M13; parent M9 |
| **Z6** | Subagents — first-class child sessions; fresh-isolated default + `SandboxPolicy`; CoW workspace seed; `mail`/`subagent_*` log types | design (no spec yet) | parent research doc §3.4, §M11 | parent M11 |
| **Z7** | Validation — secret-leak red-team across all paths; multi-agent fan-out; blast-radius containment | design (no spec yet) | parent research doc §M12 | parent M12 |

### Dependencies (Phase 2)

- **Z1** underlies everything (SPIFFE identities enable Z3's mTLS and Z4/Z5's per-workload scope).
- **Z2 ⇄ Z3** are a pair: the harness lock-down's "secret-free harness" (Z2 H4) depends on the
  injector (Z3) holding the provider key; Z3's enforceable network boundary depends on Z2's
  default-deny egress.
- **Z5 builds on Z4** (the sandbox egress generalizes MCP code-mode's placeholder-swap).
- **Z2/Z3** are the **harness** side; **Z4/Z5** are the **sandbox** side. They share the spine (Z1)
  but are independent to build.
- **Z6** composes on the same plane (each subagent = own identity/sandbox). **Z7** validates Z1–Z6.

---

## Rosso Cortex Integration (`RC`-prefix)

Reframes the Phase-2 credential plane around **Rosso Cortex / AuthBridge** as the concrete injection
**and** control mechanism, and around the `#89` SandboxTransport seam — for a single-tenant, Kind-first
PoC. AuthBridge sits on both harness HTTP egress hops as one "egress control-plane, two deployment
profiles" pattern: a **shared** LLM gateway and a **per-sandbox** egress forward-proxy. This
**supersedes the mechanism** of Z3 and implements a **static single-tenant slice** of Z5 (per-user /
RFC 8693 deferred). Distinct from the `Z`-numbered plane it reframes — this is an **integration** track,
so it takes its own prefix rather than a linear `Z` id.

| ID | Title | Status | Spec / decision |
|----|-------|--------|-----------------|
| **RC1** | **AuthBridge egress control-plane PoC** — shared LLM gateway (Profile A) + per-sandbox egress forward-proxy (Profile B); real static-cred `token-broker` injection + stubbed-judge SPARC/IBAC control; BYO sandbox stretch on the `ST` seam (ST5-gated) | design ✅ (proposed) | [`2026-07-10-authbridge-egress-control-plane-poc-design.md`](2026-07-10-authbridge-egress-control-plane-poc-design.md); [ADR-0025](../adrs/0025-authbridge-deployment-topology.md) |

---

## Lineage & supersessions (explicit)

- The parent research doc's **M7–M12** table is **superseded by this registry.** Its M-numbers are
  retained only as the "Alias" column.
- The parent's **MCP gateway (M10)** is **superseded** by **Z4** (MCP code-mode in the sandbox): MCP
  is code the model runs in the sandbox, not a harness-forwarded gateway call.
- The parent's **sandbox credential injection (M9)** is **subsumed** by **Z5** (generalized
  credentialed egress), of which MCP-over-HTTP is one interception case.
- The parent's **inference broker (M8)** is realized concretely as **Z3** (inference injector),
  and its sidecar placement is refined to a **separate pod** (Z2 H6 — NetworkPolicy granularity).
- The June-26 re-examination **reframed Z1's harness portion**: the harness gets a SPIFFE identity
  but **no egress waypoint** (its egress is fixed-destination; see Z2 §2.4).
- **RC1** (own `RC` track) reframes the plane around **AuthBridge (Rosso Cortex)** as the mechanism, plus the `#89`
  SandboxTransport seam. It **supersedes the *mechanism* of Z3** (the plain Go injector becomes an
  AuthBridge shared gateway once control plugins share the hop) and **implements a static single-tenant
  slice of Z5** (per-user / RFC 8693 token-exchange deferred), unifying both under one "egress
  control-plane, two deployment profiles" pattern. Z3/Z5 are retained as the deployment-profile detail
  and the home of the deferred per-user work. Topology decision: [ADR-0025](../adrs/0025-authbridge-deployment-topology.md).

---

## Documentation lifecycle

Three artifact types, three lifecycles. Code is the source of truth for *how*; the durable
value of docs is the *why* — decisions and the alternatives we rejected.

| Artifact | Answers | Retention | Home |
|---|---|---|---|
| **Spec** (design doc) | *what & why* — alternatives, trade-offs, deferred work | committed, point-in-time; mark `Superseded by …`, don't delete | `docs/specs/` (here) |
| **ADR** | one significant decision + context + consequences | committed, **permanent & immutable**, supersession-aware | [`docs/adrs/`](../adrs/) |
| **Plan** (impl steps) | *how, in what order* | **local-only, ephemeral** — delete once coded; never committed | [`docs/plans/`](../plans/) (gitignored) |

- A **spec** is a dated deep-dive. It's never retro-edited — a superseded spec gets a
  `Status:` header pointing at its successor and stays in git as the point-in-time record.
- An **ADR** is the permanent spine: a short, immutable record of a single decision that links
  out to the spec for the full reasoning. See [`docs/adrs/README.md`](../adrs/README.md).
- A **plan** is a throwaway checklist, obsolete the moment the code merges — so plans are
  local-only work artifacts (gitignored). See [`docs/plans/README.md`](../plans/README.md).

### Status vocabulary (specs & ADRs)

Every spec and ADR carries a `Status:` line in its header, drawn from:

> `Proposed` → `Accepted` → `Implemented` → `Superseded by <link>` (or `Deprecated`)

When a design is replaced, set the old spec's status to `Superseded by <link to successor>`
rather than deleting it — the record of what we once thought, and why we changed, has value.
(For example, the removed Redis-transport remote-exec design is marked superseded by the
gRPC/Connect sandbox-transport spec, which records the supersession in its own §12.)

## Conventions going forward

- **New Phase-2 specs** take the next free **`Zx`** id and record it in this table.
- **Filenames stay dated + descriptive** (`YYYY-MM-DD-<topic>-design.md`); the canonical `Zx` id
  lives here, not in the filename, to avoid rename churn.
- Each spec keeps the existing header block (Version / Status / Scope / Builds-on); cross-reference
  by **canonical id** (e.g. "Z3") with the filename in parentheses on first mention.
- Implementation plans live in [`docs/plans/`](../plans/) (local-only, gitignored), named for the
  spec they implement, and are deleted once the work is coded and merged.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
