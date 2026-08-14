---
description: Use to undo an incomplete session and put its document back as it was before that session ran. `aw reset` restores the inputs byte for byte and retires the session, all-or-nothing on one approval. Never rewrites git history.
argument-hint: "<plan:PPP | session:NNN|carpeta | ruta>"
allowed-tools: ["Bash", "Read"]
---

# reset — put an incomplete session's inputs back

No loop, no session. Output in the **user's language**. It is **not**
`/w:plan-refine`: refining carries a document forward keeping validated phases, this
takes it back to the bytes it had before the session started.

**Hard floor:**

1. **`prepare` first, always** — read-only, so a wrong target costs nothing.
2. **Only an INCOMPLETE session.** One that converged does not become resettable by
   being selected, and `.closed` is never the test: a session closed with work
   pending is exactly this case.
3. **The target must resolve to ONE incomplete session**; two is a rejection with its
   candidates, and then you name the session.
4. **One approval, over the exact digest.** `apply` recomputes under the lock and
   refuses if the document moved since the preview.
5. **Reverts are commits, never rewrites** — no `reset --hard`, rebase, amend, force
   or push, whatever this command's name suggests.

## Run

1. `aw reset prepare <objetivo> --format human` — which session it resolved, which
   paths go back to their previous bytes and whether they moved since the baseline,
   what disappears, which SHA gets a revert, and the **digest**.
2. Show that preview and ask approval; if it touches git history, say so.
3. `aw reset apply <objetivo> --approval <digest> --format human`.
4. A rejection names cause, candidates and next action; **nothing was applied**.

## What the CLI decides (do not re-derive)

- **Which session** an artifact resolves to, and whether it is incomplete.
- **What "before" was**: the baseline sealed at creation. Never reconstructed from
  names, dates or tags — without it, it fails closed.
- **Inputs vs outputs**: an input returns to its bytes, an output is removed, and a
  document with work of its own blocks instead of being orphaned. A quick with no
  base document is retired whole.
- **All-or-nothing**: either the scope is intact, or the result is complete, not
  resumable, and leaves one append-only `HISTORY` row.

## More context

`aw context-plan --command reset --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` lists what to read.

- Deleting a document and everything under it: `/w:discard`.
