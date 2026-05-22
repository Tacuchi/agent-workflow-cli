---
name: redaccion-simple
description: "Guía transversal de redacción para artefactos qtc-*. Reglas para escribir OBJECTIVE/TASKS/DECISIONS/EVIDENCE/FINDINGS/CONCLUSIONS/CHECKPOINT/STATUS/PROBLEM/IDEAS/DELIVERY (legacy ES = OBJETIVO/DECISIONES/EVIDENCIA/HALLAZGOS/CONCLUSIONES/PROBLEMA/ENTREGA) con frases cortas, listas sobre prosa, sin jerga. Activable cross-plugin como `agent-workflow:redaccion-simple`. Aplica a toda prosa que el AI produzca en contexto qtc-*: artefactos `.md` de sesión, mensajes de commit, descripciones de PR, READMEs ad-hoc, respuestas en chat sobre temas qtc-*. No requiere sesión activa."
version: 2.0.1
---

# Redacción simple — Guía transversal qtc-*

Reglas de estilo y formato para los artefactos que producen los plugins qtc-* (core, dev, design, analyze).

## Cuándo se invoca

- Implícitamente al escribir cualquier `.md` dentro de una sesión qtc-* (artefactos canónicos).
- Implícitamente al producir prosa en contexto qtc-* fuera de sesión activa: commit messages, descripciones de PR, READMEs ad-hoc, respuestas en chat sobre runtime/skills/sesiones qtc-*.
- Explícitamente con `Skill(agent-workflow:redaccion-simple)` desde un flow plugin o desde la skill agregadora `agent-workflow:rules`.
- Referenciada desde `session`, `compact`, `resume` y los skills de los flow plugins.

## Las 6 reglas

1. **Frases cortas**: máximo ~15 palabras. Si pasa de 20, partir en dos.
2. **Listas sobre prosa**: 3+ ideas paralelas van en bullets. Prosa solo para narrar.
3. **Una idea por línea**: si el bullet usa "y" o ";" para meter una segunda idea, separar.
4. **"Qué + por qué" en una línea**: formato `<qué>: <por qué corto>`. Sin párrafo aparte para el "por qué".
5. **Sin jerga ni abreviaturas raras**: palabras comunes. Términos técnicos (MCP, C4) OK; abreviaturas inventadas (ej. "TLDR del CTX") no.
6. **Sin relleno**: borrar "es importante notar que…", "cabe destacar…", "como se mencionó…", "en conclusión…". La idea va directo.

## Palabras a evitar / preferir

| Evitar | Preferir |
|---|---|
| "es importante notar que" | (borrar y empezar con la idea) |
| "cabe destacar" | (borrar) |
| "en otras palabras" | (borrar) |
| "se procede a" | "vamos a" / verbo directo |
| "implementar la funcionalidad de X" | "implementar X" |
| "realizar la validación de" | "validar" |
| "llevar a cabo" | "hacer" |
| "a los efectos de" | "para" |
| "en el marco de" | "en" |
| "asimismo" | "también" |
| "no obstante" | "pero" |
| "previamente mencionado" | "antes" / "ya dicho" |
| "TLDR", "FYI", "WIP" | escribir la palabra completa |

## Ejemplos antes / después

**1. Prosa redundante**

Antes:
> Es importante notar que los MCPs `<mcp-cert>` y `<mcp-prod>` constituyen hoy la única vía de acceso a la información de schema desde las sesiones de Claude Code. En el marco de la operatoria habitual, cada llamada implica un round-trip al servidor MCP además del consumo de tokens correspondiente al JSON de respuesta.

Después (-50%):
> Hoy las sesiones acceden al schema solo vía MCP `<mcp-cert>` y `<mcp-prod>`. Cada llamada cuesta un round-trip y los tokens del JSON.

**2. Decisión densa**

Antes:
> Se decidió, luego de analizar las distintas alternativas, implementar la validación de roles a nivel del frontend exclusivamente, dado que el backend de mantenimiento no requiere conocer la lógica de permisos para operar correctamente, y además esto evita duplicar la regla de negocio en dos lugares distintos.

Después:
> **Decisión**: validar permisos solo en el frontend.
> **Por qué**: el backend de mantenimiento no necesita la lógica; evita duplicar la regla.

**3. Tarea con código inline**

Antes:
> - [ ] **T3**: Implementar el método `validarRol`.
>   ```java
>   public boolean validarRol(Usuario u, Rol r) {
>     if (u == null) throw new IllegalArgumentException("...");
>     ...
>   }
>   ```

Después:
> - [ ] **T3**: Implementar `validarRol(Usuario, Rol)` en `RolService`. Hecho cuando devuelve `true` para la matriz de `EVIDENCE.md § matriz-roles`.

## Cuándo SÍ se permite prosa larga

- `## Summary` de CONCLUSIONS.md (modality=technical): si la decisión necesita 4-6 oraciones para sostenerse.
- Conclusión de causa raíz dentro de CONCLUSIONS.md (modality=incident): la cadena causal puede requerir un párrafo.
- `## UX decisions` de DELIVERY: cuando explicar un tradeoff visual.

En esos casos sigue aplicando "frases cortas": prosa de oraciones simples encadenadas, no oraciones largas.

## Estructuras mínimas por artefacto

Cada artefacto tiene una estructura fija. Cambia el contenido, no los headings que los parsers leen.

| Artefacto | Headings | Tamaño objetivo |
|---|---|---|
| OBJECTIVE.md (legacy: OBJETIVO.md) | `## <Modality\|Type\|Requirement>`, `## <Question\|Brief\|Requirement>`, `## Context`, `## Acceptance criteria`, `## Origin` (opcional), `## Topics` (opcional dev) | 30-60 líneas |
| TASKS.md | `## Plan summary`, `## Tasks`, `## Risks / external dependencies` | 40-100 (full); 20-40 (lite) |
| DECISIONS.md (legacy: DECISIONES.md) | `## DEC-NNN: <título>` con `**Decisión**:` + `**Por qué**:` + opcionales | 3-6 líneas por decisión |
| STATUS.md | campos planos + `## Branches por fuente`, `## Next step` o `## Cierre` | 15-25 líneas |
| CHECKPOINT.md | `## Last action`, `## Next step`, `## Recent decisions`, `## Files touched`, `## Critical context to resume`, `## Refs` | 20-50 líneas |
| EVIDENCE.md (legacy: EVIDENCIA.md) | `## Original question`, `## Sources consulted`, `## Raw finding N: <título>`, `## Notes / tentative hypotheses` | 40-150 líneas |
| FINDINGS.md (legacy: HALLAZGOS.md) | `## Patterns identified`, `## Model decision`, `## What is NOT known (gaps)`, `## False positives discarded` (opcional) | 30-100 líneas |
| CONCLUSIONS.md (cualquier modality, legacy: CONCLUSIONES.md) | `## Modality`, `## Summary`, `## Conclusions`, `## Recommendations`, `## Traceability`, `## Open` (opcional) | 60-200 líneas según modality y profundidad |
| PROBLEM.md (legacy: PROBLEMA.md) | `## Statement`, `## Key constraints`, `## Success metrics` | 20-50 líneas |
| IDEAS.md | `## Variant A/B/C` con Idea/Pros/Contras, `## Initial recommendation` | 60-120 líneas |
| DELIVERY.md (legacy: ENTREGA.md) | `## Summary`, `## Components` (con `### <Component>`), `## Flows / interactions`, `## UX decisions`, `## Out of scope` | 150-300 líneas |

Tamaño objetivo es **suave**: pasarlo está OK si se justifica.

## Reglas operativas por artefacto

- **OBJECTIVE**: `## Context` arranca con "Lo que NO está en la pregunta:". Sin sección `## Restricciones` separada.
- **TASKS**: prohibido código inline. Si hace falta código, va en EVIDENCE y se referencia.
- **DECISIONS**: si una DEC-NNN es obvia, no se registra. Sin SQL/código inline.
- **STATUS**: sin `## Artefactos` enumerando archivos (`ls` ya lo hace). Sin `## Handoff sugerido` separado.
- **CHECKPOINT**: si una sección no aplica, se borra entera. Sin placeholders vacíos.
- **EVIDENCE**: cada hallazgo 4-8 líneas. Tablas solo si comparan más de 3 cosas.
- **CONCLUSIONS**: sin `## Context` que repita el OBJECTIVE. Sin opciones falsas tipo "no hacer nada". Sin pseudocódigo. Cada `**CN**` con evidencia link; cada `**RN**` con responsable + cuándo.

## Sandbox read-only

Canon universal en `../session/references/sandbox-readonly-rules.md`. Esta skill es read-only por diseño — carga reglas de redacción, no escribe artefactos por sí misma. Los skills consumidores (`session`, `compact`, `resume`, etc.) son quienes producen el `.md`.

En plan mode: describir en el plan file qué artefacto se redactaría (OBJECTIVE / TASKS / DECISIONS / EVIDENCE / FINDINGS / CONCLUSIONS / CHECKPOINT / STATUS / commit-msg / PR-description), qué reglas operativas aplican, y el tamaño objetivo en líneas. NO ejecuta `Write`, `Edit`, `MultiEdit` por sí misma — describe el contenido para que el consumidor lo materialice.

Compatible con plan mode sin restricciones adicionales.

## Referencias

- Propuesta origen: `agent-workflow/docs/propuestas/001-simplificar-artefactos.md` (graduado de session005-analyze; el repo legacy era `core-workflow-plugin`).
- Templates afectados: `agent-workflow-cli/src/application/templates/objective.ts` (canon EN; ES legacy `OBJETIVO.md` sigue siendo legible vía bilingual readers R1).
- Skills consumidores: `session`, `compact`, `resume`, y los workflows `dev-workflow`/`design-workflow`/`analyze-workflow` (todos en `agent-workflow`).
