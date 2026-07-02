---
name: export-manuals
description: "Manuales operativos / de onboarding (audiencia operador/soporte). Sintetiza manuales técnicos del workspace en `docs/manuals/` consolidando N sesiones (`exec`/`quick`) + `docs/`. Lee de cada sesión el `DECISION` y el plan-doc (`Solution`, `Final behavior`, `Validations`) + el código tocado en las fuentes (cómo opera/funciona lo construido). Dos modos: `complement` (default, sobrescribe `INDEX.md` apuntando a los manuales detectados) y `regenerate` (produce dossier `NNN-export-manuals-YYYY-MM-DD/` con 1 manual por tema). Audiencia: operadores / soporte / onboarding. Read-only/reporte: no commitea ni muta sesiones. La prosa sigue las convenciones de redacción ambientes (el host auto-aplica una skill de writing instalada si está presente). Úsalo para 'manual operativo', 'cómo funciona lo entregado', 'paquete de onboarding técnico', 'índice de manuales'. Invocado por el usuario vía `/w:export-manuals`."
---

# export-manuals — Manuales técnicos desde sesiones + `docs/`

Genera o refresca manuales de **operación / cómo-funciona / onboarding** en `docs/manuals/`, consolidando lo entregado en N sesiones + el corpus `docs/`. **Read-only / reporte** — no commitea, no muta sesiones ni el código.

> Familia `export-*` (la única vía artefacto→`docs/`). Recicla el espíritu del viejo `export-tech-manuals` (modos complementar/regenerar, `INDEX.md`, dossier por tema), modernizado: `docs/manuals` en inglés, sin modos project/hub, y la prosa sigue las convenciones de redacción **ambientes** (el host auto-aplica una skill de writing instalada si está presente), no un rol propio. Diseño: `docs/referencias/workflow-exports/export-manuals.md`.

## Category

`docs/manuals` — **única** carpeta `docs/` que este export escribe.

## Writing (convención ambiente, no rol)

La redacción del manual sigue las convenciones de redacción **ambientes**: el host auto-aplica una skill de writing instalada (si está presente) por su `description` — frases cortas, listas sobre prosa, sin relleno, léxico técnico para la audiencia operador/soporte. Este export **no** compone un rol `writing` ni lo bindea; es **indiferente** a qué skill de redacción exista. Una familia útil vive en el plugin `dev-conventions` del marketplace, pero el export **no depende** de él.

## When to use

- "Manual operativo", "cómo funciona lo que entregamos", "guía paso a paso".
- "Índice de manuales" / refrescar el `INDEX.md` tras nuevas sesiones.
- Paquete de **onboarding técnico** para nuevos miembros del equipo.
- Auditoría de cobertura documental.

## What it does

1. Lee el corpus de sesiones (`exec`/`quick`): por sesión, `DECISION` + el plan-doc (`Solution`, `Final behavior`, `Validations`).
2. Inspecciona el código tocado en las fuentes (cómo opera/funciona lo construido) — solo lectura.
3. Detecta temas (declarados en `SESSION` — su `## Objective` —, o inferidos por keywords operativos).
4. Resuelve el modo (`complement` o `regenerate`).
5. Sintetiza el contenido aplicando las convenciones de redacción ambientes (host).
6. Escribe: `complement` → sobrescribe `docs/manuals/INDEX.md`; `regenerate` → dossier `docs/manuals/NNN-export-manuals-YYYY-MM-DD/` con 1 manual por tema.

## What it does NOT do

- Ejecutar commits, merges, push, SQL ni envío de correos.
- Mutar sesiones, el plan-doc, ni el código de las fuentes (solo lectura).
- Escribir cualquier carpeta `docs/` que no sea `docs/manuals/` (invariante: una categoría).
- Sobrescribir un dossier `regenerate` previo (siempre next-number).
- Inventar manuales: si no hay tema detectable → en `regenerate` aborta con mensaje claro; en `complement` produce un `INDEX.md` vacío con nota inline.
- Renderizar visualmente diagramas (la arquitectura visual es de `export-diagrams`; Mermaid embebido solo si aporta).

## Read-only sandbox

En plan mode **describe**, no escribe: el modo resuelto, los temas detectados (con sesiones de origen), los manuales ya presentes en `docs/manuals/`, y — según el modo — la estructura del `INDEX.md` que sobrescribiría o el count de manuales que generaría el dossier. **No** ejecuta `Write` ni `aw next-number` con efecto.

## Inputs

**CLI `agent-workflow` (alias `aw`)** — no leer paths hardcodeados:

- `aw sessions` / `aw release-data [--since sessionNNN] [--source <alias>]` — enumera el corpus.
- `aw session-artifacts --code <NNN>` — lee `DECISION`, el plan-doc y `SESSION` (su `## Objective`, lazy) por sesión.
- `aw next-number docs/manuals` — numeración determinística (solo modo `regenerate`).

**Filesystem**:

- `docs/manuals/*.md` — manuales ya presentes (para complementar).
- `docs/manuals/INDEX.md` — re-generable (sobrescribible) en modo `complement`.
- Código de las fuentes declaradas — lectura para describir el comportamiento.

**Args** (sin *structured-choice* de ciclo de vida — capacidad del arnés; ver [`../../harness/SKILL.md`](../../harness/SKILL.md)):

```
/w:export-manuals [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                  [--mode complement|regenerate] [--topics slug1,slug2] [--dry-run]
```

| Flag | Comportamiento |
|---|---|
| `--sessions NNN[,NNN]` | Filtro discreto por código (precede a `--since`) |
| `--since sessionNNN` | Solo sesiones posteriores a NNN (exclusivo: la propia NNN no entra; usá `--sessions` para incluirla) |
| `--source <alias>` | Limita a una fuente (workspace multi-fuente) |
| `--mode complement\|regenerate` | Default `complement` |
| `--topics slug1,slug2` | Limita a los temas declarados |
| `--dry-run` | Reporte propositivo sin escribir archivos |

Sin args: `--mode complement` sobre todo el corpus. *(Si algún flag exacto difiere en el CLI runtime, ajustar al contrato real de `aw`.)*

### Resolución de `--mode`

| Modo | Output | Cuándo usar |
|---|---|---|
| `complement` (default) | `docs/manuals/INDEX.md` (sobrescribe) | Refrescar el índice tras nuevas sesiones/manuales |
| `regenerate` | `docs/manuals/NNN-export-manuals-YYYY-MM-DD/` (next-number) | Paquete consolidado de manuales (ej. onboarding) |

## Flow

### Paso 1 — Resolver contexto y corpus

`aw sessions` / `release-data` aplicando `--sessions`/`--since`/`--source`. La resolución de la carpeta destino la maneja el CLI.

### Paso 2 — Inspeccionar manuales presentes

Listar `docs/manuals/*.md` (excluyendo `INDEX.md` y subdirectorios `NNN-export-manuals-*/`). Por manual: slug (del filename), título (primer `#`), resumen breve (primer párrafo), path.

### Paso 3 — Detectar temas

Por cada sesión del corpus filtrado (`aw session-artifacts --code <NNN>`): leer `DECISION` + plan-doc (`Solution`/`Final behavior`/`Validations`) + el código tocado. Tema **primario**: la sección de temas en `SESSION` (su `## Objective`). **Secundario**: inferencia por keywords operativos ("configurar", "instalar", "paso a paso", "cómo …"). Filtrar por `--topics` si está presente. Listar (slug, confidence, sesiones de origen).

### Paso 4 — Sintetizar (prosa: convenciones ambientes)

**Modo `complement`** — un `INDEX.md`: cabecera + count de manuales + tabla (Tema · Slug · Manual presente/`[pendiente]` · Sesiones de origen) + "Próximos pasos" si hay temas pendientes.

**Modo `regenerate`** — 1 `.md` por tema en el dossier, cada uno con: Propósito · Pre-requisitos · Pasos numerados (cómo operar) · Comportamiento final (del plan-doc) · Validación post-uso · Decisiones relevantes (`DECISION`) · Troubleshooting · Referencias. Cada manual debe permitir al operador completar la tarea **sin** invocar al equipo de desarrollo. Más un `README.md` del dossier con el índice. La redacción sigue las convenciones de redacción ambientes (host).

### Paso 5 — Escribir o reportar

Si `--dry-run`: imprimir el reporte; no escribir. Si no: `complement` → `Write` sobre `docs/manuals/INDEX.md`; `regenerate` → `aw next-number docs/manuals` + crear el dossier. **NUNCA commitear**. Resumen al usuario: modo + paths escritos + counts; si hay temas detectables sin manual, sugerir cubrirlos.

## Output location

- `complement`: `docs/manuals/INDEX.md` (sobrescribe).
- `regenerate`: `docs/manuals/NNN-export-manuals-YYYY-MM-DD/` con `README.md` + 1 `.md` por tema.

## Re-run

- `complement`: idempotente — dos invocaciones con el mismo corpus producen el mismo `INDEX.md`.
- `regenerate`: cada invocación toma el siguiente `NNN`; no sobrescribe dossiers previos.

## Resources

- Design: `docs/referencias/workflow-exports/export-manuals.md` · familia: [`../README.md`](../README.md).
- Redacción: convención **ambiente** (no rol) — el host auto-aplica una skill de writing instalada si está presente.
- Artefactos fuente: `DECISION` + plan-doc (ver `docs/referencias/workflow-artifacts/artifacts-exec/` y `docs/specs`/`docs/plans`).
- Siblings: [`../export-scripts/SKILL.md`](../export-scripts/SKILL.md) · [`../export-diagrams/SKILL.md`](../export-diagrams/SKILL.md) · [`../export-reports/SKILL.md`](../export-reports/SKILL.md).
