# Hooks

Hook targets the host harness invokes via `PreToolUse` / `SessionEnd` / `PostCompact` events. Each hook reads JSON on stdin, may print a message on stderr, and returns a meaningful exit code.

You rarely call these by hand — they are wired into `hooks.json` by the plugin installer. Document them here so the AI knows what to expect when a hook fires.

## hook branch-check

PreToolUse guard for `Edit` / `Write`. Reads the tool input from stdin, resolves the target file, finds the owning source by path, and verifies the current branch matches the declared work branch.

```bash
echo '{"tool":"Edit","tool_input":{"file_path":"/path/to/file"}}' \
  | agent-workflow hook branch-check
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Branch matches expected (silent). |
| 0 + stderr | Warning logged, but proceed. |
| Non-zero | Block the tool call. |

## hook sql-mutation-guard

PreToolUse guard for MCP SQL execution tools. Reads the tool input, matches against the runtime config's `mcpGuards.sqlMutation` patterns, and blocks `INSERT`/`UPDATE`/`DELETE`/DDL against the configured "no-mutate" servers.

```bash
echo '{"tool":"mcp__plugin_acme-dev_cert__execute_sql","tool_input":{"sql":"UPDATE x SET ..."}}' \
  | agent-workflow hook sql-mutation-guard
```

The patterns live in `~/.<namespace>/lib/config/<namespace>-runtime.json`. Configure them with the MCP server names that must be read-only, such as `cert` and `prod`.

Exit codes: same conventions as `branch-check`.
