# MCP / DSN

CLI helpers for MCP server lifecycle and DSN bootstrap.

## mcp dbhub <instance>

Launch the `@bytebase/dbhub` MCP server pre-wired with the namespace's DSN file. The CLI resolves the DSN, sets up environment, and execs `npx @bytebase/dbhub` with the right transport.

```bash
agent-workflow mcp dbhub cert
agent-workflow mcp dbhub prod
```

Connection names map to environment variables in `~/.<namespace>/dev/dsn.env` by default:

| Instance | Reads | Default behavior on missing DSN |
|---|---|---|
| `cert` | `DB_CERT_DSN` | stderr message, exit 1 |
| `prod` | `DB_PROD_DSN` | stderr message, exit 1 |

Custom host entries can set `DBHUB_DSN_VAR` to read an arbitrary DSN variable.

The launcher is the entry point referenced by the plugin's `.mcp.json`. You usually do not invoke it manually — Claude Code / Codex starts it.

## bootstrap-dsn

Persist `DB_CERT_DSN` and `DB_PROD_DSN` from the current shell into the namespace's `dsn.env` file (so subsequent CLI / hook invocations have them).

```bash
DB_CERT_DSN=postgres://... DB_PROD_DSN=postgres://... agent-workflow bootstrap-dsn
agent-workflow self mcp
```

Exit code 2 + `MISSING_DSN` error when neither DSN is set. Writes to `~/.<namespace>/dev/dsn.env`.
