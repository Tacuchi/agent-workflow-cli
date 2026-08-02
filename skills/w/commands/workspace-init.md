---
description: "Use when starting Workline in a folder with no workspace yet — turns it into one (minimal scaffold: sessions marker, skills.toml, WORKSPACE block, .gitignore). Run once before any flow. Backed by `aw workspace-init`."
argument-hint: --source alias:path[:branch] [--proyecto <name>] [--main-branch <branch>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# workspace-init — workspace bootstrap

Turns the current folder into a Workline workspace: **1+ sources** (repos), one source = standalone. No project/hub modes.

`aw workspace-init --source alias:path[:branch] [--proyecto <name>] [--main-branch <branch>] [--dry-run] --format human`

> **The CLI writes; this wrapper does not** — `Write` and `Edit` are deliberately absent from `allowed-tools`. Use `--dry-run` to preview, then re-run without it. Relay the CLI's output; do not re-render it.

## Interactive steps

1. **Sources** — the CLI detects the repo path(s); the user confirms aliases, paths, branches. Multiple `--source` accepted.
2. **Default skills** — present the catalog of capabilities (roles). Per role: `built-in default`, a third-party skill (`skills.sh`), or `off`; the result lands in `.workflow/skills.toml`. Cascade: `built-in → ~/.workflow/skills.toml (global) → .workflow/skills.toml (workspace)`. The template also ships a commented `[compaction]` section — the `mode` switch for the loops' context self-regulation (`confirm` default, `auto` opt-in).
3. **Minimal scaffold** — only the activation set: `.workflow/sessions/` (the marker that activates the operating context), `.workflow/skills.toml`, the `WORKSPACE` block in CLAUDE.md/AGENTS.md and the CLI-owned `.gitignore`. **Nothing else upfront**: each `docs/<category>` folder is born on demand at its first numbered write (`aw next-number docs/<cat>`); `.workflow/launch/<alias>/` and `docs/logs/` at the first launch.
4. **External sources** — a source outside the workspace folder gets multi-root visibility (gitignored) and a reconcile.

**Idempotent** — a re-run reconciles: it keeps manual configuration and prunes the legacy scaffold.

Done → the user can run `/w:spec-new`, `/w:plan-new` or `/w:quick`.

## More context

`aw context-plan --command workspace-init --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` lists the case-specific documents to read:

- `scaffold` — the folder already carries a workspace, or you need what init versions, ignores and prunes → [`../modules/WORKSPACE-SCAFFOLD.md`](../modules/WORKSPACE-SCAFFOLD.md)
