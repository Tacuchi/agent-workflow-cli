# Self — manage the CLI itself

`agent-workflow self <subcommand>` covers tasks that target the CLI binary itself: namespace inspection, install diagnostics, in-place upgrade, and skill installation.

```bash
agent-workflow self <namespace|doctor|update|install-skill>
```

## self namespace

Print the resolved namespace and the source it came from (env / flag / config / default).

```bash
agent-workflow self namespace

# Result:
# { "namespace": "workflow", "source": "env", "expected_paths": { "user_dir": "~/.workflow", "workspace": ".workflow" } }
```

Use this when paths look wrong — it tells you exactly which override won the precedence chain.

## self doctor

Health check the CLI install: binary location, Node version, namespace config, expected paths, and whether the skill is installed under `~/.claude/skills/agent-workflow/`.

```bash
agent-workflow self doctor
```

Returns a structured report. Non-zero exit when something is broken.

## self update

Wraps `npm install -g @tacuchi/agent-workflow-cli@latest`. Confirms interactively when stdout is a TTY.

```bash
agent-workflow self update
```

Skips confirmation in non-TTY contexts. Failures from the underlying `npm` invocation propagate.

## self install-skill

Copy the bundled skill (shipped inside the CLI tarball) to `~/.claude/skills/agent-workflow/`. After installation the skill is auto-discovered by Claude Code on next session start.

```bash
# Default — copy from the bundled location inside the CLI tarball
agent-workflow self install-skill

# Override the source (local checkout, fork)
agent-workflow self install-skill --from /Users/me/Git/agent-workflow-cli/skills/agent-workflow

# Overwrite an existing install
agent-workflow self install-skill --force

# Print the plan without executing
agent-workflow self install-skill --dry-run
```

Flags:

| Flag | Default | Notes |
|---|---|---|
| `--from <path>` | bundled location inside the CLI tarball | Accepts a local filesystem path only. Remote URLs are no longer supported — the skill is bundled-only. |
| `--force` | off | Required to overwrite an existing `~/.claude/skills/agent-workflow/` directory. |
| `--dry-run` | off | Print the resolved source/destination and exit without copying. |

The installer validates that the source contains a `SKILL.md` with valid frontmatter (`name`, `description`) before copying.
