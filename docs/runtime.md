# Runtime details

Detail behind [ARCHITECTURE.md](../ARCHITECTURE.md): two more quality goals, how a command finds its hub, two files on disk and how two kinds of file are written. All values are defaults.

## More quality goals

| Goal | Scenario |
|---|---|
| Help works anywhere | `--help` reads no hub, so it answers in any folder. |
| A host's session-start hook never breaks a session outside a hub | `self namespace --pin` stays silent when no hub is visible from the working folder. |

## Commands registry

Each subcommand is one `CliCommand`, listed once in `ALL_COMMANDS` and grouped by family for `--help`.

## How a command finds its hub

The namespace and the hub root are resolved in this order; the first that answers wins:

1. The `--namespace` flag.
2. The `AW_NAMESPACE` variable.
3. The closest `.<namespace>/agent-workflow.json` marker at or above the working folder. `$HOME` is never taken; two marked namespaces at one level are an error.
4. The pinned namespace in `~/.config/agent-workflow/namespace`.
5. The default, `workflow`.

## Two more files on disk

| What | Default | When it applies | How to change it |
|---|---|---|---|
| Pinned namespace | `~/.config/agent-workflow/namespace` | When no flag, variable or marker decides | `aw self namespace --pin` |
| Daily log | `~/.workflow/logs/agent-workflow-YYYY-MM-DD.log` | Every command except strict reads | `aw logs --clear` deletes them |

## Persistence details

- The registry of hubs is rewritten only under its lock, over a fresh reading.
- A hub in an older model is migrated by `aw hub-migrate`, which shows a preview and writes only with `--apply`.
