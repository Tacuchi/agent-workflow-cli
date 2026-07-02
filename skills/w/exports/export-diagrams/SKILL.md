---
name: export-diagrams
description: "Genera diagramas de arquitectura y flujos del workspace en `docs/diagrams/` consolidando el código de las fuentes + el plan-doc (`Current state (AS-IS)` / `Target state (TO-BE)`, `Impacted`) de N sesiones. Produce contexto, contenedores, componentes, integraciones y modelo de datos (si MCP read-only disponible). Default `mermaid` (renderiza en GitHub, link `mermaid.ink` para preview); `c4`/structurizr opt-in vía `--engine`. Output en `docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/` (o `.md`). Read-only/reporte: emite solo el source del diagrama (el render visual lo hace el lector); no commitea ni muta nada; MCP solo lecturas. Compone la capacidad `diagrams`. Úsalo para 'diagrama del sistema', 'C4 del workspace', 'mapa de arquitectura/flujos'. Invocado por el usuario vía `/w:export-diagrams`."
---

# export-diagrams — Diagramas de arquitectura y flujos desde código + plan-doc

Genera un dossier de diagramas (**arquitectura y flujos**) del workspace, agregando la estructura de las fuentes y el delta de las sesiones. **Read-only / reporte** — emite solo el **source** del diagrama (Mermaid / DSL); el render visual lo hace el lector. No commitea, no muta nada; MCP solo lecturas.

> Familia `export-*` (la única vía artefacto→`docs/`). Recicla el espíritu del viejo `export-arq` (C4, niveles contexto/contenedores/componentes, integraciones, modelo de datos), reubicado a `docs/diagrams` y modernizado: default `mermaid` (en vez de structurizr), sin modos project/hub, y la generación la aporta la capacidad `diagrams` (no una skill propia). Diseño: `docs/referencias/workflow-exports/export-diagrams.md`.

## Category

`docs/diagrams` — **única** carpeta `docs/` que este export escribe.

## Composes

Capacidad **`diagrams`** (built-in default `diagrams`), resuelta vía `.workflow/skills.toml`. Aporta el motor de render (Mermaid C4 nativo / Structurizr DSL), los niveles C1–C4 y la convención del link de preview. Este export **no** posee esa lógica: la compone. Rebindeable u `off` por config.

## When to use

- "Diagrama del sistema", "C4 del workspace", "mapa de arquitectura".
- "Diagrama de flujo" entre componentes / integraciones tocadas.
- Onboarding técnico; antes de cambios estructurales (validar arquitectura vigente); auditoría técnica.

## What it does

1. Inspecciona el código de las fuentes del workspace (estructura, wiring, integraciones, tecnologías).
2. Lee de las sesiones el plan-doc: `Current state (AS-IS)` / `Target state (TO-BE)` y `Impacted` (qué cambió y dónde).
3. (Opcional) Si MCP read-only está disponible y se pide modelo de datos: consulta esquemas BD (solo lectura).
4. Resuelve el motor (`--engine`) y consolida la arquitectura/flujos tocados por las N sesiones.
5. Renderiza los diagramas (compone `diagrams`): contexto, contenedores, componentes, integraciones, modelo de datos (si aplica).
6. Escribe el dossier en `docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/` con un `README.md` (índice + cómo leer).

## What it does NOT do

- Ejecutar commits, merges, push, ni SQL.
- Mutar sesiones, el plan-doc ni el código (solo lectura). MCP **solo** lecturas read-only (nunca DML/DDL).
- Escribir cualquier carpeta `docs/` que no sea `docs/diagrams/` (invariante: una categoría).
- **Renderizar visualmente** el diagrama: emite solo el source (Mermaid / DSL); el render lo hace el lector con sus herramientas (o el link `mermaid.ink`).
- Validar que las integraciones funcionen (eso es del doctor) ni inventar componentes ausentes.
- Sobrescribir dossiers previos (siempre next-number).

## Read-only sandbox

En plan mode **describe**, no escribe: el motor resuelto, los niveles/secciones que aparecerían (resueltos por args), las fuentes a inspeccionar + integraciones detectadas, y — si se pide modelo de datos — las queries MCP propuestas con su costo estimado. **No** ejecuta `Write`, ni mutaciones MCP, ni `aw next-number` con efecto.

## Inputs

**CLI `agent-workflow` (alias `aw`)** — no leer paths hardcodeados:

- `aw sessions` / `aw release-data [--since sessionNNN] [--source <alias>]` — enumera el corpus (insumo del delta AS-IS/TO-BE).
- `aw session-artifacts --code <NNN> --dump objetivo` — ubica la sesión y su referencia al plan-doc; `AS-IS`/`TO-BE`/`Impacted` se leen del plan-doc por su path.
- `aw next-number docs/diagrams` — numeración determinística (la resolución de la carpeta destino la maneja el CLI).

**Filesystem / código**:

- Código de las fuentes declaradas (estructura, wiring, manifests de tecnología).
- `docs/diagrams/` existentes (para complementar / no colisionar).

**MCP read-only** (opcional, solo si se pide modelo de datos y está configurado): `\d <tabla>`, `SELECT count(*)`, relaciones FK para el `erDiagram`. Con cost guard.

**Args** (sin *structured-choice* de ciclo de vida — capacidad del arnés; ver [`../../harness/SKILL.md`](../../harness/SKILL.md)):

```
/w:export-diagrams [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                   [--engine mermaid|c4] [--scope c4|integrations|data|todo] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto por código (precede a `--since`); afecta el delta AS-IS/TO-BE |
| `--since sessionNNN` | Solo sesiones posteriores a NNN (exclusivo: la propia NNN no entra; usá `--sessions` para incluirla) |
| `--source <alias>` | Limita a una fuente (workspace multi-fuente) |
| `--engine mermaid\|c4` | Default `mermaid` (render en GitHub); `c4` = Structurizr DSL opt-in |
| `--scope` | Qué secciones aparecen: `c4` (contexto/contenedores/componentes), `integrations`, `data` (solo si MCP), `todo` (default) |
| `--dry-run` | Reporte propositivo sin escribir archivos |

Sin args: `--engine mermaid --scope todo`. El **snapshot** del sistema es siempre el último estado conocido; `--since`/`--sessions` modulan el énfasis del delta (qué se tocó), no el snapshot base. *(Si algún flag exacto difiere en el CLI runtime, ajustar al contrato real de `aw`.)*

## Flow

### Paso 1 — Resolver contexto y corpus

`aw sessions` / `release-data` aplicando `--sessions`/`--since`/`--source`. La resolución de la carpeta destino la maneja el CLI.

### Paso 2 — Inspeccionar las fuentes

Por cada fuente: estructura básica, componentes internos (módulos, servicios, comandos, hooks, MCP configurado), tecnologías por manifest (`package.json`, `pom.xml`, …), integraciones externas.

### Paso 3 — Leer el delta del corpus

Por sesión filtrada (`aw session-artifacts --code <NNN> --dump objetivo`): seguir la referencia al plan-doc y leer `Current state (AS-IS)` / `Target state (TO-BE)` e `Impacted`. Sirve para resaltar lo que cambió sobre el snapshot vigente.

### Paso 4 — Inspeccionar MCP (opcional)

Si `--scope` incluye `data` y hay MCP read-only: `\d <tabla>`, `count(*)`, relaciones FK (con cost guard). Si no disponible → omitir la sección "Modelo de datos" con nota inline.

### Paso 5 — Renderizar (compone `diagrams`)

Según `--engine`: `mermaid` → bloques Mermaid C4 nativos (`C4Context`/`C4Container`/`C4Component`) y `flowchart` para flujos; `c4` → `workspace.dsl` Structurizr aparte + Mermaid auxiliar embebido para lectura offline. Por cada bloque ```` ```mermaid ````, agregar inmediatamente después del fence de cierre un blockquote con el link de preview: `> Ver diagrama renderizado: <https://mermaid.ink/img/BASE64>` (base64 URL-safe del código plano). No aplica a `workspace.dsl`.

### Paso 6 — Escribir o reportar

Si `--dry-run`: imprimir el reporte; no escribir. Si no: `aw next-number docs/diagrams` + escribir el dossier. **NUNCA commitear**. Resumen al usuario: motor, secciones presentes/omitidas (p.ej. Datos omitido si no MCP) y ruta.

## Output location

```
docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/
├── README.md          # índice + cómo leer + counts
├── diagrams.md        # documento principal con Mermaid embebido (+ links mermaid.ink)
└── workspace.dsl      # solo con --engine c4 (Structurizr)
```

## Re-run

Idempotente funcional: cada invocación toma el siguiente `NNN`; no sobrescribe dossiers previos. Para regenerar: borrar el directorio y re-invocar.

## Resources

- Design: `docs/referencias/workflow-exports/export-diagrams.md` · familia: [`../README.md`](../README.md).
- Capacidad compuesta: `diagrams` (built-in default; ver `docs/referencias/workflow-roles/`).
- Insumo: plan-doc `AS-IS`/`TO-BE`/`Impacted` (ver `docs/plans`).
- Siblings: [`../export-scripts/SKILL.md`](../export-scripts/SKILL.md) · [`../export-manuals/SKILL.md`](../export-manuals/SKILL.md) · [`../export-reports/SKILL.md`](../export-reports/SKILL.md).
