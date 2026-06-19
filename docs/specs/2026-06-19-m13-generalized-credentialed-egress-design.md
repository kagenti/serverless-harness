# M13 Design: Generalized Credentialed Egress — non-MCP HTTP APIs

Version: 1.0 — June 19, 2026
Status: Design (approved for implementation planning)
Scope: How the sandbox reaches **any** HTTP API (GitHub, internal REST, arbitrary
allowlisted hosts) under the same zero-trust credential spine M10 established for MCP —
with per-user credentials injected only at the egress waypoint, never held by the harness,
the sandbox, the prompt, or the log.
Milestone number: **M13 (provisional)** — a new sibling milestone extending the parent
roadmap's M7–M12. Adjust the number to fit the parent roadmap when slotted.
Parent design: [Zero-Trust, Multi-Agent Extensions to the Serverless Harness](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) §2 spine, §3.2 sandbox egress, §4.1 invariants, M7–M9 credential plane
Sibling / specializes: [M10 — MCP via Code-Mode in the Sandbox](2026-06-18-m10-mcp-code-mode-design.md) — **M10's MCP-over-HTTP path becomes one special case of this design.**
Builds on: M1 (Redis session backend), M2 (`K8sSandboxClient`), M3 (persistent channel), M4 (Knative wrapper), M10 (MCP code-mode + credential/identity model §5)

> **Relationship to M10.** M10 is frozen and approved. This design does not reopen it; it
> *generalizes* the mechanism M10 built. M10's "recognize MCP-over-HTTP, mint a user-scoped
> token, inject at the waypoint, log per call" is, in this design, the OAuth-resolver case of
> a single generalized egress path. The selector, the waypoint, the audit producer, and the
> budget machinery are shared; only the **credential resolver** differs per destination.

---

## 1. Goal & scope

M10 settled one egress shape — MCP-over-HTTP to in-mesh kagenti backends — and proved the
spine on it: the model runs code in the sandbox that makes a credentialed call it cannot
read. This milestone answers the obvious next question: **what about everything else the
model wants to reach?** `gh`/the GitHub API, `curl` to an arbitrary endpoint, code using an
SDK against some service. The driving requirement is **one unified mechanism** in which MCP
is not special — it is the first instance of "credentialed egress the sandbox can't read."

**The principle (inherited from M10, widened):** an MCP call and a GitHub call are the *same
path*. The model writes code that addresses a destination by host; the AuthBridge egress
waypoint resolves `(bound subject ⊕ destination) → credential`, injects it transparently at
L7, logs the call, and enforces a cap. Only the **resolver** differs (mint vs. stored grant).

### Worked example (the shape of "done")

A user prompts: *"review the PR at https://github.com/kagenti/kagenti/pull/1990"* — and knows
nothing about egress, proxies, or credentials.

1. The model maps intent → GitHub REST (`GET /repos/kagenti/kagenti/pulls/1990` + files +
   comments). Normal coding-agent knowledge; no platform magic.
2. The model writes a sandbox script that calls the GitHub wrapper
   (`await getPR("kagenti/kagenti", 1990)`) — **no auth, no host, no token** in the code.
3. The request leaves the sandbox over the mesh → AuthBridge waypoint resolves
   session → `subject = <user>`, destination → the user's stored GitHub grant, injects
   `Authorization`, originates real TLS to api.github.com, appends one audit entry, counts it.
4. GitHub sees the call **as that user**. The script filters/summarizes the diff *in code* and
   prints only the review-relevant slice → one `tool_result`. A 3000-line PR never floods
   context — the same token win as M10.

### In scope

- **Generalize the AuthBridge egress waypoint** from "recognize MCP-over-HTTP" to "inject +
  audit + cap for any allowlisted HTTP destination," with a per-destination **host-policy**
  that selects the credential resolver.
- **In-mesh front-door for external hosts** (Istio `ServiceEntry` + TLS origination at the
  egress waypoint) so public APIs (api.github.com) become indistinguishable from M10's
  in-mesh backends — **no baked CA, no client-side TLS interception.**
- **Sandbox-side interface:** a mandatory **generic egress helper** + a committed **GitHub
  wrapper**, both speaking plaintext HTTP to the front-door (additional wrappers on demand).
- **Generalized audit + budget:** per-call `egress-broker` log entries; hard per-session
  egress-call cap; soft turn-boundary budget widened to count them.
- **Recording** the per-user external-credential-store + linking/consent shape (§4) as a hard
  identity-plane dependency this milestone *consumes*, mirroring M10 §5.

### Out of scope (later milestones / separate tracks)

- **The per-user external-credential store + onboarding/consent build itself** — M7–M9
  identity-plane work. This design records its required shape; it does not build it.
- **The env-injection credentials-driver build** (OpenShell-style, for foreign binaries) — the
  documented escape hatch (§5.3); deferred, pulled in only when a real foreign-binary need
  lands.
- **Per-team / per-session host rosters & wrapper variants** — static per sandbox image
  (M10 §10.2 trade-off carries over). The generic helper softens this for *hosts*.
- **stdio-transport MCP** and **non-HTTP protocols** — this binding is HTTP/SSE at L7.
- **A standalone terminating gateway** — same stance as M10 D5; the transparent waypoint is
  the mediating hop.
- **Subagent fan-out mechanics** — M11; this design only confirms composition (§7).

---

## 2. Key decisions

| # | Decision | Choice |
|---|----------|--------|
| E1 | Unification | **One generalized egress path; MCP is a special case.** Same waypoint, selector, audit producer, and budget machinery as M10. Only the credential **resolver** is per-destination. |
| E2 | Injection model | **Transparent L7 injection at the AuthBridge waypoint + placeholder-swap.** The model holds zero credential material. Env-injection is demoted to a documented escape hatch (§5.3), never the base — consistent with M10 §5.4. |
| E3 | External hosts | **In-mesh broker front-door** (Istio `ServiceEntry` + TLS origination). External APIs look exactly like M10's in-mesh backends; the waypoint sees plaintext at L7 and originates real TLS outward. **No baked CA**, no cert-pin breakage. |
| E4 | Egress allowlist | **The host roster *is* the allowlist.** The broker reaches only configured hosts; "arbitrary curl to anywhere" is structurally impossible (SSRF/exfil containment). |
| E5 | Non-OAuth scoping | **Per-user stored credentials. No shared-workload fallback.** Destinations that can't mint per-user tokens (GitHub PAT/App, third-party keys) resolve to the user's own pre-linked grant, keyed by bound subject. |
| E6 | Credential resolver | **Two resolvers, one selector.** `(subject ⊕ destination)` resolves via **mint (RFC 8693)** for OAuth backends (the M10 path) or **fetch-stored-grant** for everything else. The host-policy entry declares which. |
| E7 | Model interface | **Generic egress helper (mandatory foundation) + per-API wrappers (additive; GitHub committed).** Both speak plaintext HTTP to the front-door. Wrappers are ergonomics/steering, **never** a security boundary. |
| E8 | Foreign binaries | **Escape hatch only.** `gh`/cloud CLIs that do their own TLS land on env-injection (weaker: token in sandbox env, SNI-level audit). Flagged, not optimized for, build deferred. |
| E9 | Security boundary | **The broker is the sole enforcement point** — allowlist, per-user credential, audit, hard cap. Wrappers/helper/conventions are model-bypassable and enforce nothing. |
| E10 | Home | **New sibling milestone (this doc).** Keeps M10 frozen; records the new identity-plane dependency rather than entangling timelines. |

---

## 3. Architecture & request path

```
user: "review PR https://github.com/kagenti/kagenti/pull/1990"   (knows nothing of egress)
  │
  ▼  model maps intent → GitHub REST; writes a script in the sandbox
script:  await getPR("kagenti/kagenti", 1990)        ← ./apis/github wrapper (no auth, no host)
          │  (or generic:  egress("api.github.com", "/repos/kagenti/kagenti/pulls/1990"))
          ▼  plaintext HTTP over the mesh — model holds ZERO credential
  AuthBridge egress waypoint  (Envoy + ext-proc) — the generalized broker
   • resolve session (X-Kagenti-Session) → subject = <user>
   • destination = api.github.com → host-policy entry → credential resolver:
        - OAuth backend?  RFC 8693 mint        (M10 path)
        - else            fetch <user>'s STORED grant for github, refresh if needed
   • inject Authorization (placeholder-swap); originate REAL TLS outward
   • append ONE per-call audit entry → session stream
        (data.via="egress-broker", host, method, path, subject, actor_spiffe_id)
   • increment per-session egress counter; reject past the hard cap
          │
          ▼  real api.github.com — enforces per-user authz on the injected token
script filters / summarizes the diff IN CODE, prints ONLY the review slice
          │
          ▼  returns as ONE bash tool_result to the model context     ← the token win
```

**Why this shape.** It preserves M10's two token-win properties (tool/endpoint knowledge is
files-on-disk read on demand; intermediate results filtered in code, only the slice enters
context) and extends M10's exact trust path. The front-door makes external APIs in-mesh, so
there is one injection mechanism and zero baked-CA MITM. The **broker is the only security
boundary** (E9): because the model writes arbitrary code, a wrapper can always be bypassed,
so all enforcement — allowlist, per-user credential resolution, audit, cap — lives at the
waypoint, never in sandbox code.

---

## 4. Credential & identity model

### 4.1 One selector, two resolvers (E6)

Every egress resolves `(bound subject ⊕ destination host) → credential` at the waypoint. The
host-policy entry for the destination declares which resolver applies:

| Resolver | When | How | Per-user? |
|---|---|---|---|
| **Mint (RFC 8693)** | destination speaks OAuth (M10 MCP backends, OIDC APIs) | actor = workload JWT-SVID, subject = `<user>`, audience = backend → fresh scoped token | yes, minted |
| **Stored grant** | non-exchangeable API (GitHub PAT/App installation, third-party key) | fetch the user's pre-linked credential; refresh if the grant supports it | yes, stored |

The minting resolver is M10 §5 verbatim. The stored-grant resolver is the new capability this
design introduces and the reason for the identity-plane dependency below.

### 4.2 Per-user stored credentials (E5) — the new dependency this milestone records

Many useful APIs cannot mint a per-user token by exchange: a single shared key has no "Bob's
version." This design **does not** fall back to a shared workload credential (rejected — it
would break per-user isolation). Instead it requires a **per-user external-credential store +
a one-time linking/consent flow**: the user links a destination once (OAuth authorize, or
registers a fine-grained PAT) → an offline grant lands in the identity plane, keyed
`(subject, destination)`.

Required properties of that store — recorded here so the M7–M9 build inherits a settled shape
(this milestone **consumes**, does not build, the store):

- **At rest:** identity plane (Keycloak) + a K8s Secret loaded into the broker sidecar's
  memory. **Never** in the harness or sandbox. (Spine §4.1.)
- **Selection:** by bound subject + destination. **Blast radius:** a compromised sandbox in a
  user's session can reach only **that user's** grants — the bound subject is what authorizes
  resolution.
- **Lifecycle:** consent, rotation, expiry, revocation are first-class. On expiry/revoke the
  egress call returns an **auth error into the script** — there is **no silent fallback** to a
  workload-only or less-scoped credential.
- **Interactive vs. unattended are identical at egress.** GitHub login is not part of
  kagenti's Keycloak login, so even an online, interactive session reads the user's *stored*
  grant — not a live propagated GitHub token. Unattended (scale-to-zero, user offline) reads
  the same stored grant. This is strictly more general than M10's live-or-delegated subject
  sourcing and subsumes it.

### 4.3 Placeholder-swap preserved

As in M10 §5.3, the sandbox carries at most a session header, never a credential value. The
broker swaps in the real token at egress. This defends both invariant §4.1 (no secret in the
log) and the prompt-injection threat (no secret in model-visible output) — unchanged.

### 4.4 The session log carries identity references only

`subject` and `actor_spiffe_id` are identity references, never secrets. Injection happens
downstream of the log, at the waypoint. The parent's red-team grep (log + harness env +
sandbox env + reconstructed prompt) remains the direct test.

---

## 5. Model-facing interface

Three layers, cleanest first. **All three speak plaintext HTTP to the in-mesh front-door**, so
transparent injection + per-call audit + placeholder-swap hold uniformly across them.

1. **Pre-baked wrappers** — `./apis/<service>/…` typed stubs. **GitHub committed** in this
   milestone (`getPR`, `getPRFiles`, `getPRComments`, …); further services authored on demand.
   The model knows no host, scheme, or auth. Delivers the progressive-disclosure token win
   *and* steers the model onto the clean L7 path instead of reaching for a foreign binary.
2. **Generic egress helper** — `egress(host, path, opts)`. **Mandatory foundation.** The model
   passes the **real host** + path, no auth. The broker maps the host → resolver. Covers the
   long tail of allowlisted hosts with zero per-API authoring. A new host needs only a
   host-policy/allowlist entry — not an image rebuild.
3. **Raw** — `curl http://<realhost>/…`. Works; the only layer where the `http://`-to-mesh
   convention is visible to the model.

**Steering, not enforcement.** A sandbox `AGENTS.md`/system convention plus the *presence* of
wrappers nudges the model to layers 1–2. Because the broker enforces regardless (E9), steering
only keeps the model on the strongest path; it is not a security control. For a code-writing
agent, calling `await getPR(...)` or `egress(...)` is as natural as shelling out — the
"familiar binary" pull is a human intuition, not the model's.

### 5.1 Why wrappers are not a security boundary

The model writes arbitrary code; it can always bypass a wrapper and address the front-door
directly. Therefore the wrapper roster cannot constrain reachability. Enforcement is the
broker's host-policy + per-user resolution + audit + cap — full stop. "Wrappers-only = smaller
surface" is achieved by tightening the *broker allowlist* to the wrapped hosts, not by the
wrappers themselves.

### 5.2 The in-mesh front-door (E3)

External hosts are fronted by an Istio `ServiceEntry` + TLS origination at the egress waypoint.
The sandbox sends plaintext HTTP over the mesh to the destination's name; the waypoint sees
cleartext at L7 (injects + audits) and originates a real outbound TLS connection to the public
host. This is **not** forged-cert MITM — the workload trusts the mesh for the in-cluster hop,
exactly as it does for in-mesh MCP backends. No CA is baked into the sandbox trust store, so
cert-pinning clients on the wrapper/helper path are unaffected.

### 5.3 Escape hatch — env-injection (E8, deferred build)

For a genuine foreign binary that only reads a token from env/config and performs its own TLS
to a public host (`gh`, cloud CLIs), an OpenShell-style credentials-driver sidecar injects a
short-lived per-user token into the sandbox env. This is the **weaker** path: the token is
model-visible while it lives, and audit drops to SNI/host granularity (the waypoint cannot see
inside the binary's own TLS). It is therefore a documented escape hatch for explicitly-listed
tools — not the base mechanism — and its build is deferred to when a real need lands. The
credential it injects is still resolved by the same `(subject ⊕ destination)` selector, so the
identity model is unchanged; only the delivery and audit fidelity degrade.

---

## 6. Observability, budget & failure modes

**Audit (generalize M10 D3).** The waypoint remains a log *producer*, now for all egress. One
per-call entry into the session stream:

```
data.via          = "egress-broker"     // "mcp-waypoint" is a sub-case
data.host         = "api.github.com"
data.method/path  = "GET /repos/kagenti/kagenti/pulls/1990"
data.subject      = <user>              // identity reference
data.actor_spiffe_id = spiffe://…/sandbox
```

From Pi's view a script run is still one `intention` → one `tool_result`; fine-grained
per-HTTP-call visibility lives in the session stream (broker entries). No new entry *type* is
required. Invariant §4.1 holds: no entry carries a raw secret.

**Budget (M10's "lean both," generalized).**

- **Hard cap (waypoint):** a high per-session *egress-call* ceiling — kill-switch for a runaway
  loop (the model writes a loop that makes thousands of egress calls inside one bash run, where
  no inference happens and the turn-boundary budget never sees it). A counter + one comparison
  on the path already built for audit.
- **Soft budget (harness):** the existing M4-era turn-boundary voter, its cumulative sum
  widened to include broker-written egress entries → clean `abort`.

**Failure modes:**

- **Hard-cap hit** → egress throws *inside the model's script*; the model adapts mid-run
  (native coding-agent failure surface).
- **Single-turn budget burn** → a bad script can still exhaust a turn's soft budget in one bash
  call; the soft budget catches it at the next turn boundary, the hard cap catches *pathological*
  loops mid-turn.
- **Grant expired / revoked** → the resolver fails at the waypoint; an auth error returns into
  the script. No silent fallback to a less-scoped or workload-only token.
- **Destination off the allowlist** → the broker refuses; reachability is structurally bounded
  to the configured host roster (E4).
- **Foreign binary on the escape hatch** → coarser (SNI) audit + token-in-env; acceptable only
  for explicitly-listed tools (§5.3).

---

## 7. Subagents (composition check only — owned by M11)

This design composes with subagents with no extra mechanism, exactly as M10 §9: each subagent
gets a fresh isolated sandbox → its own SPIFFE id → its own waypoint egress scope, its own
per-session egress cap, and resolution bound to its own `(actor SVID ⊕ subject)`. A subagent
acting for the same user inherits the parent's bound subject (optionally a down-scoped grant);
a misbehaving subagent can reach only its own scope's grants, never a sibling's or the parent's.
Same pre-baked image, own identity. Nothing egress- or credential-specific is added in M11 for
this to hold.

---

## 8. Consequences & trade-offs (recorded honestly)

1. **New identity-plane state.** A per-user external-credential store with consent, linking,
   rotation, and revocation lifecycle — larger than M10's delegation. A hard M7–M9 dependency;
   this milestone is blocked on it for its per-user, unattended gate (criterion 3).
2. **Static wrapper roster per image** (M10 §10.2 carries over). The generic helper softens it
   for *hosts*: a new host needs only a host-policy/allowlist entry, not a rebuild. New *typed
   wrappers* still need an image change.
3. **In-mesh front-door per external host.** More mesh configuration (`ServiceEntry` + TLS
   origination per destination), traded for no baked CA and no cert-pin breakage.
4. **Foreign-binary blind spot.** `gh`/cloud CLIs reach only the weaker escape hatch
   (token-in-env, SNI audit). Flagged, not solved here; a code-writing agent is steered to the
   wrapper/helper path where the strong properties hold.
5. **Richer L7 broker.** The waypoint now parses arbitrary HTTP, not only MCP-over-HTTP — more
   logic on the critical path. Mitigated by it being one codebase shared with M10 (MCP becomes
   a resolver case, not a separate component).
6. **Relaxed isolation** (inherited from M10 §10.1). Untrusted backends are reachable through
   the mediating waypoint rather than air-gapped; isolation comes from mesh + NetworkPolicy +
   ext-proc + the bounded host roster. For a high-risk backend a terminating hop can be
   reintroduced for that host without changing the code-mode model.

---

## 9. Milestone gate

M13 passes when, end to end on a Kind cluster with the sandbox image, the generalized waypoint,
the in-mesh front-door, and the M7–M9 identity plane (including the per-user external-credential
store) deployed:

1. *"review PR 1990"* completes purely by the model running a sandbox script against the GitHub
   wrapper; `grep` confirms no token is present in the harness bundle, sandbox env, or prompt.
2. The GitHub credential is present **only** at the waypoint: red-team grep finds it absent from
   harness env, sandbox env, prompt, and every session-log entry, while the call still succeeds
   as the prompting user; each call produced an `egress-broker` audit entry with `subject` and
   `actor_spiffe_id`.
3. **Per-user, unattended:** two sessions bound to different subjects (bob, alice), with no live
   user token present, reach api.github.com with **distinct** stored grants; GitHub attributes
   bob's calls as bob and alice's as alice.
4. A deliberately runaway egress loop trips the hard cap (egress throws mid-script); a separate
   over-budget session ends via a clean turn-boundary `abort`.
5. A destination off the allowlist is refused; an expired/revoked grant surfaces an auth error
   into the script with **no silent fallback**.
6. **Unification demonstrated:** an MCP call and a GitHub call traverse the **same** waypoint
   code path, differing only in the resolver (mint vs. stored grant).

---

## 10. References

- [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2 spine, §3.2 sandbox egress, §4.1 invariants, M7–M9 credential plane.
- [M10 — MCP via Code-Mode in the Sandbox](2026-06-18-m10-mcp-code-mode-design.md) — the MCP path this design generalizes (D5 transparent waypoint; §5 credential/identity model; §5.3 placeholder-swap; §5.4 env-injection complement; D3 audit producer; D4 budget).
- [M2 Design — K8sSandboxClient](2026-06-17-m2-k8s-sandbox-client-design.md) — Operations redirection to the pod (the path code-mode rides).
- [M4 Design — Knative Serverless Wrapper](2026-06-17-m4-knative-serverless-wrapper-design.md) — `runTurn`, the budget voter this design widens.
- kagenti AuthBridge — `kagenti-extensions/AuthBridge`: RFC 8693 token exchange, SPIFFE JWT-SVID client assertion, Keycloak; placeholder-swap design; actor-token chaining noted unwired (the M7/M8 build).
- OpenShell credentials-keycloak — UDS gRPC credentials driver, env-injection pattern (the escape-hatch complement, §5.3).
- Istio — `ServiceEntry` + `DestinationRule` TLS origination (the in-mesh front-door for external hosts).
- RFC 8693 — OAuth 2.0 Token Exchange (`subject_token`, `actor_token`, `audience`; §4.1 delegation chaining).
- Anthropic, "Code execution with MCP: building more efficient agents" (Nov 2025) — the progressive-disclosure + filter-in-code pattern this design extends beyond MCP.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
