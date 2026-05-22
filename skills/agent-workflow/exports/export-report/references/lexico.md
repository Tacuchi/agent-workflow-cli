# Léxico ejecutivo — traducción técnico → ejecutivo

Tabla determinista que el skill `export-report` aplica durante el render (Paso 6) y validador V2 usa para detectar léxico vetado en el cuerpo del output.

> Excepción: la sección `## Referencias` está **fuera del scope** de V2 (los paths a `docs/<categoria>/` son ineludibles en esa sección).

## Tabla de traducción

| Técnico (corpus) | Ejecutivo (output) |
|---|---|
| commit · commits | "cambio aplicado" · "incorporación" · "publicación" |
| merge · merges | "integración" · "unión de trabajos" |
| pull request · PR · PRs | "revisión de cambios" · "propuesta de cambio" |
| sesión · session · sessions · sessionNNN · session<NNN> | "ciclo de trabajo" · "iteración" |
| flow=dev · flow=analyze · flow=design | "trabajo de implementación" · "análisis" · "diseño" |
| skill · skills · SKILL.md | "componente del sistema" · "automatización" |
| hook · hooks · PreToolUse · PostToolUse | "validación automática" · "control automático" |
| MCP · <mcp-cert> · <mcp-prod> · MCP server | "consulta de datos" · "fuente de datos del sistema" |
| CLI · agent-workflow CLI · línea de comandos | "línea de comandos del equipo" · "interfaz de comandos" |
| `agent-workflow:rules` | "reglas comunes" |
| post-mortem · postmortem | "análisis retrospectivo" |
| Phase 0 · Phase 1 · Phase 2 · scaffolding · stub | "preparación inicial" · "diseño previo" · "esqueleto base" |
| graduación · graduate · graduado | "publicación final" · "publicado" |
| hub mode · hub workspace · workspace hub | "área de trabajo común" · "espacio de coordinación" |
| Strangler Fig · opt-in · opt-out | (omitir; usar "migración progresiva" / "activación opcional") |
| harness · runtime · runtime qtc-* | "entorno de trabajo del equipo" · "sistema" |
| qtc-* · agent-workflow:rules · agent-workflow:session · agent-workflow:commits-policy · `/agent-workflow:*` | (omitir; usar "el sistema" · "las reglas comunes" · "el ciclo de trabajo") |
| Codex · Claude Code · Warp · Oz | "herramientas del equipo" (genérico) salvo que el contexto justifique nombrarlas |
| DEC-NNN | "decisión documentada N°NNN" · "una decisión" |
| TUI · CLI · TTY | "interfaz textual" · "interfaz de línea de comandos" |
| stack · stack técnico | "tecnologías utilizadas" (sin enumerar a menos que sea breve y relevante) |
| repositorio · repo · repos | "componente del sistema" · "área del sistema" |
| rama · branch · feature/* | "línea de trabajo" (raramente necesario en ejecutivo) |
| handoff | "pasaje de trabajo" · "entrega entre fases" |
| design system · DS · tokens | "sistema visual común" (raramente necesario) |
| backlog | "lista de pendientes" |
| feature flag | "interruptor de funcionalidad" |
| deployment · deploy · staging · prod | "puesta en producción" · "ambiente de prueba" · "producción" |
| log · logs · logging | "registro de actividad" |
| dashboard · panel | "panel de control" |
| api · endpoint · REST | "punto de integración" · "interfaz con otros sistemas" |
| backend · frontend | "componente del servidor" · "componente del usuario" |
| stack trace · stacktrace | "detalle técnico del error" |
| migration · migración SQL · DDL | "ajuste estructural de datos" |
| rollback | "reversa del cambio" |
| issue · ticket · JIRA-XXX | "punto pendiente" (sin números de ticket) |
| OKR · KPI | (omitir salvo que el cliente los use explícitamente) |

## Ejemplos antes / después

### Ejemplo 1 — Resumen ejecutivo

**Antes (técnico)**:
> El runtime qtc-* incorporó un nuevo hook PreToolUse que valida el branch antes de cada Edit/Write. Se migraron 36 sesiones legacy al formato canónico y se retiró el M9 contract-review en favor del DESIGN.md + S7 gate.

**Después (ejecutivo)**:
> El sistema incorporó controles automáticos que validan la línea de trabajo activa antes de cada cambio. Se completó la migración de ciclos de trabajo antiguos al formato común y se reemplazó la revisión técnica intermedia por una revisión de diseño previa.

### Ejemplo 2 — Logros

**Antes**:
> - Implementado /agent-workflow:export-scripts merge de release + release-scripts.
> - Hook sql-mutation-guard wired-up en hooks.json.
> - Phase 0-5 phased model adoptado en TASKS.md para `## Type: feature`.

**Después**:
> - Comando único de exportación de cambios técnicos disponible (consolida exportaciones previas).
> - Controles automáticos contra mutaciones no autorizadas en bases de datos.
> - Estructura por fases adoptada para las implementaciones nuevas (preparación → ejecución → validación).

### Ejemplo 3 — Recomendaciones

**Antes**:
> - R1: Instrumentar telemetría de adopción con OpenTelemetry traces (responsable: equipo runtime, Q3-2026).
> - R2: Deprecar /agent-workflow:release con alias durante 1 release cycle.

**Después**:
> - Próximo trimestre: instrumentar indicadores de adopción y uso real del sistema (responsable: equipo runtime).
> - Próximo trimestre: deprecar el comando antiguo de release manteniendo alias durante un ciclo, para permitir transición sin disrupciones.

## Lista vetada (V2 — para grep determinista)

Términos que **no deben aparecer** en el cuerpo del output (excepto en `## Referencias`). El validador V2 corre `grep -i -E -w` contra esta lista:

```
commit
commits
merge
push
pull
PR
PRs
sesión
sessions
sessionXXX
sessionNNN
flow=dev
flow=analyze
flow=design
skill
skills
SKILL.md
hook
hooks
PreToolUse
PostToolUse
MCP
<mcp-cert>
<mcp-prod>
CLI
agent-workflow
agent-workflow:rules
agent-workflow:session
agent-workflow:commits-policy
qtc-*
agent-workflow:
/agent-workflow:
postmortem
post-mortem
Phase 0
Phase 1
Phase 2
Phase 3
Phase 4
Phase 5
scaffolding
stub
graduación
graduate
hub mode
hub workspace
Strangler Fig
opt-in
opt-out
harness
runtime qtc-*
Codex
Claude Code
Warp
Oz
DEC-NNN
TUI
TTY
backlog
deploy
staging
endpoint
REST
stack trace
stacktrace
DDL
rollback
JIRA
JIRA-
OKR
KPI
```

> Nota: los términos "sesión" / "sesiones" sin sufijo numérico están vetados porque la versión exec es "ciclo de trabajo". Para mantener "sesión" en frases naturales (`N sesiones trabajadas` en el header), V2 excluye el patrón fijo `\bN sesiones trabajadas\b` del scope del grep (la única excepción autorizada).

## Reglas adicionales de léxico

Heredan de `agent-workflow:redaccion-simple` + preset ejecutivo. Resumen:

- **Frases cortas**: ≤15 palabras. Partir si supera 20.
- **Listas sobre prosa**: 3+ ideas paralelas → bullets.
- **Una idea por línea**: si el bullet usa "y" o ";" → separar.
- **"Qué + por qué" en una línea**: `<qué>: <por qué corto>`.
- **Sin jerga ni abreviaturas raras**: palabras comunes; términos técnicos validados OK; abreviaturas inventadas no.
- **Sin relleno**: cero "es importante notar que…", "cabe destacar…", "como se mencionó…".
- **Voz activa**: "el sistema incorporó X" mejor que "fue incorporado X por el sistema".
- **Verbos directos**: "validar" mejor que "realizar la validación de".
- **Números siempre con unidad o contexto**: "55 ciclos de trabajo en 10 días", no "55".
- **Glosa primera vez**: si un acrónimo SE permite (ej. SLA), glosarlo la primera vez: "acuerdo de nivel de servicio (SLA)".
