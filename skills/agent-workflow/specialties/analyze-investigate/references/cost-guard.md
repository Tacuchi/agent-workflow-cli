# Cost guard — protocolo para queries MCP

Antes de ejecutar `mcp__plugin_developer-workflow_qtc-{cert,prod}__execute_sql` con cualquier query no-trivial, aplicar este guard. Las queries contra `<mcp-cert>` / `<mcp-prod>` tienen costo real (latencia, I/O, hold de conexión).

## Paso 1 — estimar tamaño antes de ejecutar la query principal

Para queries que NO son `SELECT 1`, `LIMIT 1`, ni `WHERE pk = literal`:

```sql
-- Estimación 1: cuántas filas esperar
SELECT COUNT(*) FROM <tabla principal> WHERE <filtros>;

-- Estimación 2: peek a estructura (1 fila)
SELECT * FROM <tabla principal> WHERE <filtros> LIMIT 1;
```

Si soporta `EXPLAIN`:

```sql
EXPLAIN (FORMAT TEXT) <query principal>;
```

Leer el plan: índices usados, tipo de scan (seq scan vs index scan), filas estimadas (`rows=`).

## Paso 2 — clasificar costo

| Categoría | Criterios | Acción |
|---|---|---|
| **Barata** | COUNT(*) ≤ 1.000 filas; PK lookup; EXPLAIN dice index scan | Ejecutar directamente. Documentar tamaño real en query header. |
| **Moderada** | COUNT(*) entre 1.000 y 10.000; seq scan sobre tabla pequeña (<100k); JOIN con todos índices | Avisar al usuario el tamaño + duración estimada. Ejecutar si no objeta. |
| **Costosa** | COUNT(*) > 10.000; JOIN sin índice; seq scan sobre >100k; ventana > 90 días sobre tabla activa | **Confirmación EXPLÍCITA** antes de ejecutar. Sugerir LIMIT, filtros, sample. |
| **Bloqueada** | UPDATE/INSERT/DELETE detectado; lock fuerte (FOR UPDATE) | Refusarse. MCP enforcan; el AI tampoco intenta. |

## Paso 3 — formato de aviso al usuario

### Moderada (antes de ejecutar)

```
La query estimada toca ~5.200 filas (EXPLAIN: index scan sobre idx_solicitud_fecha,
ventana 30 días). Tiempo esperado <2s. Ejecuto?
```

### Costosa

**Dispara `AskUserQuestion`** con spec de C2 (`agent-workflow:prompts-catalog#C2`). Header `cost`, 2 opciones canónicas (Proceder / Cancelar) + preview ASCII obligatorio con el SQL y el plan EXPLAIN resumido. NO narrar la pregunta en texto plano (anti-patrón histórico: bloque "(a)/(b)/(c)/(d) — Decidí" como input libre).

Plantilla del preview:

```
⚠ Query potencialmente costosa
  COUNT(*) estimado: ~85.000 filas
  EXPLAIN: seq scan sobre solicitud (sin índice para WHERE estado='X')
  Sin LIMIT — Servidor: <mcp-prod>

SQL:
  SELECT * FROM solicitud WHERE estado = 'X' ORDER BY fecha DESC;
```

Si el usuario activa el Other auto-inyectado puede pedir variantes (LIMIT, sample por mod(id,N), filtros adicionales) en texto libre — el AI reformula la query y vuelve a aplicar el guard sobre la versión revisada antes de ejecutar.

NO ejecutar la versión costosa sin confirmación explícita, aunque el usuario haya autorizado queries genéricas en la sesión.

## Paso 4 — registrar el costo real

Tras ejecutar, agregar al header del archivo SQL:

```sql
-- Costo real: <filas devueltas> filas en <duración>; servidor=<cert|prod>
```

Esto cierra el loop: la próxima sesión que toque la misma tabla tiene referencia.

## Excepciones permitidas (sin guard explícito)

- `SELECT 1` y healthchecks.
- `SELECT * FROM <tabla> WHERE <pk> = <valor>` (PK lookup determinístico).
- Queries contra `information_schema` / `pg_catalog` (metadata, casi gratis).
- Re-ejecución de una query que ya tenía guard documentado en una sesión previa.

## Anti-patrones

- **`SELECT * FROM tabla` sin WHERE**: nunca, salvo confirmación con `(a)` arriba.
- **JOIN cartesiano accidental**: revisar siempre que cada JOIN tenga ON con clave indexada.
- **Loop de queries pequeñas**: si vas a correr 50 queries similares, 1 query con `IN (...)` o `JOIN` es preferible. Documentar la decisión.
- **Saltarse el guard porque "es solo cert"**: cert también tiene costo y se comparte con otros equipos.
