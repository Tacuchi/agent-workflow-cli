# Plantilla — README del bundle export-scripts

README mínimo del bundle. Reemplaza `[entre corchetes]` con valores reales. Sin resumen ejecutivo, sin tabla de sesiones, sin plantillas de correo, sin acciones manuales narradas, sin checklist de producción.

---

```markdown
# Bundle export-scripts NNN — [YYYY-MM-DD]

## Archivos

| Archivo | Contiene |
|---|---|
| `00-ROLLBACK.sql` | Reversa de todo el bundle. |
| `01-[CATEGORIA].sql` | [Primera categoría con contenido] |
| `02-[CATEGORIA].sql` | [Segunda categoría con contenido — si aplica] |
| ... | ... |

> La numeración es continua tras `00-ROLLBACK.sql`. Las categorías sin contenido no ocupan número.

## Aplicar

```bash
psql -h <host> -U <user> -d <db> -f 01-[CATEGORIA].sql
psql -h <host> -U <user> -d <db> -f 02-[CATEGORIA].sql
# ...
```

Orden estricto: ascendente por número (01 → 02 → …). El plugin no ejecuta nada — el operador aplica.

## Revertir

```bash
psql -h <host> -U <user> -d <db> -f 00-ROLLBACK.sql
```

Si hay bloque `Fase 5 — Cleanup irreversible` al final del rollback, leerlo antes de ejecutar — son operaciones manuales (sin reversa automática).
```

---

## Notas para el AI generador

- **No agregar** secciones más allá de `## Archivos`, `## Aplicar`, `## Revertir`.
- **No incluir** resumen ejecutivo, sesiones origen, commits, ramas, code-scan, plantillas de correo, ACT-NNN, ni checklist de producción.
- **Tabla de archivos**: una fila por archivo presente. Categorías vacías no aparecen.
- **Cómo aplicar**: un `psql -f` por archivo presente, en orden ascendente.
- **Cómo revertir**: una sola línea `psql -f 00-ROLLBACK.sql` + nota opcional si hay `Fase 5`.
- Si el bundle es trivial (sólo 1 forward + rollback), basta con la tabla y los dos bloques `bash`. Cualquier prosa adicional es ruido.
