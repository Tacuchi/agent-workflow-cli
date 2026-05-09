# Doctor / release / scan / graduate

Diagnostics and release-prep commands. Read-only by default (`graduate` writes documentation, not code).

## plugin-doctor

Health check for a plugin: validates frontmatter, manifest version, hooks, MCP entries, and exported skills.

```bash
agent-workflow plugin-doctor --plugin-root /Users/me/Git/core-workflow-plugin
agent-workflow plugin-doctor --plugin-root /path --plugin-name acme-core --plugin-version 3.24.0
agent-workflow plugin-doctor --plugin-root /path --compat-range "^3.0.0"
agent-workflow plugin-doctor --plugin-root /path --exports-file plugin.json
```

Exits 1 when validation fails; 0 when clean.

## code-scan

Scan files for release-critical patterns: hardcoded `localhost`, exposed secrets, TODO/FIXME markers, debug prints, etc. Used by the release skill.

```bash
agent-workflow code-scan
agent-workflow code-scan --since 2026-04-01            # only files changed since date
agent-workflow code-scan --source core                 # restrict to one declared source
```

## release-data

Consolidated dump for the release / release-scripts skills: which sessions are graduated, which scripts ship, etc.

```bash
agent-workflow release-data
agent-workflow release-data --since 2026-04-01
agent-workflow release-data --source core
agent-workflow release-data --include-graduated
agent-workflow release-data --no-open --no-closed --skip-content   # narrow scope
agent-workflow release-data --verbose
```

## graduate

Promote a session-local artifact (DEC-NNN, TASKS, RFC, design entrega) into a workspace-level `docs/` location.

```bash
# Graduate a decision DEC-005 from session023
agent-workflow graduate --kind decision --session session023 --id DEC-005 --slug auto-plan-thresholds

# Graduate the full plan
agent-workflow graduate --kind plan --session session023 --slug cli-npm-agent-workflow

# Graduate an analyze RFC / data / postmortem
agent-workflow graduate --kind rfc --session session022 --slug cli-npm-agent-workflow
agent-workflow graduate --kind data --session session004 --slug precarga-objetos-bd
agent-workflow graduate --kind postmortem --session sessionNNN --slug incident-foo

# Graduate a design entrega
agent-workflow graduate --kind design --session sessionNNN --slug system-foo
```

Required: `--kind`, `--session`, plus `--id` (decisions) or `--slug` (everything else).
