# agent-workflow

Universal Claude Code / Codex skill for the [`@tacuchi/agent-workflow-cli`](https://www.npmjs.com/package/@tacuchi/agent-workflow-cli) CLI.

This bundled skill — `SKILL.md` plus a `references/` folder — teaches an AI agent how to drive the agent-workflow session-lifecycle CLI: create / resume / close sessions, read & write artifacts (`OBJETIVO.md`, `TASKS.md`, `DECISIONES.md`, `HISTORY.md`, `CHECKPOINT.md`), inspect sources, run hooks, and manage the binary itself.

The skill is bundled inside the CLI tarball — there is no standalone repo. The CLI command `agent-workflow self install-skill` copies it from the bundled location to `~/.claude/skills/agent-workflow/`.

## Quick start

```bash
# 1. Install the CLI globally (one time)
npm install -g @tacuchi/agent-workflow-cli

# 2. Install this skill into ~/.claude/skills/agent-workflow/
agent-workflow self install-skill
```

The second command copies the bundled skill (shipped inside the CLI tarball) to `~/.claude/skills/agent-workflow/`. Claude Code auto-discovers the skill on the next session start.

To preview without writing:

```bash
agent-workflow self install-skill --dry-run
```

To install from a local checkout (useful for skill development):

```bash
agent-workflow self install-skill --from /path/to/agent-workflow-cli/skills/agent-workflow --force
```

## Repo layout

```
skills/agent-workflow/
├── SKILL.md              # Skill entry point with frontmatter
├── README.md             # This file
├── LICENSE               # MIT
└── references/           # Per-family command documentation
    ├── session-mgmt.md   # sessions, session-create, session-resume, session-close, session-artifacts
    ├── objetivo-tasks.md # objetivo-data, tasks-data, decisiones-list, dependencias-list
    ├── history.md        # history-data, history-update
    ├── checkpoint.md     # checkpoint-read, checkpoint-write, compress-checkpoint, resume-summary, auto-compact-on-close
    ├── sources.md        # sources, check-branch, workspace-mode, project-md-upsert, upgrade-hub-mode, attach/detach-multiroot
    ├── orchestration.md  # auto-plan-decide, topic-change-check, specialty-choose, phase-detect, phase-next, stack, workflows, skill-index
    ├── doctor.md         # plugin-doctor, code-scan, release-data, graduate
    ├── hooks.md          # hook branch-check, hook sql-mutation-guard
    ├── mcp.md            # mcp dbhub, bootstrap-dsn
    ├── dev-only.md       # harness, profiles, logs, next-number
    └── self.md           # self namespace, self doctor, self update, self install-skill
```

## Updating the skill

```bash
npm install -g @tacuchi/agent-workflow-cli@latest    # update the CLI tarball
agent-workflow self install-skill --force            # re-install bundled skill
```

## Uninstall

```bash
rm -rf ~/.claude/skills/agent-workflow
```

## Project links

- CLI source: <https://github.com/Tacuchi/agent-workflow-cli>
- npm: <https://www.npmjs.com/package/@tacuchi/agent-workflow-cli>

## License

MIT — see [LICENSE](./LICENSE).
