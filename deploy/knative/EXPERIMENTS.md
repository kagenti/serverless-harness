# M7 Cluster Experiment Results

Cluster: Kind `sh-knative`, ksvc `serverless-harness` (ns `default`), model `claude-haiku-4-5`.
Spec: docs/specs/2026-06-25-m7-cluster-experiments-design.md

## E1 — scale-to-zero economics
`E1_RESULT persistent=380 serverless=95 ratio=0.25 pass=yes`
Verdict: PASS (PASS = serverless pod-seconds <= 0.6 x persistent)

## E3 — session mobility
A fresh instance recalled the planted token from the Redis log after scale-to-zero.
Verdict: PASS

## E4 — crash recovery
After a mid-session pod force-kill, the next turn recalled all completed turns.
Verdict: PASS

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
