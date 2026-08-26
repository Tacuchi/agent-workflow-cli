---
description: "Use to materialize Workline runtime early, or configure explicit workspace sources. Flows work without a prior init. Backed by `aw workspace-init`."
argument-hint: --source alias:path[:branch] [--proyecto <name>] [--main-branch <branch>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# workspace-init — materialize or configure

Workline already has an implicit workspace at the resolved root: the nearest ancestor with `.<namespace>/sessions/`, or exactly the invoked directory when none exists. It never guesses a Git root.

`aw workspace-init [--source alias:path[:branch]] [flags above] --format human`

> **The CLI writes; this wrapper does not** — `Write` and `Edit` are absent from `allowed-tools` on purpose. `--dry-run` previews; re-run without it. Relay the output, never re-render it.

## Modes

Without sources, it only materializes the minimal runtime under the lock: the CLI-owned `.gitignore` block when the root belongs to Git, then `.<namespace>/sessions/` as the final marker. It does not create `docs/`, `skills.toml`, a WORKSPACE block, launch files, `HISTORY.md` or a Git repository.

With `--source`, it configures/reconciles the metadata, branches and multiroot visibility. `workspace` is the reserved implicit source pointing at the root and cannot be configured as an alias. A workspace `skills.toml` is created only when there is a real capability override.

Both modes are idempotent. A normal first mutation also materializes the same runtime automatically, so this command is optional rather than a gate.

Done → the user can run `/w:spec-new`, `/w:plan-new` or `/w:quick`.

## More context

`aw context-plan --command workspace-init --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` lists the case-specific documents to read:

- `scaffold` — the folder already carries a workspace, or you need what init versions, ignores and prunes → [`../modules/WORKSPACE-SCAFFOLD.md`](../modules/WORKSPACE-SCAFFOLD.md)
