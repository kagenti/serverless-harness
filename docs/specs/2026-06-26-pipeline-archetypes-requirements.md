# Agentic Pipeline Archetypes & Consolidated Requirements

Version: 1.0 — June 26, 2026
Status: Reference (the evidence base behind the Capability Charter)
Scope: Describes three independent, real agentic pipelines as **name-free archetypes** and
consolidates **all** their requirements into one catalog, so the harness roadmap is grounded in
observed demand rather than assumption. No project, product, or skill names appear here by design.
Anchors: [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) (the conclusions); [MVP Thin Slice](2026-06-26-mvp-leaf-session-contract-design.md) (the first build).

> **Method.** Three independent production-ish agentic pipelines were examined directly (source,
> entrypoints, prompts, runtime packaging) and abstracted into archetypes A/B/C. The requirements in
> §7 are the **union** of what all three actually need — not a wish list.

---

## 1. The three archetypes at a glance

| | **A — Parallel fan-out analysis** | **B — Iterative role-based loop** | **C — Scheduled ingestion & filtering** |
|---|---|---|---|
| Purpose | scan a corpus → produce candidate findings → review → validate each | form a hypothesis → design+run a controlled experiment → extract principles → iterate | fetch items from external sources on a schedule → dedup → filter for relevance → refine |
| Orchestrator | deterministic staged scripts (`prepare→run→finalize`) with audit gates | deterministic state machine with atomic checkpoint/resume | a scheduler (cron) + event triggers + deterministic stages |
| Agent topology | flat pool of **parallel worker** leaf-sessions (one per batch/finding) | **two sequential roles** (planner, executor); ~2 LLM calls per iteration | deterministic stages + **single-call LLM leaf** filters |
| Parallelism | high (tens–hundreds of workers), bounded by a concurrency cap + per-class cap | low; isolation via per-condition **workspaces** (not agents) | low; per-source |
| Model tiering | per-phase: cheap pre-filter, stronger validation | per-role: stronger planner, cheaper executor | light (a small/fast model for filtering) |
| Human gates | minimal (blocker intervention only) | **explicit** approve / reject / abort + auto-mode | **issue/comment**-driven include / skip / clarify |
| State / artifacts | structured JSON batches + verdicts on a shared volume; resumable | schema-governed JSON (state, ledger, principles); atomic checkpoint; cross-iteration memory | JSON + incremental cursors; committed to a **git data store** |
| Start signal | invocation (a target corpus) | invocation (a target + spec) | **cron schedule + events** |
| Egress | model API, source control, package registries | model API (+ optional secondary endpoint) | model API, external content/source APIs, source-control push |
| Sandbox/tooling | symbol indexing, fast search, per-language build toolchains (for validation) | workspace isolation, build/run, patch capture & apply | external API clients; a containerized filter step |
| Scale profile | bursty, LLM-cost-dominated, long idle | long-running, human-paced, intermittent | periodic (scheduled), short bursts |

---

## 2. Archetype A — Parallel fan-out analysis

**Shape.** A deterministic controller runs stages as `prepare → run → finalize` triplets, each gated
by a machine-checkable `completion_audit` (`passed: true/false`) the next stage verifies. Stage 1
indexes a corpus and matches it against a catalog of rule/skill plugins to emit **candidates**; stage
2 reviews each candidate with an LLM (verdict ∈ {flagged, not-flagged, unknown}); an optional cheap
pre-filter stage discards obvious non-issues before expensive work; a final stage **validates** each
confirmed finding (is it real, is the path reachable, can a proof be built, what severity).

**Worker model.** A worker is a **parameterized agent-CLI invocation** (`<agent> --model {m} {prompt}`)
dispatched by an **OS subprocess pool** with a global concurrency cap and a per-rule/class cap (to
avoid API throttling), per-worker timeout, exponential-backoff retry, a circuit breaker, per-worker
logs, and idempotent progress files. **Workers do not spawn child agents** — and the design comments
make this an explicit choice: the subprocess pool *replaces* "ask the main agent to spawn N
sub-agents in its own context."

**Distinctive requirements:** batching by rule/class; per-class concurrency caps; coverage audit
(every candidate has a verdict, verdict sums reconcile); verdict normalization (map loose model text
→ canonical labels); a tooled sandbox (symbol indexer, fast search, per-language build toolchains for
the validation stage); aggregated HTML/markdown reporting.

---

## 3. Archetype B — Iterative role-based reasoning loop

**Shape.** A deterministic state machine drives a fixed loop: `INIT → DESIGN → (human gate) →
EXECUTE/ANALYZE → (human gate) → DONE → DESIGN…`, merging extracted principles forward so each
iteration constrains the next. Exactly **two LLM roles** per iteration — a **planner** (stronger
model: explore, frame, design a hypothesis bundle) and an **executor** (cheaper model: build, patch,
run, analyze) — invoked turn-by-turn by the non-LLM orchestrator.

**Parallelism & subagents.** Experiment "arms" run in **isolated per-condition workspaces** (git
worktrees), reset between conditions — **workspaces, not agents**. Currently a single executor agent
runs arms sequentially. **Planned-but-not-yet-merged:** a dispatcher that spawns one
worktree-isolated **subagent per arm**, and an **explore** layer that fans out a fresh-context
subagent per investigation scope. → This is the one archetype with **forward intent to use
clean-context subagents** (see §6).

**Distinctive requirements:** human-in-the-loop gates (approve / reject→loop / abort) with structured
summaries + an auto-approve mode gated by safety preconditions; **schema-governed** artifact I/O with
a validator the agent can self-correct against; atomic **checkpoint/resume**; **cross-iteration
memory** (accumulated principles persisted separately from per-run logs); **locked-spec guardrails**
(declared immutable parameters with hard-fail enforcement to prevent silent drift under unattended
runs); reproducible experiment substrate (observable metrics, controllable knobs, repeatable runs);
patch capture & apply; post-run knowledge extraction across campaigns.

---

## 4. Archetype C — Scheduled ingestion & filtering

**Shape.** A scheduler (cron) and events (e.g. issue edits/comments) trigger independent stages:
fetch from external sources → deduplicate (incremental **cursors**) → filter for relevance (a
**single LLM call per item**, cheap/fast model) → refine → record. State is JSON committed to a
**git data store**; integration between stages is the git store + the scheduler, not in-process
calls. Human curation happens through **issue/comment** gates (include / skip / clarify).

**Subagents.** None; every component is deterministic Python or a **single CLI LLM call**. No agent
spawns children.

**Distinctive requirements:** **trigger/start abstraction** (cron + event); **incremental state**
(cursors, dedup) to process only new items; **git-backed artifact store** (not a volume); single-call
LLM **leaf filters** (no agent loop needed); event-driven **human gates** via an external system
(issues/comments); multi-source egress (several external content/source APIs); per-stage isolation
(each stage is its own scheduled job/container).

---

## 5. Cross-archetype invariants

All three share:

1. **A deterministic, non-LLM outer orchestrator.** State machine / staged scripts / scheduler. The
   LLM is always a **leaf**, never the controller.
2. **Agents are parameterized leaf invocations** — `(model, inputs) → structured output`.
3. **Per-role / per-phase model tiering**, multi-provider, env-selected.
4. **Structured, schema-/audit-governed artifacts** on a durable store, with **coverage/ledger** and
   **checkpoint/resume or incremental cursors**.
5. **Human-in-the-loop gates** as a first-class control point (central in B and C; light in A).
6. **Code/tool sandbox** with **isolated workspaces**; the orchestrator owns its **artifact store**
   (volume *or* git), not the harness.
7. **Event/schedule or invocation start**; egress to a model API plus a few external services.

---

## 6. Subagent posture (verified)

**None of the three spawns subagents in currently-running code.** But the picture is nuanced and
splits subagent demand into two distinct patterns:

- **Bulk parallel fan-out** (A's many candidates; B's arms). Here the evidence says deterministic
  orchestration over **leaf sessions** is the *better* tool — A explicitly **rejected** agent-managed
  subagents for this ("…replaces ask the main agent to spawn N sub-agents in its own context").
- **Clean-context subtask delegation** (B's planned per-scope **explore** subagents, and per-arm
  worktree subagents). This is a *genuine* subagent use — a leaf agent offloading a focused subtask to
  a fresh-context child. B intends it (built, not yet merged).

**Conclusion for the harness:** the clean-context-subagent need is satisfied **for free by a
re-entrant leaf-session contract** — a leaf session that wants a fresh-context subtask simply invokes
the same leaf-session contract to dispatch a **child** leaf session (clean context + own sandbox by
construction). No separate subagent runtime is required for the core need. What genuinely remains for
a later milestone (Z6) is only the **extras**: parent/child lineage, budget propagation, sandbox
policy, and inter-agent messaging. Bulk fan-out stays deterministic; recursion is opt-in via the same
contract.

---

## 7. Consolidated requirements catalog (the union)

Grouped; each requirement notes which archetype(s) need it, the harness capability, and status
(✅ built · ⭐ new/promote · 🔹 keep-light · ⏸️ defer). "MVP" marks the thin-slice core.

### 7.1 Orchestration & control flow
| Req | Needs | Capability / status |
|---|---|---|
| Deterministic, non-LLM outer orchestrator (external to the harness) | A B C | external; harness is invoked, not orchestrator (charter G1/G2) |
| Stage sequencing with machine-checkable gates between stages | A | external orchestrator concern |
| State machine with atomic checkpoint/resume | B | external; harness offers session checkpoint ✅ (M5) |
| Scheduler (cron) + event triggers as the start signal | C | ⭐ trigger on-ramp (promote post-MVP); Knative is HTTP-triggered ✅ |
| Invocation-style start (a target + params) | A B | ✅ MVP (the invocation contract) |

### 7.2 Leaf-session execution
| Req | Needs | Capability / status |
|---|---|---|
| Parameterized leaf invocation `(model, inputs) → structured output` | A B C | ⭐ MVP — the leaf-session contract |
| Run-to-completion ("job mode"), bounded by max-turns | A B | ⭐ MVP |
| Single-call LLM leaf (no agent loop) | C | ⭐ MVP (degenerate case of run-to-completion) |
| Structured output with schema validation + self-correct on mismatch | A B C | ⭐ MVP (`submit_*` tool + validation) |
| **Re-entrant contract** (a leaf can dispatch a child leaf = clean-context subagent) | B (planned) | ⭐ design property (non-MVP scope; do not preclude) — §6 |
| Per-leaf max-turns / tool-use caps | A B | ✅ (harness budget/turns) |

### 7.3 Parallelism, batching, retry, coverage
| Req | Needs | Capability / status |
|---|---|---|
| Parallel worker fan-out (tens–hundreds), bounded by concurrency cap | A | ✅ Knative scale-out (M4); orchestrator sets fan-out |
| Per-class/per-rule concurrency cap (throttle avoidance) | A | external orchestrator concern |
| Batching by rule/class; configurable batch size; locality grouping | A | external orchestrator concern |
| Per-worker timeout; exponential-backoff retry; circuit breaker | A | external orchestrator concern; harness must be safe to re-invoke |
| Idempotent re-invocation (retry = re-dispatch same key) | A B | ⭐ MVP (session_id idempotency key) |
| Coverage audit (every item has a valid result; sums reconcile) | A | external orchestrator concern; harness emits per-leaf status |

### 7.4 Model tiering
| Req | Needs | Capability / status |
|---|---|---|
| Per-phase / per-role model selection | A B C | ✅ runtime model input (M6) |
| Multi-provider (OpenAI-compatible, Anthropic, cloud variants) | A B C | ✅ (M6); model-key injection 🔹 Z3 (env key for MVP) |
| Model resolution precedence (env > config > default) | A B | external orchestrator concern |

### 7.5 Artifacts, state, memory
| Req | Needs | Capability / status |
|---|---|---|
| Structured artifact I/O on a durable store **owned by the orchestrator** | A B C | harness must NOT impose a store (charter G3) |
| Shared-volume artifact handoff (inputs/results refs) | A | ⭐ MVP (volume envelope) |
| Git-backed artifact store | C | external; harness stays store-agnostic |
| Session/turn durability (resume a session) | A B | ✅ (M1/M5) — distinct from domain artifacts |
| Cross-iteration / incremental memory (principles; cursors/dedup) | B C | external orchestrator concern (domain store) |
| Schema-governed artifacts + validator | A B | ⭐ MVP for the result; broader validation external |

### 7.6 Human-in-the-loop
| Req | Needs | Capability / status |
|---|---|---|
| Gate primitive: pause → structured summary → approve/reject/abort | B | ⭐ promote post-MVP |
| Auto-approve mode gated by safety preconditions | B | ⭐ promote post-MVP |
| Gate-while-idle (a session may sleep awaiting approval) | B | ⭐ promote — fits scale-to-zero + durable resume |
| Event-driven gates via an external system (issues/comments) | C | external; harness exposes status |

### 7.7 Sandbox & tooling
| Req | Needs | Capability / status |
|---|---|---|
| Sandboxed tool execution (read/search/build/run) | A B C | ✅ (M2/M3) |
| Tooled image (indexer, fast search, per-language build toolchains) | A B | ⭐ adopt real image (post-thin-slice) |
| Isolated workspace per leaf/condition (read-only mount → CoW/worktree) | A B | ⭐ MVP (read-only mount); CoW/worktree later |
| Patch capture & apply; reset between conditions | B | external orchestrator concern + sandbox |
| Process/PID limits (fork-bomb guard) | A | ✅ pod resource limits |

### 7.8 Egress & credentials
| Req | Needs | Capability / status |
|---|---|---|
| Egress to model API | A B C | 🔹 Z3 injector (env key for MVP) |
| Egress to source control / content / package APIs | A C | 🔹 Z5 (env/SSH creds for MVP) |
| Credential injection by env / mounted secret (not baked) | A B C | 🔹 Z3/Z5; env for MVP |
| No secret in logs/artifacts/prompt | A B C | ✅ invariant (Z2 §4.1 / charter) |
| Per-user credentials in a shared tenant | none | ⏸️ defer (Z1) — all three are single-tenant/per-project |

### 7.9 Observability, resilience, guardrails
| Req | Needs | Capability / status |
|---|---|---|
| Per-leaf logs; structured status; failure classification | A B C | ⭐ MVP (terminal status + reasons) |
| Token/cost metrics per leaf and per run | A B | ⭐ promote (audit metadata) |
| Pre-flight credential/dependency check | B | external orchestrator concern |
| Locked-spec guardrails (immutable params, hard-fail on drift) | B | external orchestrator concern; harness enforces fail-closed config (Z2 L1) |
| Graceful partial success (continue past failed leaves) | A | external orchestrator concern |

### 7.10 Multi-tenancy & identity (none required today)
| Req | Needs | Capability / status |
|---|---|---|
| Per-user identity / per-session SPIFFE bound to user | none | ⏸️ defer (Z1) — pull in only for multi-tenant hosting |
| Recursive subagent runtime (lineage, budget, policy, mail) | B (extras only) | ⏸️ defer (Z6 extras); core covered by re-entrant contract (§6) |

---

## 8. What this means for the harness

- The **MVP** ([thin slice](2026-06-26-mvp-leaf-session-contract-design.md)) covers the ⭐-MVP rows: the
  leaf-session contract, run-to-completion, structured output, volume envelope, read-only workspace,
  per-call model, idempotent retry, per-leaf status — single-tenant, key-in-env.
- **Promote post-MVP** (next, demand-ordered): the **human-gate** primitive (B), the **trigger/cron**
  on-ramp (C), the **tooled image**, token/cost audit, and CoW/worktree workspaces.
- **Keep-light:** Z3 (model-key injection) and Z5 (source/content egress) — env-based until hardening.
- **Defer:** Z1 (per-user identity) until multi-tenant hosting; Z6 **extras** (the core
  clean-context-subagent need is a re-entrant contract, §6).

---

## 9. References

- [Capability Charter](2026-06-26-leaf-session-backend-capability-charter.md) — the conclusions this catalog grounds.
- [MVP Thin Slice](2026-06-26-mvp-leaf-session-contract-design.md) — the first build.
- [Milestone Registry](README.md).

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
