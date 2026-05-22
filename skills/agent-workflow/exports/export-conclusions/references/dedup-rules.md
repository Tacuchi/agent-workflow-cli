# Dedup rules — R-items consolidados en `export-conclusions`

Algoritmo canónico de deduplicación de Recommendations (R-NNN) al consolidar N CONCLUSIONS.md en un documento curado.

## Por qué dedup solo R-items

- **C-items** (Conclusions) son específicos del análisis original — preservar 1-a-1 mantiene trazabilidad clínica.
- **R-items** (Recommendations) son acciones — la redundancia entre análisis indica consenso, y consolidar mejora la accionabilidad.

## Algoritmo paso a paso

### Paso 1 — Extracción de slug por R-item

Para cada `R-NNN` en una CONCLUSIONS.md fuente:

1. Leer la primera línea del header: `- **R1 — bundle plugin v2.10.0 + CLI v6.1.0** · Responsable: ...`
2. Extraer el **título del R-item**: texto entre `** — ` y `**` (ej. `bundle plugin v2.10.0 + CLI v6.1.0`).
3. Aplicar normalización para derivar el slug:
   - Lowercase.
   - Remover puntuación (`,`, `.`, `+`, `(`, `)`, `:`, `;`).
   - Reemplazar whitespace por `-`.
   - Truncar a primeras **5 palabras** post-normalización.
   - Collapse `--` repetidos.

   Ejemplo: `"bundle plugin v2.10.0 + CLI v6.1.0"` → `bundle-plugin-v2-10-0-cli-v6-1-0` → truncado a 5 palabras → `bundle-plugin-v2-10-0-cli`.

4. Slug resultante = clave de agrupación.

### Paso 2 — Agrupación por slug exacto

Construir un mapa `slug → R-items[]`:

```
{
  "bundle-plugin-v2-10-0-cli": [
    {session: "055", id: "R3", text: "..."},
    {session: "062", id: "R1", text: "..."}
  ],
  "release-plugin-v3-0-0-breaking": [
    {session: "062", id: "R2", text: "..."}
  ],
  ...
}
```

Cada bucket con ≥2 entries → R-item consolidado. Cada bucket con 1 entry → R-item single-origin (preservar tal cual con `origins: [session:R]` igual).

### Paso 3 — Cross-slug similarity (opcional, threshold ≥0.7)

Para slugs que **no matchean exacto** pero son semánticamente cercanos:

1. Computar cosine similarity entre embeddings de los slugs (o substring-overlap si no hay embedding model disponible).
2. Si similarity ≥ 0.7 → emitir **sugerencia de merge** al AI:
   - Output intermedio: bloque `<!-- DEDUP-SUGGESTION: merge {slug-A} with {slug-B}? -->` al final del documento.
   - El AI decide si aplicar el merge basándose en el contenido completo de los R-items.
3. Si el AI mergea: tratar como bucket único con `origins[]` combinado.

**Fallback sin embeddings**: usar substring overlap ≥60% como heurística simple.

### Paso 4 — Conflict resolution (`## R-Conflict`)

Para R-items en el **mismo bucket** (slug exacto) pero con acciones contradictorias:

1. Detectar contradicción por keywords (heurística):
   - `mantener` vs `reemplazar`.
   - `agregar` vs `eliminar`.
   - `migrar a X` vs `migrar a Y`.
   - `aceptar` vs `rechazar`.
2. Si detectado → NO consolidar. Mover ambos R-items a sección dedicada `## R-Conflicts detectados`.
3. Estructura del conflict block:

   ```markdown
   ### R-Conflict#N — <slug compartido>
   - **Origen A**: sessionXXX:R3 → "...".
   - **Origen B**: sessionYYY:R5 → "...".
   - **Decisión sugerida**: <propuesta del AI o "queda al usuario">.
   ```

### Paso 5 — Síntesis del R-item consolidado

Para cada bucket consolidado (post-dedup, post-conflict):

```markdown
### R<N>-consolidado — <slug>

- **Origen**: sessionAAA:RX + sessionBBB:RY + sessionCCC:RZ
- **Síntesis**: <párrafo unificador 2-4 líneas que destila la acción común>.
- **Acción sugerida**: <accionable concreto derivado del consenso>.
- **Responsable sugerido**: <rol/equipo>, si los origins coinciden en `Responsable:`.
```

Renumerar `R1-consolidado, R2-consolidado, ...` globalmente en el documento.

## Trazabilidad — matriz origen→consolidado

Después del dedup, el skill puede emitir opcionalmente una matriz en el bloque `## Sesiones consolidadas` o al final:

```markdown
| Sesión | R original | R consolidado |
|--------|-----------|---------------|
| 055    | R3        | R1-consolidado |
| 055    | R5        | R2-consolidado |
| 062    | R1        | R1-consolidado |
| 062    | R2        | (single-origin → preservado como R3-consolidado) |
```

Útil para revisión de la curación.

## Reglas absolutas

- **Nunca borrar trazabilidad**: cada R consolidado debe listar TODOS los `origins[]`.
- **Nunca inventar R-items**: si un bucket tiene 1 entry, queda single-origin con `origins: [session:R]`.
- **Conflicts no se resuelven en silencio**: siempre bloque dedicado para revisión.
- **Cross-slug merges requieren confirmación**: nunca aplicar automático sin pasar por el AI.

## Casos edge

### 1. Bucket con 2 R-items idénticos textualmente

→ Consolidar trivial. `origins: [A, B]`, síntesis = texto original.

### 2. R-item con `Responsable:` distinto en cada origen

→ Síntesis menciona los 2 responsables; el `Responsable sugerido` del consolidado queda como "ambos" o "consensuar".

### 3. R-item con `Cuándo:` (timeline) distinto

→ Síntesis menciona los 2 timelines; el del consolidado toma el más conservador (más lejano) o se omite.

### 4. R-item con `(Recomendado)` en uno de los origins

→ Preservar la flag `(Recomendado)` en el consolidado.

### 5. 1 sola sesión input (single-session export)

→ Skip Paso 2 (no hay agrupación). Cada R-item del input queda como `R<N>-consolidado` con `origins: [SOLA:R<N>]`. Sin conflicts. Sin cross-slug merge.

## Resumen operacional

```
input: N sesiones con CONCLUSIONS.md
  ↓
extract slugs from each R-NNN
  ↓
group by slug (exact match)
  ↓
if N>1 cross-slug similarity → suggest merges to AI
  ↓
detect conflicts within each bucket
  ↓
output: { consolidated_R[], conflicts[] }
  ↓
render via template-conclusions.md
```
