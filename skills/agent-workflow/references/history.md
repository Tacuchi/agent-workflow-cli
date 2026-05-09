# History

`<workspace>/.<namespace>/HISTORY.md` is a markdown table that lists every session in the workspace. Two CLI commands maintain it.

## history-data

Read-only aggregator. Walks the `.<namespace>/sessions/` tree and returns the data you would need to (re)build `HISTORY.md` from scratch, plus optional graduated-doc references.

```bash
agent-workflow history-data
agent-workflow history-data --verbose
agent-workflow history-data --include-docs   # also enumerate docs/scripts, docs/rfcs, etc.
```

Use this to detect drift between `HISTORY.md` and the on-disk session folders, or when you need to regenerate the table.

## history-update

Upsert a row in `HISTORY.md`. Used by `session-create` and `session-close` internally; you typically only invoke it directly to repair a row.

```bash
agent-workflow history-update \
  --code session035 \
  --state active \
  --sesion "aw-skill-repo" \
  --date 2026-05-05 \
  --summary "Sub-proyecto 2 del spec ..." \
  --refs "[OBJETIVO](.workflow/sessions/session035-dev-aw-skill-repo/OBJETIVO.md)"
```

Flags:

| Flag | Notes |
|---|---|
| `--code <sessionNNN>` | Required. |
| `--state <active\|closed>` | Required. |
| `--sesion <slug>` | Visible session slug (without `sessionNNN-flow-` prefix). |
| `--date <YYYY-MM-DD>` | Defaults to today if omitted in some callers; pass explicitly to be safe. |
| `--summary <text>` | Replaces the Resumen cell. |
| `--refs <markdown>` | Replaces the Refs cell. |
