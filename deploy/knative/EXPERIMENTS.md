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
