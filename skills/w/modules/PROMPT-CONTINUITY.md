# PROMPT-CONTINUITY — one work line across several prompts

Loaded when a bare prompt continues an existing work line (signal `resume`).

## Continuity across prompts (operating context)

`quick` is where the **continuity rule** ([`../../SKILL.md`](../../SKILL.md) § *Operating context*) shows most clearly. Inside a workspace:

1. `/w:quick "first prompt"` (**command**) → creates session `NNN-<slug>-quick`, starts the loop. Scripts go to **its** `SCRIPTS.sql`.
2. `"second prompt"` (**no command**, related work) → does **not** create another session: **continues/reopens the most recent one** (from step 1) and appends the new scripts to **that same** `SCRIPTS.sql`.
3. `/w:quick "third prompt"` (**command** again) → **new** session, new loop.

> **Which line a prompt joins is not this document's call:** a command opens a new one through `aw session-create`, a bare prompt continues the most recent through `aw resume`. Both fire **before** a run exists, so no journey has a step for them. The reason stays: the **command** is the signal for "new work line", so nobody loses a thread by not typing one, or forks one by typing it twice.

Whether a prompt really belongs to the open line is judgment. Clearly unrelated → offer choosing (`continuar NNN` | `trabajo nuevo`) or fall to the **no-flow** branch (`docs/` by convention + numbering). Every invoked directory has an implicit Workline root; a marker is created only by a mutation.
