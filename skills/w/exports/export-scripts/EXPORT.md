---
name: export-scripts
description: "Consolidates pending SQL into one `docs/scripts/NNN-export-scripts-YYYY-MM-DD/` bundle with continuous numbering after `00-ROLLBACK.sql`. It publishes the net final state, not a chronological transcript. Its origin is DECLARED: a base (the session corpus, the published bundles, or a sweep of the whole workspace), minus the pieces named in `--exclude`, minus whatever the release book says already ran in `--environment`. Read-only/report: it NEVER executes SQL nor commits; external application is a handoff. Composes the `sql` capability. User-invoked via `/w:export-scripts`."
---

# export-scripts — consolidated SQL bundle, simple and direct

Consolidates pending SQL migrations into a single bundle under `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`, with continuous numbering after `00-ROLLBACK.sql`. **Read-only / report** — the AI **never executes** the SQL; external application is an optional handoff.

**The material is declared, not assumed:** a base brings it, `--exclude` subtracts pieces and `--environment` what the book records as applied. With no flag: the session corpus, bundles out.

> `export-*` family (the only artifact→`docs/` path). Design: `docs/referencias/workflow-exports/export-scripts.md`.

## Category

`docs/scripts` — the **only** `docs/` folder this export writes.

## Composes

The **`sql`** capability (built-in default `sql`), resolved via `.workflow/skills.toml`. It contributes the DDL/DML category vocabulary, the application order and the rollback derivation. This export does **not** own that logic: it composes it. Rebindable or `off` by config.

## What it does NOT do

- **Execute SQL** (DB scripts-only). The bundle is a deliverable; a human/DBA applies it.
- Commit, merge or push; touch `.workflow/sessions/` or the loose `*.sql` (read-only).
- Write any `docs/` folder other than `docs/scripts/` (invariant: one category).
- Rewrite, renumber or delete a previous bundle: one in the origin is **read**, its directory left as it was.
- Include read-only type-A (diagnostic queries) or invent SQL.
- Put email templates, production checklists, commit listings or executive summaries in the README.

## Read-only sandbox

In plan mode it **describes**, never writes: the resolved `NNN`, the declared origin with its exclusions, the categories with content and the files that would appear. No `Write`, no mutations; numbering uses `aw next-number --dry-run` (pure).

## Inputs

**`agent-workflow` CLI (alias `aw`)** — never read hardcoded paths:

- `aw release-data [--since sessionNNN] [--source <alias>]` — the session corpus (ALL sessions, closed + active, with `release_eligible`). `aw sessions` lists only ACTIVE ones: never use it as the corpus.
- `aw session-artifacts --code <NNN> --dump scripts` — the session's `.sql` files with path and size (content is read by path). No scripts → empty list, silent skip.
- `aw release-data --standalone-sql [--include-graduated]` — the loose `docs/scripts/*.sql` and the previous bundles. `prepare` already reads both through its base; these are for looking by hand.
- `aw release-pass list` — the book `--environment` reads: `link --artifact <ruta>` says which bundle a pass carries, `applied --environment` that its SQL RAN there. Nothing inspects a database.
- `aw next-number docs/scripts` — deterministic numbering; it also creates `docs/scripts` when missing, which is what makes destination resolution a CLI guarantee. In plan mode, `--dry-run`.

**Args** (no lifecycle *structured-choice*; harness capability — see [`../../harness/HARNESS.md`](../../harness/HARNESS.md)):

```
/w:export-scripts [--from sessions|bundles|workspace] [--exclude <nombre>]… [--environment <ambiente>]
                  [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
```

| Flag | Behavior |
|---|---|
| `--from <base>` | The base: `sessions` (default) · `bundles` · `workspace` (all three) |
| `--exclude <nombre>` | Subtracts one piece by the name the inventory prints. **Repeatable** |
| `--environment <ambiente>` | Subtracts bundles the book records as applied there; no record is reported as such |
| `--sessions NNN[,NNN]` | Discrete filter by code (takes precedence over `--since`) |
| `--since sessionNNN` | Only sessions after NNN (exclusive: NNN itself is out; use `--sessions` to include it) |
| `--source <alias>` | Limits to one source (multi-source workspace) |

No args: every corpus session, bundles and loose SQL out — the behavior that always was. The three composition flags are this export's alone.

## Flow

### Step 1 — Collect SQL sources

`prepare` already resolved WHICH pieces are in: its inventory lists them per origin with every exclusion and its reason. Read only that.

**Sessions**: for every session the inventory names (`aw session-artifacts --code <NNN> --dump scripts`), read the `.sql` files the dump lists (per-script path). Take **only** type-B statements (deliverable DDL/DML migrations); ignore read-only type-A (diagnostic queries). Expected per-statement markers: `-- @category: <01-04>` + `-- @stmt: NNN-verb-target` (format defined by the `sql` capability).

**Loose SQL**: per file, honor `@category` markers when present; otherwise infer it from content (`CREATE/ALTER TABLE`, `CREATE INDEX` → `01`; `CREATE OR REPLACE FUNCTION`/`PROCEDURE` → `02`; `UPDATE`/`DELETE` → `03`; `INSERT INTO … VALUES` → `04`). If the filename contains `rollback` → skip (it never enters a forward).

**Published bundles**: their forwards in numeric order, same markers. `00-ROLLBACK.sql` is **never** read as a forward — it is the bundle's reverse, not its material.

An empty origin → **abort**: `prepare` already refused, saying whether nothing matched or everything was already applied.

### Step 2 — Bundle numbering

`aw next-number docs/scripts` → `docs/scripts/NNN-export-scripts-YYYY-MM-DD/`.

### Step 3 — Net final state, classification and internal order

Reconcile every candidate the origin brought against the code and the declared final state. Omit
objects born and retired within the sequence; write migrated objects directly in their final form;
omit explicitly retired objects even when their deletion is absent from the input.

**A previous bundle in the origin is MATERIAL A RECONCILIAR, not untouchable history.** Two that
contradict — one creating an object, a later one retiring it — publish the resulting net final state,
never their chronological sum: the new bundle does not create it, and its `00-ROLLBACK.sql` does not
reverse a creation it never published. The bundles on disk are never modified.

Then group the remaining statements by canonical category: `01 DDL-TABLES` · `02 DDL-FUNCTIONS` · `03 DML` ·
`04 INSERTS`. Origin is traceability, not an ordering authority over the final contract.

### Step 4 — Continuous numbering (no gaps)

Assign sequential numbers **only to categories with content**, in canonical order. The first forward is always `01-…`. E.g.: DML only → `00-ROLLBACK.sql`, `01-DML.sql`; all 4 categories → `00-ROLLBACK.sql`, `01-DDL-TABLES.sql`, `02-DDL-FUNCTIONS.sql`, `03-DML.sql`, `04-INSERTS.sql`.

### Step 5 — Write the forwards

Per category with content, one file with a 1-2 line header (`-- 0N-<CATEGORY>.sql — bundle NNN-export-scripts-YYYY-MM-DD`) and traceable origin comments where useful. Write SQL for the reconciled final state, not necessarily the original statement verbatim; preserve explicit intent, idempotency and safe transaction boundaries. Do not replicate motivation/impact already present at the origin; no statement index, no invented verification SELECTs.

### Step 6 — Derive `00-ROLLBACK.sql` (at the end)

Via the `sql` capability, **reading the already-written forwards** (not the original `SCRIPTS.sql`): inverse statements in reverse order (last→first), a single transactional block, and an "irreversible cleanup" block at the end outside the transaction only if there are operations without an automatic reverse.

### Step 7 — Write the `README.md` (3 sections)

`## Archivos` (table: 1 row per file present) · `## Aplicar` (one `psql -f` per file in ascending order; the export executes nothing) · `## Revertir` (`psql -f 00-ROLLBACK.sql` + a note if there is an irreversible block). The README is a user-facing deliverable → write it in the user's language. **Vetoed**: everything the section above forbids.

### Step 8 — Write or report

Publish through the three stages (`prepare` → `validate` → `apply --approval`); in plan mode, describe instead. **NEVER commit**. Summary: one line per file + the bundle path, naming the origin and what stayed out.

## Output location

```
docs/scripts/NNN-export-scripts-YYYY-MM-DD/
├── 00-ROLLBACK.sql       # reverse derived from the forwards
├── 01-<CATEGORY>.sql     # first forward (continuous numbering)
├── 02-<CATEGORY>.sql     # …per category with content
└── README.md             # Archivos · Aplicar · Revertir
```

## Re-run

Functionally idempotent: each invocation takes the next `NNN` and **never overwrites** a previous bundle. To regenerate, delete the directory by hand and re-invoke.

## Resources

- Design: `docs/referencias/workflow-exports/export-scripts.md` · family: [`../README.md`](../README.md).
- Composed capability: `sql` (built-in default; see `docs/referencias/workflow-roles/`).
- Source artifact: `SCRIPTS.sql` (see `docs/referencias/workflow-artifacts/artifacts-core/`).
- Siblings: [`../export-manuals/EXPORT.md`](../export-manuals/EXPORT.md) · [`../export-diagrams/EXPORT.md`](../export-diagrams/EXPORT.md) · [`../export-reports/EXPORT.md`](../export-reports/EXPORT.md).
