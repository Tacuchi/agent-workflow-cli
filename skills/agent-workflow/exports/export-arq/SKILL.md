---
name: export-arq
description: "Genera documentación técnica de arquitectura (`.md` con diagramas C4 embebidos) consolidando sesiones del workspace + `docs/` (especificaciones, decisiones, arq existente). Output: contexto, contenedores, componentes, integraciones externas, modelo de datos (si MCP disponible), decisiones arquitectónicas y riesgos/deuda. Structurizr DSL por default (notación C4 formal); Mermaid y PlantUML opt-in vía `--diagrams`. Bloques Mermaid embebidos incluyen link `https://mermaid.ink/img/<base64>` para preview sin renderer local. Output en `docs/arquitectura/NNN-export-arq-YYYY-MM-DD/`. Read-only sobre corpus + MCP read-only para schemas. Audiencia: devs/arquitectos. Invocado sólo vía `/agent-workflow:export-arq`. Historial de versiones en CHANGELOG del CLI bundleado."
version: 1.3.0
---

> **Profile parametrization**: lee `mcp_databases[]` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# Export Arq — Documentación de arquitectura desde fuentes + corpus

Genera un dossier técnico de arquitectura del workspace, agregando fuentes declaradas, integraciones externas y decisiones tomadas. **Read-only / reporte** — no commitea, no muta nada.

> Segundo comando de la familia `/agent-workflow:export-*`. Hermano de `export-func` (informe ejecutivo). Propuesta del modelo: `docs/conclusiones/007-export-commands-family.md`.

## Excepción session-aware

Este skill requiere conocimiento del lifecycle. **No crea ni modifica sesiones**. Si el workspace no tiene AW-PROJECT con fuentes declaradas → abortar con `ok: false`.

**Solo formato actual (v0.9+)**: sesiones legacy abortan; migrar con `/agent-workflow:migrate --upgrade-topology`.

**Consumo de CLI `agent-workflow`** (no leer paths hardcodeados):
- `agent-workflow project-md-upsert --read` — `workspace_mode`, fuentes, integraciones declaradas, working branches.
- `agent-workflow history-data` — sesiones cerradas (insumo de decisiones + riesgos).
- `agent-workflow session-artifacts --code <NNN>` — lectura lazy de OBJECTIVE/DECISIONS/CONCLUSIONS por sesión.
- `agent-workflow decisiones-list --code <NNN>` — DEC-NNN cronológicas.
- `agent-workflow next-number docs/arquitectura` — numeración determinística.

**MCP read-only** (opcional, sólo si `--scope` incluye `datos` y MCP está configurado):
- `<mcp-cert>` / `<mcp-prod>` — `SELECT count(*)`, `EXPLAIN`, `\d <tabla>` para esquemas BD.

## When to use

- "Documento de arquitectura", "diagrama del sistema", "C4 del workspace".
- Onboarding técnico de nuevos miembros del equipo.
- Antes de cambios estructurales (validar arquitectura vigente).
- Auditoría técnica.
- Acompañamiento a propuestas de cambio mayor.

## Qué hace este skill

1. Lee AW-PROJECT (fuentes + mode + integraciones declaradas).
2. Lee corpus de sesiones cerradas (decisiones arquitectónicas + riesgos abiertos).
3. Inspecciona filesystem por fuente: hooks instalados, MCP configurado, plugins/commands.
4. Si `--scope` incluye `datos` y MCP disponible: consulta esquemas BD (read-only).
5. Selecciona variante de diagrama (`--diagrams`) y plantilla.
6. Renderiza secciones según `--scope`.
7. Aplica validations V1-V6 (`references/validations.md`).
8. Si pasa: escribe `docs/arquitectura/NNN-export-arq-YYYY-MM-DD/`.
9. Si `--dry-run`: imprime reporte (secciones que aparecerían, counts, variante).

## Qué NO hace

- Ejecutar commits, merges, push, SQL ni envío de correos.
- Mutar corpus de sesiones ni AW-PROJECT.
- Validar que las integraciones declaradas funcionen (eso es `/agent-workflow:doctor`).
- Renderizar visualmente el diagrama (sólo source Mermaid/DSL/PUML; el render visual lo hace el lector con sus herramientas).
- Filtrar el "estado actual" del sistema por `--since` o `--period` (el snapshot es siempre el último); esos flags sólo afectan la sección "Decisiones arquitectónicas".

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. En plan mode esta skill describe:
- Variante de diagrama resuelta + plantilla a cargar.
- Secciones que aparecerían (resolvidas por `--scope`).
- Fuentes a inspeccionar + integraciones declaradas.
- Si `--scope datos`: queries MCP propuestas con costo estimado (cost guard).
- Hallazgos de V4 (Modelo de datos presente/omitido, Decisiones presentes/omitidas).

NO ejecuta: `Write` del `.md` output, mutaciones MCP, `next-number` con efecto.

## Estilo de comunicación

`../session/references/communication-style.md`. La audiencia es técnica — sin léxico ejecutivo. `agent-workflow:redaccion-simple` aplica con preset default (frases cortas, listas sobre prosa, sin relleno). No hay traducción técnica→ejecutiva.

## Entrada

```
/agent-workflow:export-arq [--since sessionNNN] [--source <alias>]
                [--diagrams mermaid|structurizr|plantuml]
                [--scope c4|integraciones|datos|decisiones|riesgos|todo]
                [--dry-run]
```

### Matriz `--diagrams` × `--scope`

`--diagrams` selecciona el motor del render de C4; `--scope` selecciona qué secciones aparecen.

| `--scope` | Secciones presentes |
|---|---|
| `c4` | Sistema (C4 Context) + Contenedores (C4 Container) + Componentes (C4 Component) |
| `integraciones` | Integraciones externas |
| `datos` | Modelo de datos (sólo si MCP disponible) |
| `decisiones` | Decisiones arquitectónicas |
| `riesgos` | Riesgos y deuda |
| `todo` (default) | Todas las secciones aplicables |

| `--diagrams` | Motor de C4 |
|---|---|
| `structurizr` (default) | `workspace.dsl` aparte + Mermaid auxiliar embebido en MD (lectura offline) |
| `mermaid` | Mermaid C4Context / C4Container / C4Component nativo embebido en MD (sin DSL aparte) |
| `plantuml` | `arquitectura.puml` aparte (C4-stdlib) + nota en MD |

**Regla canónica del default (DEC-004 session077)**: `export-arq` cubre documentación técnica / manuales / dossiers de arquitectura. Structurizr DSL es el estándar C4 formal (separa modelo de vistas, soporta tooling externo). Mermaid permanece como opt-in cuando se prefiere render embebido sin DSL separado.

### Resolución de `--since` y `--source`

- `--since sessionNNN`: filtra **sólo** la sección "Decisiones arquitectónicas" (cronológicas). El snapshot del sistema vigente NO se filtra por `--since`.
- `--source <alias>`: limita el output a esa fuente y sus integraciones internas; con default agrega todas las fuentes del hub.

### `--sessions` excluido

`export-arq` produce un **snapshot del sistema vigente** (estado actual de C4, integraciones, datos, riesgos). La selección discreta de sesiones por código (`--sessions NNN[,NNN]`) **no aplica** a este export: el snapshot siempre refleja el último estado conocido. Sólo `--since sessionNNN` afecta cronológicamente la sub-sección "Decisiones arquitectónicas". Decisión canónica G4 de `docs/conclusiones/008-roadmap-export-plan-lifecycle.md` (session062).

## Flujo

### Paso 1 — Resolver contexto

```
agent-workflow project-md-upsert --read
```

Extrae `workspace_mode`, `fuentes[]`, integraciones declaradas, `mode` (hub/project). Determina root del workspace + path destino:
- `hub` → `<hub>/docs/arquitectura/NNN-export-arq-YYYY-MM-DD/`.
- `project` → `<cwd>/docs/arquitectura/NNN-export-arq-YYYY-MM-DD/`.

### Paso 2 — Inspeccionar fuentes y sus internas

Por cada fuente declarada:
- Resolver `<source.path>` → leer estructura básica.
- Detectar componentes internos: `commands/`, `skills/`, `hooks/`, `.claude-plugin/`, MCP configurado.
- Detectar tecnologías (lenguaje, framework) por archivos de manifest (`package.json`, `pom.xml`, etc.).

### Paso 3 — Filtrar corpus para decisiones

```
agent-workflow history-data
```

Aplicar filtro `--since sessionNNN` sólo si está presente.

Para cada sesión cerrada del corpus filtrado:
```
agent-workflow decisiones-list --code <CODE>
```

Acumular DEC-NNN cronológicas. Si 0 DEC → V4 omite sección "Decisiones".

### Paso 4 — Inspeccionar MCP (opcional)

Si `--scope` incluye `datos` y MCP `<mcp-cert>` o `<mcp-prod>` está configurado:
- `\d <tabla_principal>` por cada esquema relevante.
- `SELECT count(*) FROM <tabla>` para magnitud (cost guard: ver `agent-workflow:analyze-investigate/references/cost-guard.md`).
- Recolectar relaciones FK para erDiagram.

Si MCP no disponible o `--scope` excluye `datos` → V4 omite sección "Modelo de datos" con nota inline.

### Paso 5 — Identificar riesgos y deuda

Escanear corpus filtrado por keywords:
- `## Open (gaps)` en CONCLUSIONS.md.
- "deuda técnica" / "deuda funcional" / "riesgo" en CHECKPOINT.md o CONCLUSIONS.md.
- Sesiones con estado `requirement` o `planning` no cerradas > 30 días → deuda de "trabajo en curso estancado".

### Paso 6 — Resolver variante y cargar plantilla

```
references/template-c4.md
```

Reglas por flag:
- **`--diagrams structurizr` (default)** → cargar `references/template-structurizr.dsl` y rellenarlo con el modelo + vistas. El `arquitectura.md` incluye además un Mermaid auxiliar embebido derivado del DSL (fallback offline).
- **`--diagrams mermaid`** → omitir `workspace.dsl`; el `arquitectura.md` lleva Mermaid C4 nativo (`C4Context`/`C4Container`/`C4Component`).
- **`--diagrams plantuml`** → cargar `references/template-plantuml.puml` (opt-in C4-stdlib); `arquitectura.md` deja nota inline apuntando al `.puml`.

### Paso 7 — Renderizar secciones

Aplicar:
1. **Plantilla** con placeholders reemplazados por datos del corpus.
2. **Léxico técnico mínimo** (`references/lexico-tecnico.md`): cero placeholders sin reemplazar, cero fragments de plantilla, cero paths absolutos del developer, sin jerga inventada sin glosa.
3. **`agent-workflow:redaccion-simple` preset default**: frases cortas, listas sobre prosa, sin relleno.
4. **Link de visualización por bloque Mermaid (v1.2 — session078)**: por cada bloque ```` ```mermaid ```` en arquitectura.md (Mermaid auxiliar bajo Structurizr default, o Mermaid C4 nativo bajo `--diagrams mermaid`), agregar inmediatamente después del fence de cierre: línea en blanco + blockquote `> Ver diagrama renderizado: <https://mermaid.ink/img/BASE64>`. El `BASE64` es el código Mermaid plano codificado en base64 URL-safe (RFC 4648 §5; alfabeto `A-Z a-z 0-9 - _`). Texto fijo "Ver diagrama renderizado" en español técnico. NO aplica a `workspace.dsl` ni `arquitectura.puml` (mermaid.ink solo renderiza Mermaid).

### Paso 8 — Validar (V1-V6)

Aplicar checks de `references/validations.md`:
- V1 estructura (secciones requeridas por `--scope` presentes).
- V2 noise vetado (grep determinístico).
- V3 secciones en orden.
- V4 condicionales (Datos omitido si no MCP; Decisiones omitido si 0 DEC).
- V5 header bien formado.
- V6 referencias resolubles (paths a `docs/<categoria>/`).

Si V1, V3 o V4 fallan → abortar con error report. V2, V5, V6 → warning.

### Paso 9 — Escribir output

Si `--dry-run`: imprimir reporte (count secciones, variante, V4 outcome). No escribir.

Si pasa: `agent-workflow next-number docs/arquitectura` → escribir directorio:

```
docs/arquitectura/NNN-export-arq-YYYY-MM-DD/
├── README.md            # índice + counts + how-to-read
├── arquitectura.md      # documento principal con Mermaid auxiliar embebido (lectura offline)
├── workspace.dsl        # default (--diagrams structurizr); ausente sólo con --diagrams mermaid
└── arquitectura.puml    # opcional (--diagrams plantuml)
```

## Composición con otras skills

- **`agent-workflow:redaccion-simple`** — preset default aplicado durante el render (paso 7).
- **`agent-workflow:rules`** — anchors transversales (sandbox-readonly, commits-policy) consultables.
- **`agent-workflow:analyze-investigate`** — referenciable para reglas de cost guard MCP cuando `--scope datos`.
- **`session`** — este skill NO invoca graduación ni cierre. La sesión activa puede consumirlo durante validation o closure para producir un snapshot de arquitectura.

## Re-ejecución

Idempotente funcional: cada invocación toma siguiente NNN. No sobrescribe outputs previos.

Para regenerar el último: borrar el directorio manualmente y re-invocar.

## Recursos adicionales

- **`references/template-c4.md`** — plantilla canónica con C4 Levels 1-3 + integraciones + datos + decisiones + riesgos.
- **`references/template-structurizr.dsl`** — Phase 4 opt-in (`workspace.dsl` con `model` + `views`).
- **`references/template-plantuml.puml`** — Phase 4 opt-in (C4-stdlib).
- **`references/lexico-tecnico.md`** — lista mínima de "noise" vetado para V2.
- **`references/validations.md`** — V1-V6 detalladas con condiciones de hard-fail.
- **`docs/conclusiones/007-export-commands-family.md`** — Propuesta original de la familia `/agent-workflow:export-*` (session055).
- **`agent-workflow/skills/export-func/SKILL.md`** — hermano (informe ejecutivo) que comparte patrón estructural.
