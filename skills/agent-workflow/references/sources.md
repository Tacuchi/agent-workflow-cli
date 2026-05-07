# Sources, branches, project block, multi-root

Workspace state lives in the `<NS>-PROJECT` block of `CLAUDE.md` / `AGENTS.md`. These commands read or update that state, plus surface git context for declared sources.

## sources

List sources from the project block, enriched with git status (current branch, dirty flag, ahead/behind).

```bash
agent-workflow sources
agent-workflow sources --no-git                    # skip git enrichment (fast)
agent-workflow sources --session session035        # constrain to sources of a session
agent-workflow sources --scope core,dev,design     # filter by alias
agent-workflow sources --flow dev                  # heuristic source filtering by flow
agent-workflow sources --verbose
```

## check-branch

Verify a source branch matches the expected work branch declared in the project block.

```bash
agent-workflow check-branch --source core                       # by alias
agent-workflow check-branch --path /Users/me/Git/foo            # by path
agent-workflow check-branch --file /Users/me/Git/foo/src/x.ts   # by descendant file
agent-workflow check-branch --source core --strict              # exit 2 on mismatch
agent-workflow check-branch --source core --session session035
agent-workflow check-branch --source core --flow dev
```

Returns `{ match: true|false, expected, current, ... }`. `--strict` makes mismatch cause a non-zero exit.

## workspace-mode

Read the workspace mode (`project` vs `hub`) plus declared sources and current working branches.

```bash
agent-workflow workspace-mode
agent-workflow workspace-mode --verbose
```

`hub` mode means the workspace coordinates ≥2 sources (the project block has a `Mode: hub` marker). Otherwise `project`.

## project-md-upsert

Read or update the `<NS>-PROJECT` block.

```bash
# Read mode
agent-workflow project-md-upsert --read
agent-workflow project-md-upsert --read --verbose

# Init the block (creates it if missing)
agent-workflow project-md-upsert --init --proyecto "Marketplace" --mode hub

# Add a session entry
agent-workflow project-md-upsert --add-session sessionNNN-dev-foo \
  --phase planning --branches "core:feature/foo,dev:feature/foo"

# Update the phase of an existing session
agent-workflow project-md-upsert --update-phase --add-session sessionNNN-dev-foo --phase execution

# Remove a session
agent-workflow project-md-upsert --remove-session sessionNNN-dev-foo

# Set a working branch
agent-workflow project-md-upsert --working-branch "core:feature/custom-CLI"
```

Operations are mutually exclusive — pick one of `--read | --init | --add-session | --remove-session | --update-phase`.

## upgrade-hub-mode

Detect when ≥2 sources are declared in a workspace stuck in `project` mode and apply the `Mode: hub` upgrade.

```bash
agent-workflow upgrade-hub-mode --dry-run    # preview only
agent-workflow upgrade-hub-mode              # apply
```

## attach-multiroot

Configure multi-root visibility for the host harness (Claude Code + Codex CLI). Useful when a hub workspace coordinates folders that live outside the primary root.

```bash
agent-workflow attach-multiroot --from-sources                 # use declared sources
agent-workflow attach-multiroot --path /Users/me/Git/core --path /Users/me/Git/dev
agent-workflow attach-multiroot --paths "/Users/me/Git/core,/Users/me/Git/dev"
agent-workflow attach-multiroot --from-sources --global        # write to user-level config
agent-workflow attach-multiroot --from-sources --workspace foo # named workspace slot
agent-workflow attach-multiroot --from-sources --skip-codex    # only Claude Code
```

## detach-multiroot

Reverse of `attach-multiroot`.

```bash
agent-workflow detach-multiroot --from-sources
agent-workflow detach-multiroot --path /Users/me/Git/core
agent-workflow detach-multiroot --global --workspace foo
```
