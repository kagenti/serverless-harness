# @sh/experiments — M6 experiments (E2 + E5)

In-process experiment runners for the serverless-harness. See
`docs/specs/2026-06-24-m6-experiments-design.md`.

## Prerequisites

```bash
docker run -d --rm --name sh-m6-redis -p 6379:6379 redis:7-alpine
```

## E2 + E5 structural (no LLM key — the pass gate)

```bash
pnpm -C experiments test
```

- E2 writes recorded results to `experiments/RESULTS.md` and asserts the
  checkpoint/backend read ratio grows with session length.
- E5 structural asserts the voter blocks + persists exactly one `abort` over cap,
  and is inert when the cap is disabled.

## E5 live (real model — manual, end-to-end)

Model + provider + credentials are runtime inputs; no secrets live in the repo.

```bash
export SH_MODEL_PROVIDER=anthropic
export SH_MODEL=claude-opus-4-8
export ANTHROPIC_AUTH_TOKEN=…              # (+ ANTHROPIC_BASE_URL=… for the litellm gateway)
export SH_RUN_LIVE=1 SH_BUDGET_TOKENS=1
pnpm -C experiments test e5-budget-live
```

### Tools (so the model has something to call)

The live run needs at least one registered tool so a `tool_call` fires and trips the
tiny cap. If the harness registers no tools without a sandbox, set
`KAGENTI_SANDBOX_POD=<pod>` (M2 sandbox) before running, or adjust the prompt to target
whatever built-in tool the `DefaultResourceLoader` exposes. The live run is **not** the
pass gate (the structural test is); it is the end-to-end confirmation.
