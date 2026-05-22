---
name: export-report
description: "Genera un informe funcional ejecutivo (`.md`) consolidando el corpus de sesiones del workspace y `docs/`, dirigido a gerencia/jefatura/comité. Variante B default (≤760 palabras), A (400w compacto) y C (1620w extenso) derivadas vía `--audiencia`. Estructura: Objetivo, Componentes impactados, Diagrama de flujo Mermaid (`flowchart LR` con link `mermaid.ink` para preview), Oportunidades de mejora. Output en `docs/funcional/NNN-export-report-YYYY-MM-DD.md`. Read-only sobre el corpus; sin commits autónomos. Aplica tabla determinista de traducción técnico→ejecutiva y valida cota + léxico vetado post-generación. Invocado sólo vía `/agent-workflow:export-report`. Historial de versiones en CHANGELOG del CLI bundleado."
version: 1.7.0
---

> **Profile parametrization**: lee `lexicon_path` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Export Report — Informe ejecutivo desde corpus de sesiones + `docs/`

Genera un único `.md` ejecutivo agregando las sesiones cerradas del workspace, para gerencia/jefatura/comité. **Read-only / reporte** — no commitea, no muta nada del corpus.

> Primer comando de la familia `/agent-workflow:export-*` definida en `docs/conclusiones/007-export-commands-family.md`. Spec autoritativa: `docs/especificaciones/001-export-report-format/DELIVERY.md`.

## Excepción session-aware

Este skill requiere conocimiento del lifecycle. **No crea ni modifica sesiones**. Si el workspace no tiene sesiones cerradas en el rango filtrado por `--period`, abortar con `ok: false` y mensaje explícito.

**Solo formato actual (v0.9+)**: sesiones legacy abortan; migrar con `/agent-workflow:migrate --upgrade-topology`.

**Consumo de CLI `agent-workflow`** (no leer paths hardcodeados):
- `agent-workflow project-md-upsert --read` — `workspace_mode`, fuentes, working branches.
- `agent-workflow history-data` — lista de sesiones con metadata + filtro temporal.
- `agent-workflow session-artifacts --code <NNN>` — resumen lazy de OBJECTIVE/TASKS/DECISIONS/CONCLUSIONS (bilingual EN/ES).
- `agent-workflow objetivo-data --code <NNN>` — tipo, modalidad, criterios, fuentes mencionadas.
- `agent-workflow decisiones-list --code <NNN>` — DEC-NNN headers + previews.
- `agent-workflow next-number docs/funcional` — numeración determinística.

## When to use

- "Informe ejecutivo", "documento funcional", "qué se hizo este trimestre para gerencia".
- Sesiones cerradas a sintetizar para reporting de gestión.
- Re-generar tras un nuevo período (mes/trimestre).
- Antes de comité de seguimiento.

## Qué hace este skill

1. Lee corpus (`.workflow/sessions/`) filtrando por `--since`, `--source`, `--period`.
2. Resuelve variante (A/B/C) por matriz `--audiencia` × `--mode` (default = B).
3. Carga plantilla `references/template-<variante>.md`.
4. Detecta condición "Oportunidades de mejora" (V4) escaneando corpus por items abiertos.
5. Renderiza prosa aplicando `references/lexico.md` (traducción técnico→ejecutiva), incluyendo tabla de Componentes impactados y Diagrama de flujo en B/C (v1.1).
6. Valida V1-V6 (`references/validations.md`).
7. Si pasa: escribe `docs/funcional/NNN-export-report-YYYY-MM-DD.md`.
8. Si falla V1/V3/V4: aborta con error report; no escribe.

## Qué NO hace

- Ejecutar commits, merges ni push (ver `agent-workflow:commits-policy`).
- Mutar el corpus de sesiones ni artefactos individuales.
- Enviar correos ni crear PRs.
- Generar diagramas Mermaid avanzados (`C4Container`, `sequenceDiagram` extenso, `erDiagram`) — esos viven en `export-arq`. El `{{DIAGRAMA_FLUJO}}` aquí es siempre `flowchart LR` (o `graph LR`) simple.
- Generar diagramas opt-in adicionales en B/C más allá del Diagrama de flujo obligatorio (máx 1 extra a pedido del usuario).
- Inferir métricas cuantitativas (sección "Métricas" no existe en ninguna variante).
- Inventar oportunidades de mejora (sólo aparecen si el corpus tiene items abiertos detectables — ver V4).

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. En plan mode esta skill describe:
- Variante resuelta + plantilla a cargar.
- Sesiones del corpus que entrarían tras filtros.
- Length estimada + secciones que aparecerían.
- Hallazgos de V4 (sección Oportunidades de mejora presente/omitida).

NO ejecuta: `Write` del `.md` output, `agent-workflow next-number` con efecto, mutaciones de cualquier tipo.

## Estilo de comunicación

`../session/references/communication-style.md`. Aplica también `agent-workflow:redaccion-simple` con preset "ejecutivo" — más estricto: cota dura, léxico tabla, traducción técnico→ejecutivo obligatoria.

## Entrada

```
/agent-workflow:export-report [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                 [--period last-quarter|last-month|YYYY-MM..YYYY-MM]
                 [--audiencia gerencia|jefatura|comite]
                 [--mode resumen|analisis|draft]
                 [--dry-run]
```

Sin flags: usa defaults `--audiencia jefatura --mode analisis` → variante B (760w).

Ejemplo con override explícito: `/agent-workflow:export-report --sessions 055,057 --audiencia jefatura --mode analisis`. `--sessions` toma precedencia sobre `--since` y `--period` (warning si discrepan).

### Matriz `--audiencia` × `--mode`

| × | `resumen` | `analisis` (default) | `draft` |
|---|---|---|---|
| `gerencia` | A (400w) | A (400w) | A (400w) |
| `jefatura` (default) | A (400w) | **B (760w)** | C (1620w) |
| `comite` | A (400w) | C (1620w) | C (1620w) |

**Conflicto entre flags**: `--mode` gana; warning informativo si discrepa con `--audiencia`.

**Racional de las celdas borde (DEC-003 session079)**: `--mode` modula el peso del informe. Celdas como `comite × resumen → A` o `gerencia × draft → A` colapsan a A por intención compacta — no hay variante B-mini ni C-mini. Si la audiencia comité necesita más profundidad que A, usar default `--mode analisis` → C (1620w). Si gerencia necesita más que A, usar `--mode draft` → A (no escala, por diseño de la matriz).

### Resolución de `--period`

- `last-month` / `last-quarter`: ventana calculada contra fecha actual del sistema (`date +%Y-%m-%d`).
- `YYYY-MM..YYYY-MM`: rango cerrado entre dos meses (inclusive ambos).
- Sin `--period`: incluye todas las sesiones cerradas.

### Resolución de `--source` (hub mode)

- Sin flag: agrega corpus de todas las fuentes declaradas en AW-PROJECT.
- Con alias: limita a una fuente. Útil para reporting por equipo en organizaciones multi-fuente.

## Flujo

### Paso 1 — Resolver contexto

```
agent-workflow project-md-upsert --read
```

Extrae `workspace_mode`, `fuentes[]`, `mode` (`hub`/`project`). Determina root del workspace y path destino:
- `hub` → `<hub>/docs/funcional/NNN-export-report-YYYY-MM-DD.md`.
- `project` → `<cwd>/docs/funcional/NNN-export-report-YYYY-MM-DD.md`.

### Paso 2 — Filtrar corpus

```
agent-workflow history-data
```

Output: lista de sesiones. Aplicar filtros:
- `--since sessionNNN`: descartar sesiones con `code < NNN`.
- `--source <alias>`: descartar sesiones que no tocan la fuente.
- `--period <window>`: descartar sesiones fuera del rango.

Si el conjunto resultante está vacío → **abortar** con:
```
{ "ok": false, "error": "No hay sesiones cerradas en el período declarado: <period>" }
```

### Paso 3 — Resolver variante

Combinar `--audiencia` + `--mode` con la matriz de arriba. Default: `B`. Cargar plantilla:

```
references/template-<variante>.md
```

Las 3 plantillas A/B/C existen en `references/template-{a,b,c}.md`. Sin fallback automático — si por algún motivo el archivo no se encuentra, abortar con `ok: false` y mensaje explícito.

### Paso 4 — Recolectar inputs por sesión + componentes

Para cada sesión del corpus filtrado:

```
agent-workflow session-artifacts --code <CODE>
agent-workflow objetivo-data --code <CODE>
agent-workflow decisiones-list --code <CODE>
```

Materiales relevantes para el render:
- OBJECTIVE / requisito / brief: qué se planteó.
- TASKS resumen (counts cerradas vs abiertas): qué se entregó.
- DECISIONS (DEC-NNN): qué se decidió.
- CONCLUSIONS (cuando exista): cierre técnico (insumo para Logros + Objetivo).
- CHECKPOINT (cuando exista): último estado conocido — fuente para "Riesgos / deuda" y "Oportunidades de mejora".

**Componentes impactados (B/C — v1.1)**: para construir la tabla `{{COMPONENTES_IMPACTADOS}}`:

1. **Listado base de componentes**: leer `project-md-upsert --read.fuentes[]`. Cada fuente declarada en el workspace es un candidato a componente. En hub mode, todas las fuentes; en project mode, una sola.
2. **Filtrar por impacto**: incluir sólo fuentes que aparecen en `objetivo-data.fuentes` o en branches declaradas por al menos 1 sesión del corpus filtrado. Las fuentes sin actividad en el período se omiten.
3. **Clasificar tipo** (heurística determinista en orden):
   - Path/alias del componente contiene `front`, `web`, `ui`, `app/src`, `angular`, `react` → **FrontEnd**.
   - Path/alias contiene `back`, `api`, `service`, `controller`, `spring`, `node-server`, `core` → **BackEnd**.
   - Path/alias o sesiones asociadas referencian `*.sql`, `esquema`, `migración`, `procedure`, `tabla` predominantemente → **Base de datos**.
   - Sin match único → derivar del corpus: si DECISIONS/CONCLUSIONS del corpus dominan en endpoints/services → BackEnd; en pantallas/componentes → FrontEnd; en scripts/tablas → Base de datos. Empate → preguntar al usuario antes de inventar.
4. **Resolver estado** por componente:
   - Todas las sesiones cerradas con tasks completas + sin items abiertos en CONCLUSIONS → **Completo**.
   - ≥1 sesión con tasks abiertas, items abiertos en CONCLUSIONS, o sesión `active` en `history-data` → **Cambios pendientes**.
5. Render: tabla markdown 3 columnas en orden de tipo (FrontEnd → BackEnd → Base de datos) y luego nombre alfabético.

**Diagrama de flujo (B/C — v1.2)**: para construir `{{DIAGRAMA_FLUJO}}`:

1. **Reuso preferente**: si existe `<docs>/arquitectura/NNN-export-arq-*/arquitectura.md` (o equivalente) en el workspace, extraer la idea del diagrama de containers/contexto y traducirla a `flowchart LR` simplificado (3-6 nodos en B; 4-8 en C). NO copiar literal el Mermaid técnico C4Container — esa notación es para `export-arq` (audiencia técnica). Aquí se sintetiza la integración entre los componentes ejecutivos.
2. **Fallback inferido**: si no hay arquitectura graduada, generar diagrama mínimo a partir de la tabla de Componentes:
   - `flowchart LR\n  FE[FrontEnd] --> BE[BackEnd] --> BD[(Base de datos)]` para flujos lineales.
   - Aristas etiquetadas (`FE -- "consulta" --> BE`) cuando DECISIONS lo justifican.
   - Si hay >1 componente del mismo tipo, separarlos por nombre legible (`FE_PA[Portal Admin]`, `FE_VE[Portal Vendedor]`).
3. Render: code fence ```` ```mermaid ```` ... ```` ``` ```` (exento de V1). Máx 15 líneas en B, 20 en C. **Default Mermaid** (DEC-002 session077; audiencia ejecutiva consume mejor el render visual del viewer); ASCII en plain code fence permanece como **fallback opt-in** cuando Mermaid no aporta claridad (1-2 nodos triviales o flujo no representable como grafo).

### Paso 5 — Detectar condición de "Oportunidades de mejora" (V4)

Recolectar de cada sesión filtrada:
- Items en `## Open (gaps)` de CONCLUSIONS.md.
- Items en `## Recommendations` / `## Recomendaciones` de CONCLUSIONS.md.
- Decisions marcadas como "pendiente" / "diferido" en DECISIONS.md.
- Menciones a "próximos pasos" / "futuras mejoras" / "oportunidades" en CHECKPOINT.md.

Si `count > 0` → incluir sección "Oportunidades de mejora" en el render. Si `count == 0` → **omitir sección completa** (sin encabezado, sin placeholder). Nunca inventar.

### Paso 6 — Renderizar prosa

Llenar la plantilla aplicando:

1. **Léxico técnico→ejecutivo** (ver `references/lexico.md`): cada placeholder recibe prosa sin acrónimos sin glosar, sin nombres internos, con verbos directos. La tabla de Componentes impactados también aplica léxico: tipo se escribe como "BackEnd"/"FrontEnd"/"Base de datos" (no "BE"/"FE"/"DB"), estado como "Completo"/"Cambios pendientes" (no "OK"/"WIP").
2. **Agrupación por capacidad** (no por sesión): los Logros se agrupan en 4-8 capacidades de negocio, no listan sesiones individuales.
3. **Cota dura por sección**: respetar `±15%` por sección (`±10%` total).
4. **`agent-workflow:redaccion-simple` preset ejecutivo**: frases cortas, listas sobre prosa, una idea por línea, sin relleno.
5. **Componentes impactados (v1.1)**: tabla 3 columnas en B (3-7 filas) o C (4-10 filas). Una fila por componente con tipo + estado determinados en Paso 4.
6. **Diagrama de flujo (v1.2)**: bloque ```` ```mermaid ```` en B/C por default — `flowchart LR` con 3-6 nodos en B, 4-8 en C. Aristas etiquetadas cuando aporten contexto ejecutivo. Si Paso 4 extrajo el diagrama desde `docs/arquitectura/`, sintetizarlo (no copiar literal el C4Container técnico) y citar el origen como nota inline al final del fence. ASCII en plain code fence es fallback opt-in cuando Mermaid no aporta claridad.
7. **Link de visualización (v1.3 — session078)**: cuando el fence sea ```` ```mermaid ````, inmediatamente después del fence de cierre, agregar una línea en blanco + blockquote con el link al render PNG: `> Ver diagrama renderizado: <https://mermaid.ink/img/BASE64>`. El BASE64 es el código Mermaid plano codificado en base64 URL-safe (RFC 4648 §5; alfabeto `A-Z a-z 0-9 - _`). El ASCII fallback (plain code fence) NO lleva link. Texto fijo "Ver diagrama renderizado" en español ejecutivo. NUNCA usar `mermaid.live/edit` (descartado por DEC-001).

### Paso 7 — Validar (V1-V6)

Aplicar checks de `references/validations.md`:
- V1 cota de palabras por variante (warning ±10%, hard fail ±20%).
- V2 léxico vetado: grep determinístico, 0 ocurrencias en cuerpo (Referencias exentas).
- V3 secciones obligatorias presentes en orden.
- V4 Oportunidades de mejora honored (presente si corpus lo justifica; omitida si no).
- V5 header bien formado (placeholders reemplazados).
- V6 referencias resolubles (paths a `docs/...` existen en filesystem).

Si V1, V3 o V4 fallan → abortar con error report estructurado. Si V2, V5 o V6 fallan → warning + opción de continuar (decisión del host AI con confirmación del usuario).

### Paso 8 — Escribir output

Si `--dry-run`: imprimir reporte (count palabras estimado, secciones que aparecerían, V4 outcome). No escribir.

Si no dry-run y validations pasan:
```
agent-workflow next-number docs/funcional
```

Escribir `docs/funcional/NNN-export-report-YYYY-MM-DD.md` con el render final. La fecha es la del sistema al momento de escritura.

### Paso 9 — Resumen al usuario

- Ruta del archivo.
- Variante usada (A/B/C).
- Conteo final de palabras (vs cota).
- Sesiones cubiertas (count + rango temporal).
- Si V4 omitió Oportunidades de mejora: nota explícita.
- Si V3 detectó `engine: ascii (fallback)` en Diagrama de flujo: nota explícita (sin warning de link, porque ASCII no lo lleva).
- Si V3 detectó Mermaid sin link mermaid.ink: warning explícito (v1.3 espera link debajo del fence).
- Warnings emitidos (V2/V5/V6).

## Composición con otras skills

- **`agent-workflow:redaccion-simple`** — preset ejecutivo aplicado durante el render (paso 6).
- **`agent-workflow:rules`** — anchors transversales (sandbox-readonly, commits-policy) consultables on-demand.
- **`session`** — este skill NO invoca graduación ni cierre. La sesión activa puede consumirlo durante validation o closure para producir un snapshot ejecutivo.

## Re-ejecución

Idempotente funcional: cada invocación toma siguiente NNN. No sobrescribe outputs previos.

Para regenerar el último output: borrar el archivo manualmente y re-invocar (decisión consciente del usuario; el skill no fuerza overwrites).

## Recursos adicionales

- **`references/template-b.md`** — plantilla canónica Variante B (default).
- **`references/template-a.md`** — plantilla compacta Variante A (rebalance de pesos v1.4: 90w Resumen + 120w Cambios + 70w Riesgos + 60w Op cond + ~100w Refs).
- **`references/template-c.md`** — plantilla extensa Variante C (tolerancia condicional V1 v1.4: ventana 1323-1617w cuando Op omitida).
- **`references/lexico.md`** — tabla determinista técnico→ejecutivo + lista vetada para V2.
- **`references/validations.md`** — V1-V6 detalladas con condiciones de hard-fail.
- **`docs/especificaciones/001-export-report-format/DELIVERY.md`** — spec autoritativa de la familia (session056).
- **`docs/conclusiones/007-export-commands-family.md`** — Propuesta original de la familia `/agent-workflow:export-*` (session055).
