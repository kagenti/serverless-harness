# M6 Experiment Results

## E2 — local reconstruction cost (openFromCheckpoint vs openFromBackend)

Synthetic sessions, each compacted once with a fixed kept tail. Metric = entries + bytes
returned by `backend.read()` during reconstruction (the slice each loader rebuilds from).
`*` ms columns are wall-clock on a dev box — **illustrative only**; the gate is the
deterministic entries ratio.

| N (session len) | backend entries | checkpoint entries | ratio (b/c) | backend bytes | checkpoint bytes | backend ms* | checkpoint ms* |
|---|---|---|---|---|---|---|---|
| 50 | 53 | 6 | 8.8 | 7482 | 896 | 0.9 | 1.0 |
| 200 | 203 | 6 | 33.8 | 28508 | 901 | 1.4 | 1.6 |
| 1000 | 1003 | 6 | 167.2 | 140908 | 901 | 5.7 | 5.9 |
| 5000 | 5003 | 6 | 833.8 | 706909 | 906 | 22.7 | 20.9 |

**Pass:** checkpoint entries stay ~constant (bounded by the kept tail) while backend entries
grow linearly with N, so the backend/checkpoint ratio strictly increases with N. `buildSessionContext()`
is identical under both loaders at every N.

## E5 — budget-voter enforcement

Verified by `e5-budget-structural.test.ts` (no key, real Redis): once per-turn spend exceeds
`SH_BUDGET_TOKENS`, the `tool_call` is blocked and exactly one `abort` entry is persisted;
with the cap unset the voter is inert (no block, no `abort`). A key-gated live run
(`e5-budget-live.test.ts`, tiny cap) confirms the same end-to-end with a real model. See
`README.md` for how to run the live variant.

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
