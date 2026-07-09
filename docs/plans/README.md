# Implementation plans (local-only, gitignored)

Plans that describe **how** to build something — ordered steps, checklists, task
breakdowns — live here **on your machine only**. Everything in this directory except this
README is gitignored (see the repo `.gitignore`).

## Why plans aren't committed

A plan answers *how, in what order*. The moment the code merges, the code becomes the source
of truth for *how* — the plan is now a stale, lower-fidelity copy. The durable value of our
docs is the ***why***: the decisions and rejected alternatives. Those live in:

- **[`../specs/`](../specs/)** — dated design docs (*what & why*, in depth).
- **[`../adrs/`](../adrs/)** — permanent decision records (*one decision + consequences*).

So a plan's whole life is: write it → execute it → **delete it**. Committing it would just
create a maintenance burden that goes stale and misleads.

## Workflow

1. Write your plan here: `docs/plans/YYYY-MM-DD-<topic>.md` (named for the spec it implements).
2. Execute it.
3. Delete it once the work is coded and merged. The matching spec + the code carry everything
   that remains true.

New plans authored via the writing-plans workflow land here by convention.

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
