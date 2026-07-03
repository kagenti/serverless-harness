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

## E6 — saturation curve (→ CAP + derived N)

Pins one sandbox, sweeps concurrent leaves (`E6_LADDER`), reports the knee (recommended
`KAGENTI_SANDBOX_CAP`) and the C=1 duty cycle (→ derived N ≈ 1/duty). Hard gate: sanity
floor `knee >= E6_MIN_CONCURRENCY`. Feed-back: pool never exceeds the derived CAP. Runs
append their `E6_RESULT` block below.

## E7 — converge contention + mixed-ref correctness

Fires `E7_REFS` leaves converging distinct refs on one pod. Hard gate: every leaf's worktree
observed only its own ref (the live mixed-ref validation deferred from P2 Task 7). Reports the
converge contention profile. Runs append their `E7_RESULT` block below.
