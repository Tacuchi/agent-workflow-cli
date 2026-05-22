---
name: design-deliver
description: Spec final estable para handoff al flow=dev. Componentes, estados, validaciones, tokens aplicados, decisiones UX racionalizadas. Sin código. Produce DELIVERY.md como entregable canónico (referenciado por handoff `--from design:NNN`). Invocado al final de execution cuando design-develop convergió en una variante elegida.
version: 2.2.0
---

# design-deliver — qtc v2.1+

Specialty skill **design**: producción del spec final. Cierre creativo de `execution` antes de pasar a `validation`.

## Cuándo se invoca

- Composición desde `agent-workflow:session` al final de `execution` cuando design-develop convergió.
- NL del usuario: "spec final", "armá el entregable", "vamos a deliverable", "cerrá el diseño".

## Acción

Producir `.workflow/sessions/<folder>/DELIVERY.md` (legacy: `ENTREGA.md`) con el spec completo + canónico para handoff al flow=dev.

### Estructura canónica de DELIVERY.md

```markdown
# Delivery — sessionNNN-design-<slug>

## Summary
[2-3 oraciones del qué y para quién. Esto es el TL;DR del handoff.]

## Components

### <Component 1>
- Type: form | list | modal | navigation | feedback | custom
- States: idle | loading | error | success | disabled | …
- Validations (if form): [lista]
- Tokens applied: spacing.md, color.danger, font.body
- UX rules: [shortcuts, accesibilidad, responsive]
- Mock: docs/referencias/<nombre>.png o link Figma

### <Component 2>
- ...

## Flows / interactions

1. [paso 1]
2. [paso 2]
3. ...

## UX decisions

- [decisión clave + por qué + qué se descartó]

## Tokens / design-system applied

- (sólo si type=project): listar tokens consumidos del DS.
- (si type=system): listar tokens NUEVOS o MODIFICADOS, con migration impact.

## Validation criteria

- [cómo qtc-dev sabrá que la implementación cumple el spec]

## Out of scope

- [qué NO se implementa en este spec, para evitar scope creep en la sesión dev]
```

## Reglas

- **Sin código**: DELIVERY.md es markdown puro + referencias a mocks/Figma. El código lo escribe el flow=dev.
- **Componentes referenciados a frontend-design**: si un componente es una variante estándar, citar `frontend-design references/<patron>.md`. Si es nuevo/custom, especificarlo entero.
- **Estados explícitos**: cada componente declara TODOS sus estados (no asumir que el dev los infiere).
- **Validaciones con regex/longitud/required cuando aplica**: el dev no inventa.
- **Out of scope explícito**: cierra puertas; evita feature creep.
- **Si type=system**: DELIVERY.md describe los CAMBIOS al design system (delta + migration), no una pantalla. La distinción `## Type: project|system` queda como metadato interno del documento; **no** afecta la carpeta de graduación (todo va a `docs/especificaciones/` — path canónico ES preservado por compat con sesiones legacy).
- **No commits autónomos**: design-deliver **nunca** commitea DELIVERY.md ni `docs/referencias/` por iniciativa. Ver `agent-workflow:commits-policy` (Regla 3): cuando el usuario solicita un commit — closure auto, ad-hoc en cualquier fase, o sin sesión activa — el AI invoca el flujo M1 propose-then-execute con `AskUserQuestion`.

## Loop hasta convergencia final

Después del primer draft de DELIVERY.md:

1. Mostrar al usuario.
2. Recibir feedback.
3. Iterar sobre el archivo (Edit, no recreación).
4. Repetir hasta el usuario confirme: "OK, podemos handoff".

## Hand-off al flow=dev (post-cierre de la sesión design)

Cuando la sesión cierre, DELIVERY.md se gradúa a `docs/especificaciones/NNN-<slug>/DELIVERY.md` (kind=`especificacion`, modelo nuevo DEC-003). Sin distinción project/system en la carpeta destino — la distinción queda como `## Type` interno del documento. La carpeta destino conserva el nombre español `docs/especificaciones/` por compatibilidad con paths existentes en sesiones legacy.

Destino según workspace_mode (DEC-002):
- **hub mode** → `<hub>/docs/especificaciones/NNN-<slug>/DELIVERY.md`.
- **project mode** → `<cwd>/docs/especificaciones/NNN-<slug>/DELIVERY.md`.

```
/agent-workflow:session --from design:<code> "<objetivo de implementación>"
```

El OBJECTIVE de la sesión dev quedará con `## Origin` linkeado al `DELIVERY.md` y tag `origen:design-NNN` en HISTORY.md (shared-contract §10).

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `design-develop` | si el feedback del usuario invalida la convergencia, retroceder |
| `frontend-design` | para validar que cada componente referenciado existe en patterns |

## Sandbox read-only

Reglas universales en el canon (`sandbox-readonly-rules.md`). En plan mode esta skill describe en el plan file:

- **Path destino** del DELIVERY.md: `.workflow/sessions/<folder>/DELIVERY.md`.
- **Esqueleto propuesto**: secciones (Summary, Components, States, Tokens applied, Variants, Validation criteria, Hand-off a dev), longitud aproximada por sección.
- **Referencias del usuario**: lista de archivos en `<workspace-root>/docs/referencias/` (mockups, especificaciones de tokens, exportes que el usuario provea), con formato y propósito. Carpeta transversal — DEC-004 v2. **El AI no escribe ahí salvo solicitud explícita**.
- **Type declarado** en OBJECTIVE: `project` o `system` (legacy ES `proyecto`/`sistema` se normaliza). Metadato interno del documento. En cualquier caso gradúa a `docs/especificaciones/` (kind=`especificacion`). Si falta, plan dice "preguntar al usuario".

NO ejecuta: `Write` sobre DELIVERY.md ni `docs/referencias/`; `agent-workflow graduate --kind especificacion`.

## Recursos

- skill `frontend-design` — patterns canónicos para referenciar.
- shared-contract §10 — handoff `--from design:<code>`.
- shared-contract §11 — convención `## Type` (afecta destino de graduación).
- shared-contract §14 — fase execution del lifecycle universal.
