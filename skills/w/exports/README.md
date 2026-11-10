# exports — `export-scripts` (Layer 1)

> This is the **bundle README** for the one export that survives: `export-scripts`. Diagrams, manuals and reports are written by the flows straight into `docs/diagrams`, `docs/manuals` and `docs/reports`, each with its category's shape; SQL is written as loose files in `docs/scripts/`. `export-scripts` is what consolidates that loose SQL into a bundle. *(Host→`docs/` ingestion is a different plane: [`/w:persist`](../commands/persist.md) persists in-conversation work and owns `docs/research`.)*
>
> **Namespace:** the export body is an **operating manual** (`EXPORT.md` — deliberately not a `SKILL.md`, so no host indexes it as a standalone skill). The user-invocable surface is `/w:export-scripts`, which reads-and-follows [`export-scripts/EXPORT.md`](export-scripts/EXPORT.md).

---

## Principle (boundary) — hard rule

The flows write their document and their deliverables directly in `docs/`; `export-scripts` is invoked by the **user**, as a separate step, to turn the loose `docs/scripts/*.sql` and the bundles already published into the next numbered bundle.

```
docs/scripts/*.sql (loose) + published bundles ── export-scripts ──► docs/scripts/NNN-export-scripts-<date>/
```

## Common properties

1. **Layer 1, explicit** — the **user** invokes it (`/w:export-scripts`). **Never** automatic.
2. **Single-pass** — it reads `docs/scripts/`, synthesizes, and writes only its own bundle folder.
3. **DB scripts-only** — it ships migration scripts as a bundle; it **never executes** DDL/DML (a human/DBA applies them).
4. **Git-safe** — publication itself does not commit; the commit is proposed and approved by digest (`aw flow propose-commit --source hub`).

## Runtime CLI (`agent-workflow`, alias `aw`)

- `aw export-scripts prepare [--from hub|bundles] [--exclude <nombre>] [--environment <ambiente>]` — composes the origin and declares it: where it started, what stayed in, what stayed out and why. `hub` (default) is the loose SQL plus the published bundles; `bundles` is only those.
- `aw release-pass link --artifact <ruta> | applied --environment <ambiente>` — the book `--environment` reads: `link` attaches a bundle to a pass by path, `applied` records that its SQL RAN there. Nothing inspects a database.
- `aw next-number docs/scripts` — deterministic numbering of the output, by the folder itself.

## Index

| Export | File | Category | Composes |
|---|---|---|---|
| `export-scripts` | [`export-scripts/EXPORT.md`](export-scripts/EXPORT.md) | `docs/scripts` | optional host help |
