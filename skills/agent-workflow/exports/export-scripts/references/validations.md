# Validations — export-scripts

Checks mínimos antes de escribir el bundle. Solo lo esencial: estructura básica y ausencia de placeholders.

## V1 — Estructura del bundle

**Severidad**: hard-fail.

Requeridos al root del bundle:

- `README.md`.
- `00-ROLLBACK.sql` (si hay al menos un forward).
- Al menos un `NN-*.sql` con `NN >= 01`.

Numeración continua tras `00-ROLLBACK.sql`: el primer forward presente es `01-…`, el segundo `02-…`, etc. No hay gaps por categorías vacías.

Vetados (presencia → hard-fail):

- `manifest.md`, `ORDER.md`, `rollback-global.sql`, `por-sesion/`, `<file>.rollback.sql` (layout v3.x deprecado).
- Archivos `NN-*.sql` con saltos en la numeración (`01-…`, `03-…` sin `02-…`).

## V2 — Sin placeholders

**Severidad**: hard-fail.

El `README.md` y los `.sql` no deben contener:

- `NNN`, `YYYY-MM-DD`, `[entre corchetes]`, `<placeholder>`, `[CATEGORIA]`.
- Paths absolutos del developer (`/Users/`, `/home/`, `C:\\`).
- Referencias al layout v3.x deprecado (`por-sesion/`, `manifest.md`, `ORDER.md`, `rollback-global.sql`, `.rollback.sql` companions) — excepto en bloques explícitos de "deprecated"/"histórico".

**Cómo validar**:

```bash
grep -nE 'NNN|YYYY-MM-DD|\[entre corchetes\]|<placeholder>|\[CATEGORIA\]|/Users/|/home/|C:\\' README.md *.sql
grep -nE 'por-sesion/|manifest\.md|ORDER\.md|rollback-global\.sql|\.rollback\.sql' README.md
```

Ambos deben devolver vacío.

## Orden de aplicación

1. V1 (estructura + numeración continua).
2. V2 (placeholders + redundancia v3.x).

Ambas hard-fail. Si fallan, abortar antes de escribir.

## Reporte final

```json
{
  "ok": true,
  "output_dir": "docs/scripts/NNN-export-scripts-YYYY-MM-DD/",
  "files_written": ["README.md", "00-ROLLBACK.sql", "01-DML.sql", "02-INSERTS.sql"],
  "validations": { "V1": "pass", "V2": "pass" }
}
```

Hard-fail:

```json
{
  "ok": false,
  "stage": "validation",
  "failed_at": "V1",
  "details": "numeración con gaps: 01-DML.sql + 03-INSERTS.sql sin 02",
  "no_files_written": true
}
```
