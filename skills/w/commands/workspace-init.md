---
description: Turns the current folder into an agent-workflow workspace (scaffolding .workflow/ + docs/ + WORKSPACE block + skills.toml). Replaces hub-init + project-init — no project/hub distinction. Run once before any flow; idempotent.
argument-hint: --source alias:path[:branch] [--proyecto <name>] [--main-branch <branch>] [--dry-run]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# workspace-init — workspace bootstrap

Runs `aw workspace-init` to turn the current folder into an agent-workflow workspace. A workspace has **1+ sources** (repos); "standalone" = a single source. There are no project/hub modes — the model is unified.

```bash
aw workspace-init --source alias:path[:branch] [--proyecto <name>] [--main-branch <branch>] [--dry-run]
```

## Interactive steps

1. **Detect/confirm sources** — the CLI detects the repo path(s); the user confirms aliases, paths and branches. Multiple `--source` accepted.
2. **Pick default skills** — the catalog of available capabilities (roles) is presented. Per role: `built-in default`, override to a third-party skill (`skills.sh`), or `off`. The result is written to `.workflow/skills.toml`. Config cascade: `built-in → ~/.workflow/skills.toml (global) → .workflow/skills.toml (workspace)`.
3. **Write the scaffolding** — creates `.workflow/sessions/`, `docs/` with its taxonomy (`specs/`, `plans/`, `scripts/`, `manuals/`, `diagrams/`, `reports/`), the `WORKSPACE` block in CLAUDE.md/AGENTS.md (sources + metadata), and `.workflow/skills.toml`.
4. **Multi-source** — with ≥2 sources, configures multi-root visibility (settings.local.json + config, gitignored) and reconciles sources.

When done, the user can run `/w:spec-new`, `/w:plan-new` or `/w:quick` directly.

**Idempotent**: re-running reconciles (no duplicate entries, no overwriting manual configuration).

## Plan mode

Resolves the sources and describes the scaffolding it would create, without writing files. Shows what it would create under `.workflow/` and `docs/`, and what it would write into CLAUDE.md.

## Resources

- Design reference: `docs/referencias/workflow-commands/workspace-init.md`
- Skills config: `docs/referencias/workflow-roles/` (available capabilities/roles and the binding cascade)
