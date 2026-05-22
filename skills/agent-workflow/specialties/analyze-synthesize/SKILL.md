---
name: analyze-synthesize
description: Estructura información en un plan accionable. Skill CLAVE invocada por agent-workflow:session durante la fase planning para descomponer el OBJECTIVE en TASKS.md (cuando auto-plan dice `lite` o `full`). También se invoca durante execution para sintetizar FINDINGS.md a partir de evidencia recolectada por analyze-investigate. Output siempre estructurado con criterios + dependencias + ordenamiento.
version: 1.1.0
---

# analyze-synthesize — qtc v1.1+

Specialty skill **analyze**: estructura información de manera accionable. Doble rol:

1. **En `planning`** (uso primario): descompone OBJECTIVE en TASKS.md cuando `agent-workflow auto-plan-decide` retorna `lite` o `full`. La invoca `agent-workflow:session` directamente.
2. **En `execution`** (analyze-only): sintetiza FINDINGS.md a partir de EVIDENCE.md después de `analyze-investigate`.

Es la **skill más importante** del flow=analyze porque participa en planning de TODOS los flows (no solo analyze).

## Cuándo se invoca

- **Composición desde `agent-workflow:session` en planning** cuando `auto-plan-decide` retorna `lite` o `full`.
- **Composición en sesión analyze en execution** después de `analyze-investigate` cuando hay evidencia que organizar.
- NL del usuario: "estructurá el plan", "organizá los hallazgos", "armá las tareas".
- Devuelta por `specialty-choose --phase planning`.

## Acción: estructurar plan (uso primario, planning)

Output: `.workflow/sessions/<folder>/TASKS.md` con descomposición ordenada.

### Estructura canónica de TASKS.md

```markdown
# Tasks — sessionNNN-<flow>-<slug>

## Plan summary

[1-2 oraciones: qué se va a hacer, en qué orden, criterio de hecho.]

## Tasks

- [ ] **T1**: <título imperativo> — <criterio: cómo sé que está hecha>
  - Depende de: ninguna
  - Estima: <S|M|L>
- [ ] **T2**: <título> — <criterio>
  - Depende de: T1
  - Estima: <S|M|L>
- [ ] **T3**: ... — <criterio>
  - Depende de: T1
  - Estima: <S|M|L>

## Risks / external dependencies

- <riesgo 1: qué podría romper la ejecución, mitigación>
```

### Reglas de estructuración

- **3-7 tareas para `full`**, 1-3 para `lite`. Si exceden 7, agrupar.
- **Cada tarea con criterio de hecho explícito** (no solo título).
- **Dependencias declaradas** — el AI puede paralelizar tareas independientes.
- **Estima S|M|L** orientativa: S = <30min, M = 30min-2h, L = 2-8h. Si una L se acerca a 8h, considerá descomponer.
- **No prescribir solución técnica acá** — la decisión de "cómo" se toma durante execution con la specialty correspondiente (implement, design-deliver, etc.).

## Acción: sintetizar hallazgos (analyze execution)

Output: `.workflow/sessions/<folder>/FINDINGS.md` (legacy: `HALLAZGOS.md`).

```markdown
# Findings — sessionNNN-analyze-<slug>

## Patterns identified

- **Patrón A**: <qué+por qué+evidencia (link a EVIDENCE.md sección)>

## False positives discarded

- **<hipótesis descartada>**: por qué no aplica, evidencia.

## Model decision

[Cuál modelo / hipótesis explica mejor los datos. 1-2 párrafos.]

## What is NOT known (gaps)

- <pregunta abierta que requeriría más investigación>
```

### Reglas de síntesis

- **Toda afirmación con evidencia**: link al `EVIDENCE.md#section` o al artefacto (query, screenshot, log).
- **Honest gaps**: lo que no se pudo probar o quedó incierto, declararlo. No inventar.
- **Convergencia**: el output debe ser una historia coherente, no un dump.
- **Próximo paso**: FINDINGS termina apuntando a `analyze-conclude` (produce CONCLUSIONS.md modulado por `## Modality`).

## Reglas

- **Sin imaginación creativa**: este skill es estructurador, no inventor. Trabaja con lo que el OBJECTIVE o EVIDENCE ya dice.
- **Single source of truth**: el TASKS.md es la fuente de qué se va a hacer; el FINDINGS.md es la fuente de qué se sabe. Otros artefactos (DECISIONS, CONCLUSIONS) referencian, no duplican.
- **Idempotente**: re-invocar sobre TASKS.md existente refina, no recrea.
- **No commits autónomos**: ver `agent-workflow:commits-policy`. Synthesize escribe TASKS/FINDINGS pero nunca commitea.

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `analyze-investigate` | en analyze sessions, EVIDENCE antes de sintetizar |
| `analyze-conclude` | siguiente paso en analyze sessions; produce CONCLUSIONS.md modulado por `## Modality` (technical/incident/data) |
| `agent-workflow:session` | invoca este skill en planning de cualquier flow |

## Sandbox read-only

Reglas universales en el canon (`sandbox-readonly-rules.md`). En plan mode esta skill describe en el plan file el output según el rol:

- **Rol planning** (invocado por `agent-workflow:session` durante phase planning):
  - **Path destino**: `.workflow/sessions/<folder>/TASKS.md`.
  - **Items propuestos** (≥3 si auto-plan = `full`, 1-3 si `lite`): cada uno con título, criterio de aceptación, dependencias (orden), estimación de esfuerzo.
  - Sugerencias de skills a invocar para cada item (sin invocarlas).

- **Rol execution** (sesiones analyze, sintetizar evidencia):
  - **Path destino**: `.workflow/sessions/<folder>/FINDINGS.md`.
  - **Estructura**: hallazgo principal, sub-hallazgos numerados, conexiones entre ellos, gaps (qué falta investigar).
  - Origen de cada hallazgo: link al item de EVIDENCE.md (sin re-pegar el contenido).

NO ejecuta: `Write` sobre TASKS.md ni FINDINGS.md.

## Recursos

- shared-contract §14 — fase planning del lifecycle universal.
- shared-contract §15 — naming convention specialty skills.
- shared-contract §19 — auto-plan trigger heurística (cuándo invocar este skill).
