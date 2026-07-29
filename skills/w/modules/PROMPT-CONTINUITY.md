# PROMPT-CONTINUITY — one work line across several prompts

Loaded when a bare prompt continues an existing work line (signal `resume`).

## Continuity across prompts (operating context)

`quick` is where the **continuity rule** ([`../../SKILL.md`](../../SKILL.md) § *Operating context*) shows most clearly. Inside a workspace:

1. `/w:quick "first prompt"` (**command**) → creates session `NNN-<slug>-quick`, starts the loop. Scripts go to **its** `SCRIPTS.sql`.
2. `"second prompt"` (**no command**, related work) → does **not** create another session: **continues/reopens the most recent one** (from step 1) and appends the new scripts to **that same** `SCRIPTS.sql`.
3. `/w:quick "third prompt"` (**command** again) → **new** session, new loop.

> The **command** signals "new work line"; a **bare prompt** means "same line" → by default continue/reopen the most recent session (the *last started*). Clearly unrelated → offer choosing (`continuar NNN` | `trabajo nuevo`) or fall to the **no-flow** branch (write into `docs/` by convention + numbering). No workspace → **vanilla** behavior.
