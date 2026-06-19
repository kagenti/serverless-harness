# M10 Design: MCP via Code-Mode in the Sandbox

Version: 1.0 — June 18, 2026
Status: Design (approved for implementation planning)
Scope: How MCP tool calls are originated in the serverless harness — as **code the model
runs in the sandbox**, not as harness-native tool calls and not through a standalone
terminating gateway.
Parent design: [Zero-Trust, Multi-Agent Extensions to the Serverless Harness](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) §3.3 (MCP servers — gateway invocation), M10
Builds on: M1 (Redis session backend), M2 (`K8sSandboxClient`), M3 (persistent channel), M4 (Knative wrapper)

> **Supersedes §3.3 of the parent design.** The parent doc chose a dedicated MCP gateway
> with harness-registered `registerTool` *forwarding tools*. This spec replaces that with a
> **code-execution-with-MCP** model: the model writes a script that calls MCP from inside the
> sandbox, and credential injection + per-call audit happen transparently at the egress
> waypoint. The spine (§2 of the parent) is unchanged and, if anything, more cleanly honored.

---

## 1. Goal & scope

The parent design settled three things about MCP and left one open:

- **Settled:** MCP servers are separate kagenti-deployed components with their own
  identities and lifecycle; the harness must hold no MCP backend credentials; the design
  must fit the zero-trust spine (no model-influenced component holds a raw secret).
- **Open:** the **invocation locus** — does an MCP call originate in the harness (brain),
  the sandbox (hands), or a dedicated gateway?

A verification finding in the parent design is decisive here: at the pinned Pi commit
(`406a2214`) **Pi has no MCP client** — no `@modelcontextprotocol/sdk`, no MCP protocol
code. MCP integration must therefore be *built* regardless of locus, so "fits Pi as-is"
does not favor any option. Freed from that pull, we choose the locus that is **thinnest on
Pi, most token-efficient, and most consistent with the spine**: the sandbox, invoked as
code.

**The principle:** MCP is not a protocol the harness speaks. It is *code the model runs in
the hands*. This is a thin specialization of spine §3.2 ("the sandbox makes credentialed
egress calls it cannot read") — an MCP call is just another such egress.

M10 is **done** when:

1. The model completes an MCP-backed task by writing and running a script in the sandbox —
   the harness imports no MCP SDK and registers no MCP forwarding tools.
2. An MCP call round-trips with backend credentials injected **only** at the egress
   waypoint; the raw credential is absent from the harness env, the sandbox env, the prompt,
   and every log entry.
3. Each individual MCP call appears as a per-call audit entry in the session stream,
   produced by the waypoint and correlated to the session.
4. A runaway script (pathological MCP loop) is stopped by the hard per-session cap; ordinary
   over-budget sessions abort cleanly at the next turn boundary.

### In scope

- A **pre-baked MCP wrapper library + client runtime** in the sandbox image
  (`./servers/<server>/<tool>.ts` schema stubs + a thin MCP-over-HTTP client that
  auto-stamps session correlation).
- An **MCP extension to the AuthBridge Envoy egress waypoint** (ext-proc): recognize
  MCP-over-HTTP, inject per-backend creds keyed by sandbox SPIFFE id, append a per-call log
  entry to the session stream, count calls and enforce a hard per-session cap.
- **Budget-sum widening** in the existing M4-era budget voter to include broker-written MCP
  entries (the tunable soft budget).

### Out of scope (later milestones / separate tracks)

- **Per-team / per-session MCP server rosters.** The pre-baked roster is static per sandbox
  image; varying it needs image variants. Deferred.
- **stdio-transport MCP servers.** This binding parses MCP **over HTTP/SSE** at L7;
  stdio-only servers are not covered.
- **A standalone terminating MCP gateway.** Replaced by the transparent waypoint (see D5).
  kagenti's `mcp-gateway` component is not on the sandbox→backend data path in this design.
- **Subagent fan-out mechanics** — owned by M11; M10 only confirms MCP composes with it
  (§8).
- **Codegen tooling for the wrappers** beyond "they exist in the image" — the generator that
  introspects servers and emits stubs is an implementation detail of the image build.

---

## 2. Key decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Invocation locus | **Sandbox, as code.** The model uses Pi's existing Bash/Write/Read tools (already redirected to the pod by `K8sSandboxClient`, M2) to author and run a script that calls MCP. Full replacement of the §3.3 forwarding-tool approach — the brain never originates MCP. |
| D2 | Tool discovery | **Pre-baked into the sandbox image.** Interface stubs live on disk as `./servers/<server>/<tool>.ts`; the model reads only what it needs (progressive disclosure = the token win). Zero runtime codegen; reproducible. Trade-off: static roster per image. |
| D3 | Observability granularity | **Egress waypoint logs each call.** From Pi's view a bash run is one `intention` → one `tool_result`. The waypoint additionally appends one **per-MCP-call** entry into the *same session stream*, correlated by session id + `actor_spiffe_id`. The egress plane becomes a log *producer*. |
| D4 | Budget enforcement | **Lean both.** Waypoint enforces a high **hard** per-session call cap (kill-switch for runaway loops). Harness **soft** budget = the existing turn-boundary voter, with its cumulative sum widened to include broker-written MCP entries → clean `abort`. |
| D5 | Network / trust path | **Direct to backends + transparent waypoint.** Wrappers address real MCP server hostnames; the AuthBridge Envoy egress waypoint (Envoy + ext-proc) transparently intercepts at L7, injects creds, logs, and enforces the cap. No separate terminating gateway component. |
| D6 | Session correlation | **Runtime auto-stamps it.** The pre-baked client runtime reads `KAGENTI_SESSION_ID` from env (set by the harness when it binds the sandbox to a turn) and stamps `X-Kagenti-Session` on every MCP call. The model's code never threads session context. |
| D7 | Pi integration surface | **Near-zero.** No `@modelcontextprotocol/sdk`, no `registerTool` MCP forwarding tools, no Pi fork for MCP. Reuses native `BashOperations`/`WriteOperations`/`ReadOperations`. |

---

## 3. Architecture & request path

```
model (in Pi)
  │  decides to use an MCP capability
  ▼
writes a script  ──► Pi Bash/Write tool ──► K8sSandboxClient ──► runs IN the sandbox pod
                                                                      │
  script imports pre-baked wrappers  ./servers/<server>/<tool>.ts     │
  (schema stubs + thin MCP-over-HTTP client runtime)                  │
                                                                      ▼
                                          MCP-over-HTTP to real backend hostname
                                          (client runtime auto-stamps X-Kagenti-Session)
                                                                      │
                                          ┌───────────────────────────┘
                                          ▼
                  AuthBridge Envoy egress waypoint  (Envoy + ext-proc) — "the broker"
                  • injects per-backend creds (keyed by sandbox SPIFFE id)
                  • appends one per-call entry → session stream
                        (data.via="mcp-waypoint", server, tool, actor_spiffe_id)
                  • increments per-session counter; rejects past the hard cap
                                          │
                                          ▼
                                  real MCP server(s)
  │
  ▼
script filters / aggregates in code, prints ONLY the relevant slice
  │
  ▼
returns as ONE bash tool_result to the model context     ← the token win
```

**Why this shape.** The large token reduction reported for code-execution-with-MCP comes
from two properties this path preserves: (1) tool definitions are files on disk read on
demand, never a context dump; (2) intermediate MCP results are processed in code and never
enter the model context — only the final slice does. Pi is a *coding* agent, so
writing-and-running-code is its strongest mode; this plays to its grain rather than bolting
an RPC tool surface onto it.

---

## 4. Components

| Component | Where it runs | Responsibility |
|---|---|---|
| **MCP wrapper library + client runtime** | pre-baked in the sandbox image | `./servers/<server>/<tool>.ts` interface stubs (schemas only — no creds, no live endpoints baked in) + a thin MCP-over-HTTP client. Runtime auto-stamps `X-Kagenti-Session` from `KAGENTI_SESSION_ID`. |
| **AuthBridge waypoint MCP extension** | egress path of the sandbox pod | Teach the existing Envoy + ext-proc to recognize MCP-over-HTTP: inject per-backend creds, append a per-call log entry to the session stream, count calls + enforce the hard cap. |
| **Budget-sum widening** | harness (existing M4-era voter) | The turn-boundary cumulative sum now also counts the broker-written MCP entries. A few lines; no new mechanism. |

**Wrappers ≠ credentials/endpoints.** Pre-baking bakes only interface stubs. The live target
URL and credentials are resolved at runtime through the egress plane, so the same image is
portable across environments and pre-baking never violates the cred spine.

**What binds a sandbox to a session.** The harness sets `KAGENTI_SESSION_ID` (and the
sandbox receives its SPIFFE id from SPIRE) when it provisions/binds the sandbox for a turn.
That env + identity pair is what lets the *transparent* waypoint correlate nested MCP calls
back to the right session stream without the model doing anything.

**Delta vs. parent §3.3.** This design *removes* a Pi integration (the forwarding tools) and
*replaces* the standalone MCP gateway component with an extension to a waypoint kagenti
already runs.

---

## 5. Log schema & observability

§3.3's "reuses `intention` → `tool_result`" still holds in spirit; the **producer** and
**granularity** shift:

- **Coarse pair (harness-produced):** the model's bash run is one `intention` (the script) →
  one `tool_result` (the printed slice) — identical to any other bash call.
- **Fine entries (broker-produced):** the waypoint appends one entry per MCP call into the
  *same session stream*, carrying `data.via = "mcp-waypoint"`, the target `server`/`tool`,
  and `actor_spiffe_id`. **No new entry type** is required — but the egress plane is now a
  log *producer*, not only the harness.

**Invariant §4.1 holds unchanged:** no entry carries a raw secret. Credentials are injected
downstream of the log, at the waypoint. The per-call entries name *who / what / where* —
never the credential. This stays directly testable by the parent design's red-team grep over
the log, the harness env, the sandbox env, and the reconstructed conversation.

---

## 6. Budget & failure modes

**Budget (the lean both, D4):**

- **Hard cap (waypoint):** a high per-session MCP-call ceiling (e.g. ~1000 calls/turn). Rides
  the logging path already built for D3 — a counter plus one comparison. Fires only on
  pathological loops.
- **Soft budget (harness):** the existing turn-boundary voter, sum widened to include the
  broker's MCP entries. This is the operator-tunable budget and produces a clean `abort`.

**Why both, despite a simplicity preference.** Code-mode introduces one genuinely new failure
mode: the model writes a loop that makes thousands of MCP calls inside a *single* bash run.
No inference happens during that run, so the inference budget never sees it, and a pure
turn-boundary budget only reacts *after* the turn. The hard cap closes that intra-turn hole.
Because both halves are small additions to code paths we already build (D3 logging path;
M4 voter), "both" costs marginally more than one and avoids having to choose between ugly
mid-script failures *or* an unguarded runaway path.

**Failure modes (new, stated explicitly):**

- **Hard-cap hit** → the MCP call throws *inside the model's script* → the model sees an
  error mid-run and adapts. Acceptable: errors-in-scripts are a coding agent's native failure
  surface.
- **Single-turn budget burn** → a bad script can still exhaust a turn's soft budget in one
  bash call; the soft budget catches it at the *next* turn boundary, the hard cap catches
  *pathological* loops mid-turn.

---

## 7. Pi integration surface

This is the crux of the original "how does this work with Pi?" question. The answer is
**near-zero surface — less than §3.3 required.**

- ✗ No `@modelcontextprotocol/sdk` dependency.
- ✗ No `registerTool` MCP forwarding tools (§3.3 *did* need these).
- ✗ No Pi fork for MCP.
- ✓ Reuses Pi's existing `BashOperations` / `WriteOperations` / `ReadOperations`, already
  redirected to the pod by `K8sSandboxClient` (M2).

Pi stays a near-pure function: it runs bash that happens to call MCP from inside the
sandbox. MCP knowledge lives entirely in the sandbox image and the egress waypoint.

---

## 8. Subagents (composition check only — owned by M11)

MCP composes with subagents with **no extra mechanism**. Parent §3.4 already gives each
subagent a fresh isolated sandbox → its own SPIFFE id → its own waypoint egress scope and its
own per-session MCP budget and hard cap → contained blast radius. Each subagent uses the same
pre-baked image with its own identity. Nothing MCP-specific is added in M11 for this to hold.

---

## 9. Consequences & trade-offs (recorded honestly)

1. **Relaxed isolation.** §3.3's "untrusted backends never in the sandbox netns" relaxes to
   "reachable only through the mediating waypoint." Isolation now comes from the mesh +
   NetworkPolicy + the ext-proc, not from an air-gap. For high-risk untrusted backends this
   is weaker than a terminating proxy; if that becomes unacceptable, a terminating
   `mcp-gateway` hop can be reintroduced for *specific* backends without changing the
   code-mode model (the wrappers' target hostname simply points at the gateway for those).
2. **Static roster per image.** Rebuild the sandbox image when the MCP server set changes;
   per-team/per-session rosters need image variants (deferred, §1 out of scope).
3. **L7 dependency for audit.** Per-call audit depends on the waypoint parsing MCP-over-HTTP.
   Networked (HTTP/SSE) MCP servers only; stdio-transport servers are out of scope for this
   binding.
4. **Coarser Pi-native view.** Pi's own event stream sees one bash `tool_call` per script;
   fine-grained MCP visibility lives in the session stream (broker entries), not in Pi's
   in-process hooks. Anything that needs per-MCP-call reaction must read the log, not hook
   `tool_call`.

---

## 10. Milestone gate

M10 passes when, end to end on a Kind cluster with the sandbox image and the waypoint MCP
extension deployed:

1. A model task completes against a real MCP server purely by running a script in the
   sandbox; `grep` confirms the harness bundle imports no MCP SDK and registers no MCP tool.
2. The backend credential is present **only** at the waypoint: red-team grep finds it absent
   from harness env, sandbox env, prompt, and every session-log entry, while the call still
   succeeds.
3. Each MCP call produced a per-call session-stream entry with `data.via = "mcp-waypoint"`
   and an `actor_spiffe_id`.
4. A deliberately runaway script trips the hard cap (MCP call throws mid-script); a separate
   over-budget session ends via a clean turn-boundary `abort`.

---

## 11. References

- [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2 spine, §3.2 sandbox egress, §3.3 (superseded here), §3.4 subagents, §4.1 invariants.
- [M2 Design — K8sSandboxClient](2026-06-17-m2-k8s-sandbox-client-design.md) — Operations redirection to the pod (the path code-mode rides).
- [M4 Design — Knative Serverless Wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md) — `runTurn`, the budget voter this design widens.
- Pi harness — [earendil-works/pi](https://github.com/earendil-works/pi): native Bash/Write/Read Operations; MCP client absent at pin `406a2214`.
- kagenti AuthBridge — Envoy + ext-proc token exchange and network-layer credential injection; SPIRE/SPIFFE workload identity.
- Anthropic, "Code execution with MCP: building more efficient agents" (Nov 2025) — the progressive-disclosure + filter-in-code pattern this design applies.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
