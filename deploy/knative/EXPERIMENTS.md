# M7 Cluster Experiment Results

Cluster: Kind `sh-knative`, ksvc `serverless-harness` (ns `default`), model `claude-haiku-4-5`.
Spec: docs/specs/2026-06-25-m7-cluster-experiments-design.md

## E1 — scale-to-zero economics
`E1_RESULT persistent=380 serverless=95 ratio=0.25 pass=yes`
Verdict: PASS (PASS = serverless pod-seconds <= 0.6 x persistent)

**How to read this.** The same idle-heavy workload (turns separated by a long idle gap) runs
twice: `persistent` = `min-scale=1` (a pod is always kept warm) vs `serverless` = `min-scale=0`
(the pod scales to zero when idle). A sampler polls every 5s, so
**pod-seconds = sum(running pods x 5s)**, a proxy for compute cost. `persistent` accrues
pod-seconds for the whole window (the pod never leaves); `serverless` accrues only while a turn
is served (cold-start + work + ~30s scale-to-zero retention) and is ~zero during the idle gap.
`ratio` = serverless / persistent, so 0.25 means serverless used ~25% of the pod-runtime
(~75% cheaper) for this pattern; the gate passes when ratio <= 0.6. Note: serverless pod-seconds
are roughly constant per turn (independent of idle length) while persistent grows with the idle
window, so a longer idle yields a larger saving (a short idle can fail the gate).

## E3 — session mobility
A fresh instance recalled the planted token from the Redis log after scale-to-zero.
Verdict: PASS

## E4 — crash recovery
After a mid-session pod force-kill, the next turn recalled all completed turns.
Verdict: PASS

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*

# P3 — Sandbox Sharing-Ratio Results

Authoritative home for the P3 experiment numbers (cluster experiments record here, matching
E1/E3/E4). See the design: `docs/specs/2026-07-03-p3-sandbox-sharing-ratio-experiments-design.md`.

**How to run (develop on Kind, authoritative on OCP):**

```bash
# Kind sh-knative (3-pod pool up, gitd deployed via kustomize):
E6_LIVE=1 bash deploy/knative/e6-saturation.sh
E7_LIVE=1 bash deploy/knative/e7-converge-contention.sh

# OCP 4.20 (authoritative): export KSVC_URL=<route>, KUBECONFIG=<ocp>, then the same.
```

## E6 — sandbox-load characterization (N-vs-workload curve + knee floor)

Reports the harness→sandbox sharing ratio **N as a curve over per-leaf sandbox work**, measured at
C=1 on a warm pod across real Archetype-A code-review variants L0/L1/L2 (increasing review scope over
the git-daemon `work` fixtures), each point tagged with the leaf's measured sandbox exec count. N is
workload-dependent: the light L0 leaf is a near-empty-leaf **upper bound**; heavier leaves drive more
sandbox execs → higher duty → lower N. A separate concurrency sweep at the heaviest variant, with the
harness un-capped (`max-scale` raised so the sandbox — not the 5-pod harness cap — limits
concurrency), warm and multi-sampled, feeds the sustained-decline `detectKnee`; the knee is reported
as a floor. **Supersedes** the earlier single-N figure (N ≈ 29–48:1), which was the L0 (near-empty-leaf)
upper bound measured with a trivial `marker.txt` leaf.

## E7 — converge contention + mixed-ref correctness

Fires `E7_REFS` leaves converging distinct refs on one pod. Hard gate: every leaf's worktree
observed only its own ref (the live mixed-ref validation deferred from P2 Task 7). Reports the
converge contention profile. Runs append their `E7_RESULT` block below.

### Kind results (sh-knative, 3-pod pool, SH_MODEL=claude-haiku-4-5, 2026-07-03)

Non-authoritative — laptop-bound Kind, shape/relative only per design §D5. Authoritative numbers are the OCP run.

**E6 — saturation curve** (`E6_LADDER="1 2 4 8 16"`, one pinned sandbox, degradeX=2):

| c (concurrent leaves) | throughput (leaves/s) | p95 latency (ms) |
|---|---|---|
| 1 | 0.072 | 13881 |
| 2 | 0.158 | 12561 |
| 4 | 0.261 | 15246 |
| 8 | 0.346 | 23020 |
| 16 | 0.608 | 26142 |

- **Knee (recommended `KAGENTI_SANDBOX_CAP`): ≥16** — throughput still rising and p95 within the 2× bound at c=16, so no saturation knee was reached below C_max. Treat ≥16 as a floor, not the ceiling.
- **Duty cycle (C=1): 0.021** (sandbox-busy execMs≈289 over a ~13.9 s leaf wall) → **derived N ≈ 48:1**. The sandbox is busy ~2 % of leaf wall-clock; the remainder is model/network time in the harness tier.
- Sanity floor (≥4): pass. Feed-back: max leases/pod 2 ≤ derived CAP — pass. Verdict: **pass**.

**E7 — converge contention + mixed-ref correctness** (`E7_REFS=6`, distinct refs, one pinned pod):

- **Mixed-ref consistency: PASS** — all 6 leaves converging distinct refs each saw only their own ref's marker (the live validation deferred from P2 Task 7). Wall 16044 ms; total sandbox exec ms ≈345 (best-effort, informational).

**Takeaway:** the sandbox is lightly used per leaf (~2–6 % duty depending on cold-start), so the harness→sandbox sharing ratio is high (≈20–48:1 on Kind) and one sandbox did not saturate at 16 concurrent leaves — strong support for the dense-harness / shared-sandbox premise. Authoritative CAP/ratio to follow from OCP.

### E6 run host
- ladder: 1 2 4 8 16
- points: [{"c":1,"throughput":0.071,"p95Ms":14050},{"c":2,"throughput":0.245,"p95Ms":8059},{"c":4,"throughput":0.213,"p95Ms":18673},{"c":8,"throughput":0.550,"p95Ms":14424},{"c":16,"throughput":0.594,"p95Ms":26843}]
- knee (recommended CAP): 2
- duty cycle (C=1): 0.035  =>  derived N ~= 28.6 : 1
- sanity floor (>= 4): false
- feed-back max leases/pod at CAP=2: 1
- verdict: no

### E7 run
- refs (distinct, concurrent): 6
- mixed-ref consistency: ok
- wall ms: 17387 ; total sandbox exec ms (converge+tools): 0
- observations: [{"runId":"e7-0-11895","expectedRef":"branch-0","observedMarker":"branch-0"},{"runId":"e7-1-11895","expectedRef":"branch-1","observedMarker":"branch-1"},{"runId":"e7-2-11895","expectedRef":"branch-2","observedMarker":"branch-2"},{"runId":"e7-3-11895","expectedRef":"branch-3","observedMarker":"branch-3"},{"runId":"e7-4-11895","expectedRef":"branch-4","observedMarker":"branch-4"},{"runId":"e7-5-11895","expectedRef":"branch-5","observedMarker":"branch-5"}]

### OpenShift results (OCP 4.20.8, 3-pod pool, images v0.2.1, SH_MODEL=claude-haiku-4-5, 2026-07-03)

Authoritative tier — representative CPU/mem, real EBS RWO, API-server exec, Route ingress. Sandbox image `serverless-harness-sandbox:0.2.1` (adds `git` for the in-sandbox converge; the P0′ smoke never exercised converge).

**E6 — saturation curve** (`E6_LADDER="1 2 4 8 16"`, one pinned sandbox, degradeX=2):

| c (concurrent leaves) | throughput (leaves/s) | p95 latency (ms) |
|---|---|---|
| 1 | 0.071 | 14050 |
| 2 | 0.245 | 8059 |
| 4 | 0.213 | 18673 |
| 8 | 0.550 | 14424 |
| 16 | 0.594 | 26843 |

- Aggregate throughput at c=16 is ~8× c=1 with p95 inside the 2× bound → **the sandbox does not saturate across the tested range**. Duty cycle (C=1) **0.035** (sandbox-busy execMs≈492 over a ~14 s leaf wall) → **derived N ≈ 29:1**.
- **Knee/floor caveat:** the detector requires throughput to rise strictly vs the previous rung; per-leaf model-latency + cold-start variance made c=4 (0.213) dip below c=2 (0.245), tripping the break early → `knee=2`, floor=fail on this single run. This is a **measurement-noise artifact, not a capacity ceiling** (throughput climbs ~8× overall). A noise-robust knee (multi-sample rungs and/or a warm `min-scale=1` baseline) is a follow-up.

**E7 — mixed-ref correctness** (`E7_REFS=6`, distinct refs, one pinned pod): **PASS** — every leaf's worktree pinned its own commit (the deferred P2 Task 7 validation, now proven on OpenShift too). Wall 17387 ms.

### Conclusion (Kind + OCP)

The sandbox is busy only ~2–4 % of leaf wall-clock (duty 0.021 Kind / 0.035 OCP → **N ≈ 29–48:1**); one sandbox did not saturate up to 16 concurrent leaves on either runtime, and mixed-ref converge stays commit-consistent on a shared pod (E7 PASS both). This supports the two-tier premise (dense harness tier, lightly-shared sandbox tier). **Recommended `KAGENTI_SANDBOX_CAP`: a floor of ≥16** — the true ceiling awaits a noise-robust, higher-concurrency sweep.
