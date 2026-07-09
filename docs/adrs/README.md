# Architecture Decision Records (ADRs)

This directory is the **permanent decision spine** of the harness. An ADR captures **one
significant decision** — the context that forced it, the choice made, and the consequences
we accepted — in a form that stays true even as the code around it changes.

## What an ADR is (and isn't)

| | ADR | Spec (`../specs/`) | Plan (`../plans/`) |
|---|---|---|---|
| Answers | *what we decided & why* | *what & why, in depth* (alternatives, trade-offs, deferred) | *how, in what order* |
| Size | short (one decision) | long (a whole design) | a checklist |
| Retention | **permanent, immutable** | committed, point-in-time | **local-only, ephemeral** |
| On change | write a **new** ADR that supersedes | add a `Status:` header, don't rewrite | delete once coded |

An ADR is deliberately small: it records the *decision*, not the *design*. The full design
lives in a dated spec under [`../specs/`](../specs/); the ADR links to it. Use an ADR when a
choice is (a) hard to reverse, (b) cross-cutting, or (c) likely to be questioned later ("why
Connect instead of raw gRPC?", "why is the harness filesystem-free?").

## Rules

1. **Immutable.** Once accepted, an ADR is never edited except to change its `Status` line
   (e.g. to `Superseded by ADR-0007`). To change a decision, write a **new** ADR that
   references and supersedes the old one. The record of *why we once thought otherwise* has
   value.
2. **Numbered, monotonic.** Files are `NNNN-kebab-title.md`, zero-padded, next free number.
   Numbers are never reused.
3. **One decision per ADR.** If you're recording two, write two.
4. **Link to the spec.** The ADR states the decision; the spec carries the reasoning.

## Status vocabulary

`Proposed` → `Accepted` → `Superseded by ADR-NNNN` (or `Deprecated`). Same vocabulary as
specs (see [`../specs/README.md`](../specs/README.md#documentation-lifecycle)).

## Creating one

```sh
cp docs/adrs/0000-adr-template.md docs/adrs/NNNN-your-decision.md
# fill in Context / Decision / Consequences; set Status: Accepted; link the spec
```

---

*Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>*
