---
description: Use to retire a spec, plan, quick or session for good with everything it exclusively owns. `aw discard` resolves the closure from sealed provenance, previews it whole and applies it all-or-nothing on one approval. Never rewrites git history.
argument-hint: "<spec:NNN | plan:PPP | quick:NNN | session:NNN|carpeta | ruta>"
allowed-tools: ["Bash", "Read"]
---

# discard — retire work and everything it exclusively owns

No loop, no session — the closure can include the session that would be driving it.
Output in the **user's language**.

**Hard floor:**

1. **`prepare` first, always** — read-only: no session, no journal, no file, no ref,
   so a wrong target costs nothing.
2. **You never decide the scope.** It comes from sealed custody and each document's
   `Derived from`; a descendant nobody can prove is a REFUSAL, not a guess.
3. **One approval, over the exact digest.** `apply` recomputes under the workspace
   lock and refuses if anything material moved. Approving is not applying.
4. **Reverts are commits, never rewrites** — no `reset --hard`, rebase, amend, force
   or push; a published commit's revert leaves its push pending and external.

## Run

1. `aw discard prepare <objetivo> --format human` — what disappears, which local
   change is dropped, which SHA gets a revert, which unit is reconciled, which
   `HISTORY` row it adds, and the **digest**.
2. Show that preview and ask approval. If it touches git history, say so: approving
   also authorizes commits.
3. `aw discard apply <objetivo> --approval <digest> --format human`.
4. A rejection names cause, candidates and next action; **nothing was applied**.
   `024` resolves only while one node answers to it.

## What the CLI decides (do not re-derive)

- **The closure**, in removal order; a node something outside also descends from
  blocks the whole operation.
- **Attribution** of changes and commits, from baselines and receipts — never from a
  message, an author or a tag.
- **Whether all-or-nothing holds**: two publication units, a conflicting revert, an
  operation in progress or an unsyncable tree block before anything mutates.
- **What survives**: the originals stay reachable and the only durable Workline trace
  is one append-only `HISTORY` row.

## More context

`aw context-plan --command discard --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` lists what to read.

- Back to before an **incomplete** session instead: `/w:reset`.
