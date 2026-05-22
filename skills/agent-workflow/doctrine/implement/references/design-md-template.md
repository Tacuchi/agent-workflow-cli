# DESIGN.md template (canon)

Template canónico copy-paste-friendly para producir el `DESIGN.md` de una sesión `flow=dev` con `## Type: feature|refactor`. Se ubica en `.workflow/sessions/<folder>/DESIGN.md` y se genera durante el cierre de planning, antes de S7.

## Convenciones

- **Filename**: `DESIGN.md` (EN canon, alineado con OBJECTIVE/TASKS/DECISIONS/EVIDENCE/FINDINGS/CONCLUSIONS).
- **Headers**: EN (`## Context`, `## Goals`, etc.).
- **Body**: idioma del usuario (típicamente ES). Memory `feedback_i18n_scope_runtime_only`.
- **Tamaño objetivo**: 1-3 páginas. Más grande → señal de que la sesión debería partirse.
- **Sección `## Open questions`**: obligatoria. Si no hay dudas abiertas, escribir literalmente `None` (DD-2 de DESIGN.md session050).
- **Composición**: invocar `agent-workflow:redaccion-simple` para frases cortas + listas + sin jerga.

## Template (copy-paste)

```markdown
# Design — session<NNN>-<slug>

## Context
<1 párrafo. Qué se diseña y por qué — anchor del problema.>

## Goals
- <2-4 bullets accionables de qué resuelve este diseño.>

## Non-goals
- <2-4 bullets de anti-scope explícito (qué NO toca).>

## Current state
<ASCII flow del estado actual. Citar paths concretos (com.qtc..., src/...).>

```
<diagrama ASCII de flow / componentes actuales>
```

## Target state
<ASCII flow del estado después. Mismas convenciones que current state.>

```
<diagrama ASCII de flow / componentes objetivo>
```

## New interfaces
<Firmas de las interfaces/clases/métodos nuevos con 1 línea de rol cada uno. Sin implementación.>

```<lenguaje>
// ej. Java
public interface PdfRenderer {
    byte[] renderFromHtml(String html);
    byte[] renderFromHtml(String html, String baseUrl);
}
```

## Wiring
<Cableado DI / data flow en ASCII. Cómo se conectan los nuevos tipos con los existentes.>

```
@Service Impl ─┬─ injected ─> Consumer1.field
              └─ injected ─> Consumer2.field
```

## Design decisions

### DD-1 — <título corto>
- **Decisión**: <qué se decidió>.
- **Por qué**: <motivación principal>.
- **Alternativas descartadas**: <1-2 alternativas con razón corta cada una>.

### DD-2 — <título corto>
- **Decisión**: …
- **Por qué**: …
- **Alternativas descartadas**: …

<Tantos DDs como decisiones no obvias haya. Si una decisión es trivial/obvia, no necesita DD.>

## Open questions
<Lista de cosas que el AI deja sin resolver explícitamente — el usuario decide antes de codear. Si no hay ninguna, escribir literalmente "None">

- <Pregunta 1: nombre de algo, dónde vive una excepción, overload conveniente, etc.>
- <Pregunta 2: ...>

(o)

None
```

## Reglas de redacción

- **Frases cortas**. Listas sobre prosa larga.
- **Citar paths concretos** en current/target state: `com.qtc.credito.core.service.PdfRenderer`, `src/cli/menu.tsx`, `mscore-delivery-spring/...`.
- **DD sin alternativa descartada** es sospechoso — el AI debe forzarse a buscar una. Si genuinamente no hay alternativa razonable, escribirlo explícito ("Alternativas descartadas: ninguna razonable; era la única opción que respeta <constraint>").
- **Open questions vacías** = `None`. Nunca omitir la sección.
- **No copiar código completo de impl** en `## New interfaces` — sólo firmas. La impl va en Phase 0 tasks.

## Skip rules

DESIGN.md no se produce cuando:
- `## Type: bugfix` — bugfix doctrina (3 pasos canónicos en `dev-workflow/SKILL.md`) no requiere design artifact.
- `## Type: chore` — chores son cambios triviales (bump deps, format, rename) sin design upfront.
- `auto-plan-decide` retornó `skip` (OBJECTIVE trivialmente atómico).

Para los demás casos (`## Type: feature|refactor`), DESIGN.md es obligatorio y S7 dispara always-on (DEC-003 de session049).

## Refs

- `skills/session/references/prompts/S7-design-review.md` — gate del DESIGN.md, dispara tras producción.
- `skills/session/SKILL.md` §"Cierre de planning" — pipeline planning → DESIGN.md → S7 → M10 → execution.
- `skills/implement/SKILL.md` §"Resolución del `## Type`" — defensa en profundidad para que el field nunca falte.
- `docs/conclusiones/005-mejoras-flujos-qtc-runtime.md` — CONCLUSIONS de session049, motivación + research.
