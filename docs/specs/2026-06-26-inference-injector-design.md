# Inference Injector Design — the harness's provider-key chokepoint

Version: 1.0 — June 26, 2026
Status: Design (approved for implementation planning)
Scope: The **inference injector** — the small, shared, trusted gateway that holds LLM provider keys
so the harness doesn't, terminates the harness's mutually-authenticated in-cluster hop, sets the
real provider credential, and originates TLS to the provider. It is the **one component with public
internet egress**, which is what makes the harness's default-deny NetworkPolicy enforceable. v1 is a
**pure injector**: hide the key, be the egress chokepoint, emit audit metadata. No budget
enforcement, no body inspection, no token-exchange, no placeholder-swap.
Milestone relationship: **The M8 piece** of the re-examined credential plane — the injector the
harness lock-down (this date's sibling) depends on. Refines parent §3.1 from a same-pod sidecar to a
**separate shared gateway pod** (the NetworkPolicy-granularity reason, harness-lockdown H6).
Parent design: [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2.2 the harness-holds-no-key claim, §3.1 inference broker, §4.1 log invariants, §2.3 portable-core/kagenti-binding split.
Depends on / pairs with: [Harness Lock-Down Design](2026-06-26-harness-lockdown-design.md) — H4 (key not in harness; non-secret base URL), H5 (only the injector has public egress), H6 (separate pod), §8 (the injector is the high-value target this spec must own).
Sibling: [M13 — Generalized Credentialed Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — the **sandbox**'s egress plane. This injector is deliberately *not* that: no baked CA, no placeholder-swap, no allowlist-per-host policy.

> **Why this is light.** The harness explicitly points its provider base URL at the injector, so
> there is **no deception and no TLS interception** (contrast M13's sandbox forward proxy + baked
> CA). The injector is a path-preserving host+auth rewrite for a small static set of providers —
> not a policy engine. The zero-trust property it delivers ("the harness holds no key") comes from
> *where the key lives*, not from elaborate request mediation.

---

## 1. Goal & scope

### Goal

Let the harness perform inference **without ever holding a provider key**, and confine LLM provider
egress (the one public-internet destination in the whole harness path) to a single trusted,
non-model-influenced component — so the harness lock-down's default-deny egress boundary is real.

### In scope

- A **shared, long-lived inference-gateway Deployment** (separate pod, parent option (b)).
- **Multi-provider** support via a **static provider table** (upstream host + auth scheme + key
  Secret ref per provider), selected **per request by a header** (`x-sh-provider`).
- **Credential handling:** strip any client-supplied auth; set the real provider credential from a
  Secret mounted only to the injector; originate fresh TLS to the provider.
- **mTLS (v1):** mutually-authenticated harness↔injector transport; the injector authorizes only
  known harness workload identities. kagenti binding: Istio ambient + SPIRE.
- **Streaming** (SSE) pass-through — the one correctness gotcha.
- **Audit metadata** per call (session, provider, model id, sizes, status, timestamp) — never the
  key, never the request/response body.
- The **portable-core + kagenti-binding** split (§2.3 parent).

### Out of scope (later / separate)

- **Inference budget enforcement.** Stays with the existing turn-boundary voter (M5/M6). A
  per-session hard cap is a documented upgrade (§13), not v1.
- **SPIRE-bound key fetch.** v1 uses a static Secret at rest in the injector; SPIRE-gated
  short-lived-credential fetch is the upgrade (§13). (Most LLM providers issue static keys, so this
  likely reduces to a SPIRE-gated vault fetch, not true token exchange.)
- **Body parsing / token-accurate accounting.** v1 records sizes + status only; token-accurate usage
  (which requires reading the response `usage`) lands with the budget-cap milestone that needs it.
- **The sandbox egress plane** (M13), **MCP** (M10), **subagents** (M11).
- **Deep per-provider wire-protocol bridging** (e.g. a Gemini wire-id bridge, noted deferred
  elsewhere). v1 handles auth placement per provider; it does not translate request schemas.

---

## 2. Threat model & position

### 2.1 What the injector is

**Trusted code that is NOT influenced by model output.** It does not build prompts, parse model
output, or run model-authored code. It transits an inference request whose *body* originated in the
harness (and ultimately reflects model/context content), but it treats that body as **opaque
bytes** — it neither inspects nor logs it. Its only inputs it acts on are the routing header and the
peer identity.

### 2.2 Assets & why it is the high-value target

The harness lock-down (§8) names the injector the high-value target by design — concentration is the
cost of the clean boundary:

| Asset | Exposure |
|---|---|
| **Provider keys** (all providers) | At rest in the injector pod's Secret mounts; the single rotation/audit point. |
| **Public internet egress** | The only component allowed to reach the provider hosts on `:443`. |
| **Prompt bodies in transit** | It transits every inference request — same visibility the provider already has. Retains **none** of it (§7, §8). |

### 2.3 What it defends — and what it does not

**Defends (structurally):**
- The key never enters the harness, so it can never reach the durable log (parent §4.1). Achieved by
  *where the key lives*, mTLS-gated access, and the injector always overwriting client auth.
- Exfil to arbitrary hosts from the harness path: the injector forwards only to the static provider
  upstreams (its own egress allowlist); the harness pod has no other public route (lock-down H5).

**Does NOT defend (honest residue):**
- **A live-compromised harness can use the injector** — it holds a valid mTLS identity, so it can
  ask the injector to proxy provider calls while it is alive. The injector hides the *raw key*, not
  *use* of it. `x-sh-session` is attribution, **not** an authorization control.
- **A compromised injector is game over** for keys — it is the concentration point. Mitigations:
  trusted code, minimal surface, no body retention, mTLS-gated ingress, least-privilege, rotation.

### 2.4 Trust boundary

```
 harness pod (no key, default-deny egress)        injector pod (trusted, NOT model-influenced)
 ┌───────────────────────────────┐               ┌──────────────────────────────────────────────┐
 │ LLM client                    │  mTLS (SPIRE)  │ • authorize peer SPIFFE id (known harnesses)   │
 │  base URL = injector          │═══════════════▶│ • route on x-sh-provider → provider table      │
 │  x-sh-provider: anthropic     │   in-cluster   │ • STRIP client auth; SET real provider cred    │
 │  x-sh-session: <id>           │                │ • path-preserving, STREAMING reverse proxy     │
 │  body = provider-native       │                │ • audit metadata (no key, no body)             │
 └───────────────────────────────┘               └───────────────────────┬────────────────────────┘
                                                       real TLS, :443 ─────▼ (ONLY public egress in the path)
                                                                    api.anthropic.com / api.openai.com / …
```

---

## 3. Key decisions

| # | Decision | Choice |
|---|----------|--------|
| I1 | Form | **Minimal purpose-built reverse proxy** (e.g. Go `httputil.ReverseProxy`). Portable core, no mesh dependency; owns streaming + audit. (Envoy and AuthBridge-reuse considered and rejected as heavier for this job.) |
| I2 | Topology | **One shared, long-lived gateway Deployment** (separate pod, parent option (b)); stateless in v1 → multi-replica trivially; not scale-to-zero (stable egress point). |
| I3 | Provider breadth | **Multi-provider via a static provider table.** Each entry: upstream host, auth scheme (location + name + format), key Secret ref. |
| I4 | Provider selection | **Per-request header `x-sh-provider`.** The harness knows its provider (`SH_MODEL_PROVIDER`) and sets the header; unknown value → `400`. |
| I5 | Credential placement | **Static K8s Secret(s) mounted only to the injector pod.** Never in the harness. SPIRE-bound fetch is the documented upgrade (§13). |
| I6 | Credential handling | **Strip then set.** The injector removes any client-supplied auth (`Authorization`, `x-api-key`, `x-goog-api-key`, version headers it owns) and sets the real credential, so the harness cannot influence or smuggle it. |
| I7 | Harness↔injector transport | **mTLS in v1.** Mutually authenticated; injector authorizes known harness SPIFFE identities. kagenti binding: Istio ambient + SPIRE. NetworkPolicy is defense-in-depth, not the sole control. |
| I8 | Provider TLS | **Injector originates fresh TLS** to the real provider. **No baked CA, no interception** — the harness explicitly targets the injector, so there is no deception (contrast M13). |
| I9 | Body handling | **Opaque, streaming, path-preserving.** Bodies and request paths pass through unmodified; the injector mutates only headers + upstream host. No body parse, no body log. |
| I10 | Budget | **None in v1.** Turn-boundary voter (M5/M6) keeps it. Hard per-session cap is the upgrade (§13). |
| I11 | Audit | **Metadata only:** session, provider, model id (from the `x-sh-model` header, so the body stays opaque), request/response sizes, status, timestamp. Never key, never body. |

---

## 4. Request path (detail)

1. Harness LLM client is configured with **base URL = injector** and **default headers
   `x-sh-provider: <provider>`** (from `SH_MODEL_PROVIDER`), **`x-sh-model: <model>`** (from
   `SH_MODEL`, for audit without a body parse), and **`x-sh-session: <id>`**. It sends the
   provider-native request (e.g. `POST /v1/messages` with the provider's body) over **mTLS**.
2. Injector **authorizes the peer** (SPIFFE id ∈ known harnesses) — else reject.
3. Injector reads `x-sh-provider`, looks up the **provider table** — unknown → `400`; known but key
   Secret missing → `502` + audit.
4. Injector **strips client auth headers** and **sets the real credential** per the entry's auth
   scheme (header or query-param; see §5), preserving the request **path** and **body** verbatim.
5. Injector **originates fresh TLS** to the upstream host and **streams** the response back chunk by
   chunk (SSE-safe, §7).
6. Injector appends **one audit metadata record** (§8). The harness receives a normal
   provider-shaped response; Pi is unchanged.

---

## 5. Provider table & credential schemes

A static config (ConfigMap + Secret refs), one entry per logical provider:

```
anthropic: { host: api.anthropic.com, auth: {loc: header, name: x-api-key,        fmt: "{key}"},        extra: {anthropic-version: "2023-06-01"}, secret: anthropic-key }
openai:    { host: api.openai.com,    auth: {loc: header, name: Authorization,     fmt: "Bearer {key}"},                                            secret: openai-key   }
gemini:    { host: generativelanguage.googleapis.com, auth: {loc: header, name: x-goog-api-key, fmt: "{key}"},                                       secret: gemini-key   }
```

- **Auth `loc` generalizes placement** — `header` or `query` — because providers differ (Anthropic
  `x-api-key`, OpenAI `Authorization: Bearer`, Gemini `x-goog-api-key` or a `?key=` query param).
  The table, not code branches, encodes the difference.
- **`extra`** carries non-secret required headers (e.g. `anthropic-version`).
- Keys are **mounted, not embedded**: each `secret` ref is a K8s Secret mounted to the injector pod
  only; the table holds the *reference*, never the value.

---

## 6. Harness↔injector trust (v1: mTLS)

- **Transport:** mutually-authenticated TLS. **kagenti binding:** Istio ambient provides the mTLS;
  an `AuthorizationPolicy` restricts ingress to the injector to the harness workloads' SPIFFE
  principals (SPIRE-issued). **Portable core:** the contract is "mTLS + identity-based authz"; a
  non-kagenti cluster supplies its own mutual-TLS mechanism.
- **NetworkPolicy (defense-in-depth):** only harness pods may reach the injector; the injector's
  egress is allowed only to the provider upstream hosts. mTLS authorizes *who*; NetworkPolicy bounds
  *reachability* — both, not either.
- **`x-sh-session` is attribution, not authorization.** It feeds audit (and the future budget cap).
  A valid-mTLS harness is trusted to *use* inference; the session header does not gate that (§2.3
  residue).

---

## 7. Streaming & body handling (correctness)

LLM responses stream via SSE; the injector **must flush chunks as they arrive and never buffer the
full body**, or it breaks token streaming and time-to-first-token. Go's `httputil.ReverseProxy`
streams by default (disable response buffering; ensure `FlushInterval` is set for SSE). The body is
**opaque**: not decoded, not logged, not modified. This keeps the injector a pure transit and holds
the "retains no prompt content" property (§2.2, §8).

---

## 8. Audit

The injector emits **one metadata record per inference call** — enough to attribute and later
budget, with zero secret/content exposure:

```
via         = "inference-injector"
provider    = "anthropic"
model       = "<x-sh-model>"              // header, so the body stays opaque (§7)
session     = "<x-sh-session>"            // attribution
actor        = "<peer SPIFFE id>"          // who called
req_bytes / resp_bytes / status / ts
```

Never present: the provider key, the request body, the response body. (Token-accurate counts require
reading `usage` from the body and arrive with the budget-cap milestone, §13.)

Where these records go (stdout/structured log vs. the session stream) follows the existing audit
sink; they are **not** written into the secret-free Redis session log as content (parent §4.1).

---

## 9. Failure modes

- **Unknown `x-sh-provider`** → `400`, audit `status=rejected`.
- **Known provider, key Secret missing/unreadable** → `502`, audit; no fallback to another
  provider/key.
- **Peer fails mTLS / unknown SPIFFE id** → connection refused; nothing forwarded.
- **Provider 5xx / timeout** → passed through to the harness; retry/backoff is Pi's concern, not the
  injector's.
- **Injector down** → harness inference fails (no key anywhere else = fail-closed). Mitigated by
  multiple replicas (I2).
- **Client tries to smuggle its own auth** → stripped (I6); only the injector's credential reaches
  the provider.

---

## 10. Availability & observability

- **Stateless in v1** → horizontal scale, rolling updates, no shared state. (The future budget cap
  needs cross-replica counters → Redis; noted in §13.)
- **Warm, not scale-to-zero** — it is the stable egress point; cold-starting it on every harness wake
  would add latency to the first inference. Cheap to keep one replica warm.
- **Metrics:** per-provider call counts, statuses, latencies, in-flight streams. No content metrics.

---

## 11. Verification gate

The injector passes when, on a Kind cluster with the locked-down harness deployment + the injector:

1. **Inference works end-to-end** with the harness holding **no provider key**: a turn completes;
   red-team `grep` finds the key absent from harness env, prompt, and the Redis log, present only in
   the injector pod.
2. **Multi-provider routing:** requests with `x-sh-provider: anthropic` vs `openai` reach the correct
   upstream with the correct auth scheme; an unknown provider yields `400`.
3. **Strip-then-set:** a harness request carrying a bogus client `Authorization`/`x-api-key` still
   succeeds, and a capture at the upstream shows **only** the injector's credential (the bogus one is
   gone).
4. **mTLS gate:** a caller without a valid known harness SPIFFE identity is refused; a known harness
   succeeds.
5. **Streaming:** a streamed (SSE) completion arrives at the harness incrementally (first chunk well
   before completion), proving no full-body buffering.
6. **Egress confinement:** the injector can reach the provider hosts and **nothing else** on the
   public internet; the harness can reach the injector and **nothing** public (lock-down H5 holds
   with the injector in place).
7. **Audit:** each call produced an `inference-injector` record with provider/session/actor/sizes/
   status and **no** key or body.

---

## 12. Consequences & trade-offs (recorded honestly)

1. **Concentration is the cost of the clean boundary.** All keys + all public egress + transient
   prompt visibility live in one component. Justified because it is small, trusted, not
   model-influenced, and the single rotation/audit point — but it is the thing to guard hardest.
2. **`use` vs. `exfiltrate` residue (inherited).** A live-compromised harness can drive inference via
   its mTLS identity. The injector bounds raw-key leakage, not use. A real fix needs harness process
   attestation (out of scope).
3. **Static key at rest (v1).** The injector holds long-lived provider keys in Secrets. Accepted for
   v1; SPIRE-bound short-lived fetch is the upgrade (§13).
4. **We maintain proxy code.** Choosing a purpose-built injector (I1) means owning streaming
   correctness and header hygiene. Mitigated by how small it is and the explicit streaming test
   (gate 5).
5. **One extra in-cluster hop** on inference — negligible vs. provider round-trip, and it buys the
   enforceable network boundary (lock-down H6).
6. **Provider auth drift.** Provider auth schemes/versions change; the static table localizes that to
   config, but it must be maintained (e.g. `anthropic-version`).

---

## 13. Upgrade path (recorded, not built)

- **Per-session hard budget cap.** Add a kill-switch on inference calls/tokens keyed by
  `x-sh-session`, complementing the turn-boundary voter (mirrors M13's hard-cap/soft-budget split).
  Requires token-accurate accounting (read `usage` from the streamed response) and cross-replica
  counters (Redis). It is a **cost guard**, not a containment control (§2.3).
- **SPIRE-bound credentials.** Replace the static Secret with a SPIRE-gated fetch of a short-lived
  provider credential via the identity plane, so the injector holds no long-lived key at rest. Likely
  a SPIRE-gated vault fetch given providers issue static keys.
- **Per-provider rate/cost policy** and **richer egress allowlisting** if the provider set grows.

---

## 14. References

- [Harness Lock-Down Design](2026-06-26-harness-lockdown-design.md) — H4/H5/H6 and §8: the dependencies and the high-value-target charge this spec answers.
- [Zero-Trust, Multi-Agent Extensions](../../../docs/research/2026-06-18-zero-trust-multiagent-harness-extension.md) — §2.2 harness-holds-no-key, §3.1 inference broker (placement refined to a separate pod), §2.3 portable-core/kagenti-binding, §4.1 log invariants.
- [M13 — Generalized Credentialed Egress](2026-06-19-m13-generalized-credentialed-egress-design.md) — the sandbox egress plane this injector is deliberately lighter than (no CA, no placeholder-swap).
- [M5 — Compaction-Checkpoint](2026-06-23-m5-compaction-checkpoint-design.md) / [M6 — Experiments](2026-06-24-m6-experiments-design.md) — the turn-boundary budget voter that keeps inference budget in v1.
- kagenti: Istio ambient (ztunnel mTLS, `AuthorizationPolicy` SPIFFE principals), SPIRE/SPIFFE workload identity.
- Provider auth references: Anthropic (`x-api-key` + `anthropic-version`), OpenAI (`Authorization: Bearer`), Gemini (`x-goog-api-key` / `?key=`).

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
