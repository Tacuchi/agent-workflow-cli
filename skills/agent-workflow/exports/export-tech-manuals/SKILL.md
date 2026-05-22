---
name: export-tech-manuals
description: "Genera y mantiene manuales técnicos del workspace en `docs/manuales/` consolidando sesiones + `docs/` (manuales/, decisiones/, especificaciones/ como referencias técnicas). Dos modos: `complementar` (default, sobrescribe `INDEX.md` apuntando a manuales graduados + detectables del corpus) y `regenerar` (produce dossier `NNN-export-tech-manuals-YYYY-MM-DD/` con 1 manual por tema detectado). Audiencia: operadores / soporte / onboarding. Read-only sobre corpus + `docs/manuales/` existente; sin commits autónomos. Invocado sólo vía `/agent-workflow:export-tech-manuals`. v1.1 (session081): corpus extendido formalmente a `docs/` además de sesiones (DEC-002) — ver `docs/shared-contract/export-corpus-sources.md`."
version: 1.1.0
---

# Export Tech Manuals — Manuales técnicos desde corpus + graduados

Tercer comando de la familia `/agent-workflow:export-*`. Genera un índice consolidado de manuales (modo default `complementar`) o un dossier completo con manuales sintetizados (modo `regenerar`). **Read-only / reporte** — no commitea, no muta nada del corpus.

> Propuesta original: `docs/conclusiones/007-export-commands-family.md` §1.3. Pattern hermano: `agent-workflow/skills/export-arq/`.

## Excepción session-aware

Este skill requiere conocimiento del lifecycle. **No crea ni modifica sesiones**. Si el workspace no tiene AW-PROJECT con fuentes declaradas → abortar con `ok: false`.

**Consumo de CLI `agent-workflow`** (no leer paths hardcodeados):
- `agent-workflow project-md-upsert --read` — `workspace_mode`, fuentes.
- `agent-workflow history-data` — sesiones cerradas para detectar temas/manuales no graduados.
- `agent-workflow session-artifacts --code <NNN>` — OBJECTIVE + CHECKPOINT + (MANUAL.md si existe) por sesión.
- `agent-workflow next-number docs/manuales` — sólo modo `regenerar`.

**Lectura del filesystem**:
- `docs/manuales/*.md` — manuales ya graduados (`kind=manual`).
- `docs/manuales/INDEX.md` — sobrescribible (re-generable) en modo `complementar`.

## When to use

- "Manual operativo", "índice de manuales", "consolidar guías técnicas".
- Tras agregar manuales nuevos via `agent-workflow graduate --kind manual`, refrescar el índice.
- Paquete de onboarding técnico para nuevos miembros del equipo.
- Auditoría de cobertura documental.

## Qué hace este skill

1. Lee AW-PROJECT (fuentes + mode).
2. Lee `docs/manuales/*.md` (manuales graduados).
3. Escanea corpus de sesiones cerradas detectando temas / manuales no graduados.
4. Resuelve modo (`complementar` o `regenerar`).
5. Aplica filtros `--since`, `--source`, `--temas` si están presentes.
6. Carga plantilla (`template-index.md` o `template-manual.md`).
7. Renderiza output aplicando léxico técnico mínimo.
8. Valida V1-V6 (`references/validations.md`).
9. Si pasa:
   - `complementar`: sobrescribe `docs/manuales/INDEX.md`.
   - `regenerar`: escribe `docs/manuales/NNN-export-tech-manuals-YYYY-MM-DD/` con 1 manual por tema.

## Qué NO hace

- Ejecutar commits, merges, push, SQL ni envío de correos.
- Mutar manuales ya graduados (sólo los lee).
- Mutar corpus de sesiones.
- Sobrescribir un dossier `regenerar` previo (siempre next-number).
- Renderizar visualmente diagramas (los manuales son texto; Mermaid embebido si aporta, pero no es obligatorio).
- Inventar manuales: si no hay tema detectable, abortar con error claro en modo `regenerar`; en modo `complementar` produce INDEX vacío con nota inline.

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md`. En plan mode esta skill describe:
- Modo resuelto + plantilla a cargar.
- Manuales graduados detectados (lista).
- Temas detectables del corpus (lista + confidence).
- Modo `regenerar`: count de manuales que se generarían.
- Modo `complementar`: estructura del INDEX que se sobrescribiría.

NO ejecuta: `Write` del INDEX o de los manuales, `agent-workflow next-number` con efecto, mutaciones.

## Estilo de comunicación

`../session/references/communication-style.md`. La audiencia es técnica — sin léxico ejecutivo. `agent-workflow:redaccion-simple` aplica con preset default. Foco en accionabilidad: cada manual debe permitir al operador completar la tarea sin invocar al equipo de desarrollo.

## Entrada

```
/agent-workflow:export-tech-manuals [--sessions NNN[,NNN]] [--since sessionNNN] [--source <alias>]
                          [--mode complementar|regenerar]
                          [--temas slug1,slug2]
                          [--dry-run]
```

### Defaults

- `--mode complementar`.
- Sin `--sessions` (todo el corpus).
- Sin `--since` (todo el corpus). Ignorado si `--sessions` presente.
- Sin `--source` (hub completo).
- Sin `--temas` (todos los temas detectables).

Ejemplo: `/agent-workflow:export-tech-manuals --sessions 055,057,061` consolida sólo esas 3 sesiones.

### Resolución de `--mode`

| Modo | Output | Cuándo usar |
|---|---|---|
| `complementar` (default) | `docs/manuales/INDEX.md` (sobrescribe) | Refresh del índice tras agregar manuales graduados |
| `regenerar` | `docs/manuales/NNN-export-tech-manuals-YYYY-MM-DD/` (next-number) | Paquete consolidado de manuales (ej. onboarding) |

### Detección de temas

- **Fuente primaria**: `## Topics` o `## Temas` en OBJECTIVE.md de las sesiones del corpus.
- **Fuente secundaria**: inferencia por keywords en OBJECTIVE/CHECKPOINT (confidence > 0.6).
- **Override explícito**: `--temas slug1,slug2` limita a los slugs declarados.

## Flujo

### Paso 1 — Resolver contexto

```
agent-workflow project-md-upsert --read
```

Extrae `workspace_mode`, `fuentes[]`, `mode`. Determina root del workspace + path destino:
- `hub` → `<hub>/docs/manuales/`.
- `project` → `<cwd>/docs/manuales/`.

### Paso 2 — Inspeccionar manuales graduados

Listar `docs/manuales/*.md` (excluyendo `INDEX.md` y subdirectorios `NNN-export-tech-manuals-*/`).

Para cada manual graduado, extraer:
- Slug (del filename `NNN-<slug>.md`).
- Título (primer `# ` header).
- Resumen breve (primer párrafo, ≤200 caracteres).
- Path canónico.

### Paso 3 — Detectar temas/manuales no graduados

```
agent-workflow history-data
```

Para cada sesión cerrada del corpus filtrado por `--since` / `--source`:

```
agent-workflow session-artifacts --code <CODE>
```

Buscar:
- Sección `## Topics` / `## Temas` en OBJECTIVE.md → slug declarado.
- Archivo `MANUAL.md` dentro de la sesión (si existe).
- Keywords operativos en OBJECTIVE/CHECKPOINT que sugieran un manual: "configurar", "instalar", "wizard", "paso a paso", "cómo hacer", etc.

Listar temas detectados con (slug, confidence, sesiones de origen).

Filtrar por `--temas slug1,slug2` si está presente.

### Paso 4 — Resolver modo

| Modo | Acción |
|---|---|
| `complementar` | Cargar `references/template-index.md` |
| `regenerar` | Cargar `references/template-manual.md` |

### Paso 5 — Renderizar

**Modo `complementar`**:
- Cabecera: título + count de manuales totales (graduados + detectables).
- Tabla principal con columnas: Tema · Slug · Manual graduado (path o `[no graduado]`) · Sesiones de origen.
- Sección "Próximos pasos sugeridos" si hay temas con `[no graduado]`.

**Modo `regenerar`**:
- 1 archivo `.md` por tema en el dossier.
- Cada archivo sigue `template-manual.md`: Propósito · Pre-requisitos · Pasos numerados · Validación post-uso · Troubleshooting · Referencias.
- `README.md` del dossier con índice de manuales generados.

Aplicar `references/lexico-tecnico.md` durante el render (limpieza de noise).

### Paso 6 — Validar (V1-V6)

`references/validations.md`. Reglas adaptadas a los 2 modos:
- V1 estructura por modo (INDEX con tabla principal vs dossier con N manuales completos).
- V2 noise vetado.
- V3 secciones de `template-manual.md` (sólo modo `regenerar`).
- V4 condicionales (modo `regenerar` con 0 temas → abort; modo `complementar` con 0 manuales → INDEX con nota).
- V5 header.
- V6 referencias resolubles (paths a manuales graduados).

Si V1, V3 o V4 fallan → abortar.

### Paso 7 — Escribir output

Si `--dry-run`: imprimir reporte. No escribir.

Si pasa:
- `complementar`: `Write` sobre `docs/manuales/INDEX.md` (sobrescribe).
- `regenerar`: `agent-workflow next-number docs/manuales` → crear directorio + N archivos.

### Paso 8 — Resumen al usuario

- Modo + paths escritos.
- Counts: manuales graduados detectados, temas no graduados detectables, manuales generados (modo `regenerar`).
- Warnings: V5/V6 si emitieron.
- Sugerencia: si hay temas detectables sin graduar, sugerir abrir sesiones dedicadas para producirlos formalmente.

## Composición con otras skills

- **`agent-workflow:redaccion-simple`** — preset default aplicado durante el render.
- **`agent-workflow:rules`** — anchors transversales consultables.
- **`session`** — este skill NO invoca graduación ni cierre. Una sesión activa puede consumirlo durante validation/closure para refrescar INDEX tras graduar un nuevo manual.

## Re-ejecución

- Modo `complementar`: idempotente — sobrescribe `INDEX.md`; dos invocaciones consecutivas con mismo corpus producen el mismo archivo.
- Modo `regenerar`: cada invocación toma siguiente NNN. No sobrescribe dossiers previos.

## Recursos adicionales

- **`references/template-manual.md`** — estructura uniforme por manual (modo `regenerar`).
- **`references/template-index.md`** — estructura del `INDEX.md` consolidado (modo `complementar`).
- **`references/lexico-tecnico.md`** — noise mínimo vetado (idéntico patrón que export-arq).
- **`references/validations.md`** — V1-V6 con reglas por modo.
- **`docs/conclusiones/007-export-commands-family.md`** — Propuesta original (familia `/agent-workflow:export-*`).
- **`agent-workflow/skills/export-arq/SKILL.md`** — hermano (arquitectura técnica).
- **`agent-workflow/skills/export-report/SKILL.md`** — hermano (informe ejecutivo).
