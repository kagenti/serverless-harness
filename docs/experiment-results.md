# Serverless Harness — Experiment Results (E1–E5)

*Consolidated findings, June 2026. Source data: `experiments/RESULTS.md` (E2, E5),
`deploy/knative/EXPERIMENTS.md` (E1, E3, E4). Designs: `docs/specs/2026-06-{23,24,25}-*.md`.*

## The thesis under test

The serverless harness runs a [Pi](https://github.com/earendil-works) coding agent as a
**scale-to-zero** Knative service over an **externalized session log** (Redis Streams) and a
**remote sandbox**, so a session is durable infrastructure rather than a long-lived process.
The five experiments test whether that architecture pays off without breaking correctness:

| # | Claim | Verdict | Headline result |
|---|-------|---------|-----------------|
| **E1** | Scale-to-zero is cheaper than always-on for idle-heavy use | ✅ PASS | serverless **0.25×** the pod-seconds (~75% cheaper) |
| **E2** | Compaction-checkpoint keeps cold-start reconstruction O(tail), not O(total) | ✅ PASS | checkpoint reads **constant 6 entries** vs backend's 53→5003; ratio **8.8→833.8** |
| **E3** | A session is portable: a fresh instance reconstructs equivalent context from the log | ✅ PASS | fidelity (≡ full replay) + mobility (fresh pod recalled the planted token) |
| **E4** | Crash recovery is a byproduct of the externalized log | ✅ PASS | pod force-killed mid-session → next turn recovered all completed turns |
| **E5** | Per-turn token spend can be capped and enforced | ✅ PASS | tool call blocked + exactly one `abort` past the cap; inert when unset |

All five pass. Together they validate the economic case (E1), the optimization that makes
scale-to-zero practical at length (E2), the correctness guarantees that make it safe (E3, E4),
and an operational guardrail (E5).

---

## E1 — Scale-to-zero economics

**Claim.** For an idle-heavy workload, a scale-to-zero deployment consumes materially less
compute than an always-warm one.

**Setup (cluster, Kind `sh-knative`).** The same workload — turns separated by a long idle gap —
runs twice against the deployed ksvc: `min-scale=1` (persistent) vs `min-scale=0` (serverless).
A sampler polls running pods every 5s; **pod-seconds = Σ(running pods × 5s)** is the cost proxy.

**Result.** `persistent=380s`, `serverless=95s`, **ratio 0.25** — serverless used a quarter of
the pod-runtime (~75% cheaper). Gate: serverless ≤ 0.6 × persistent. **PASS.**

**Caveat / methodology.** Serverless pod-seconds are roughly *constant per turn* (cold-start +
work + ~30s scale-to-zero retention), independent of idle length, while persistent grows with the
window — so the saving widens with idle time. A short idle (≈120s) does **not** clear the gate
(ratio ~0.78); the result reflects a genuinely idle-heavy pattern. pod-seconds is a runtime proxy,
not a billing model. *Reproduce:* `deploy/knative/e1-economics.sh`.

## E2 — Local reconstruction cost (the compaction-checkpoint fast path)

**Claim.** On cold start, the M5 `openFromCheckpoint` loader reconstructs a session in **O(tail)**
(read only the latest-compaction-forward slice) rather than **O(total)** (full-log replay).

**Honest framing.** Pi's native compaction already bounds the *LLM* context, so this is **not** an
LLM-latency win — it is a **local** cost win (Redis read volume, indexing, the leaf→root walk).
E2 measures exactly that, in-process, with a counting backend.

**Result.** Across synthetic sessions of length N ∈ {50, 200, 1000, 5000}, `openFromCheckpoint`
reads a **constant 6 entries / ~900 bytes**, while `openFromBackend` reads the whole log
(53→5003 entries, 7.5KB→707KB). The backend/checkpoint ratio rises **8.8 → 33.8 → 167.2 → 833.8**,
and `buildSessionContext()` is byte-identical under both loaders at every N (correctness preserved).
**PASS.** *Reproduce:* `pnpm -C experiments test e2-reconstruction-cost`.

## E3 — Session fidelity + mobility

**Claim.** A session's state lives in the log, so any fresh instance can reconstruct *equivalent*
context — the basis for scale-to-zero and for moving a session between pods.

**Two halves.**
- **Fidelity** (M5): the checkpoint-reconstructed `buildSessionContext()` deep-equals a full
  replay — proven by the M5 parity gate (`checkpoint.test.ts`) and re-confirmed at every N in E2.
- **Mobility** (M7, cluster): plant a fact, force the pod to zero (confirmed gone), then a
  follow-up on a **fresh** pod recalled the planted token (`ZEBRA42`) from the Redis log.

**Result.** Both hold. **PASS.** *Reproduce:* `deploy/knative/e3-mobility.sh` (mobility);
`harness/test/checkpoint.test.ts` (fidelity).

## E4 — Crash recovery as a byproduct

**Claim.** Because completed turns are flushed to the log, force-killing the harness pod
mid-session loses no committed work.

**Setup (cluster).** Complete three turns (each flushed via `turn_end`), `kubectl delete pod
--force` mid-session, then issue a recovery turn on the freshly-started pod.

**Result.** The post-crash turn recalled all three planted facts (APPLE/BANANA/CHERRY) — zero
completed-turn loss. **PASS.** *Reproduce:* `deploy/knative/e4-recovery.sh`.

## E5 — Budget-voter enforcement

**Claim.** A per-turn token budget can be enforced — blocking further tool calls once breached.

**Setup.** With `SH_BUDGET_TOKENS` set, the voter meters per-turn spend (delta from the pre-turn
baseline) and blocks the next `tool_call` once over cap, appending one `abort` log entry.

**Result.** Over cap → tool call blocked and **exactly one** `abort` persisted to real Redis;
cap unset → inert (no block, no `abort`). A key-gated live run confirms the same end-to-end with a
real model. **PASS.** *Reproduce:* `pnpm -C experiments test e5-budget-structural` (gate);
`e5-budget-live.test.ts` (live, `SH_RUN_LIVE=1`).

---

## Methodology & credibility notes

- **Measure the right thing.** E2 deliberately measures local reconstruction cost, not end-to-end
  latency (which Pi's compaction already bounds) — the latter would mislead with "no effect."
- **The gates are deterministic where it matters.** E2's entries/bytes ratio and E5's exactly-one-
  `abort` assertion are deterministic; wall-clock columns are illustrative only.
- **Live runs earned their keep.** Running the cluster experiments against a real model + Kind
  surfaced three real defects that static review missed and that were then fixed at root cause:
  a `start_sampler` command-substitution hang, an E3 scale-to-zero fall-through (false-pass risk),
  and an orchestrator `set -e` abort that skipped result-writing. The passing results below were
  produced *after* those fixes, on green re-runs.

## How to reproduce everything

```bash
# In-process (no LLM key): E2 + E5 structural
docker run -d --rm --name sh-redis -p 6379:6379 redis:7-alpine
pnpm -C experiments test           # E2, E5 structural, fixtures
pnpm -C harness test               # checkpoint parity (E3 fidelity), budget unit, etc.

# Cluster (needs Kind+Knative deploy + gateway creds): E1, E3-mobility, E4
deploy/knative/run-experiments.sh  # setup + E1 + E3 + E4, writes deploy/knative/EXPERIMENTS.md
```

## Conclusion

The serverless harness delivers its thesis: **~75% lower idle cost (E1)** with **O(tail)
cold-start reconstruction (E2)**, while **preserving session fidelity and mobility (E3)**,
**recovering from crashes for free (E4)**, and **enforcing a token budget (E5)** — with no change
to the agent's own logic (Pi is forked only for the pluggable storage backend). This completes the
pi-track plan's E1–E5 experiment set.

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
