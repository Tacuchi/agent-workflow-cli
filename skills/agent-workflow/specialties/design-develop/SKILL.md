---
name: design-develop
description: Convergencia en problem statement + divergencia en soluciones (variantes/mocks). Iteración con el usuario hasta tener una propuesta validada. Produce PROBLEM.md, IDEAS.md y opcionalmente mocks/wireframes en `docs/referencias/` (carpeta transversal manual del usuario, DEC-004 v2). Invocado en execution después de design-discover (o directo si el OBJECTIVE no requiere discovery).
version: 2.2.0
---

# design-develop — qtc v2.1+

Specialty skill **design**: convergencia en problema + divergencia/iteración de soluciones. Núcleo creativo del flujo design.

## Cuándo se invoca

- Composición desde `agent-workflow:session` en `execution` cuando hay OBJECTIVE + (DISCOVERY.md o sesión saltó discovery por trivialidad).
- NL del usuario: "vamos a diseñar opciones", "propone variantes", "cómo lo resolvemos", "boceto rápido".
- Recomendado por `design-discover` como siguiente paso.

## Acción

Producir 2-3 artefactos en paralelo:

### 1. PROBLEM.md — convergencia

Statement de problema en 1-3 oraciones. Foco en QUÉ se resuelve, no en CÓMO. (legacy: `PROBLEMA.md`)

```markdown
# Problem — sessionNNN-design-<slug>

## Statement
[1-3 oraciones: usuario X necesita Y porque Z].

## Key constraints
- [restricciones técnicas, de UX, de tiempo, de tokens del design system]

## Success metrics
- [cómo sabemos que la solución funciona]
```

### 2. IDEAS.md — divergencia

Lista de variantes con tradeoffs. **No** elegir todavía:

```markdown
# Ideas — sessionNNN-design-<slug>

## Variant A: <name>
- Descripción 1-2 oraciones.
- Pros: ...
- Cons: ...
- Mockup: docs/referencias/A-mockup.png  (si el usuario lo aporta) o link Figma/Stitch

## Variant B: <name>
- ...

## Variant C: ...
- (3 variantes es típico; más sólo si justifica)

## Initial recommendation
- [variante preferida y por qué; queda abierto a feedback del usuario]
```

### 3. `docs/referencias/` — mocks aportados por el usuario (DEC-004 v2)

- Wireframes/mocks bajos en fidelidad para iteración rápida.
- Storage:
  - Local: `<workspace-root>/docs/referencias/A-*.png|svg|md` (el **usuario** los coloca; el AI los lee). Carpeta transversal — cualquier sesión accede a las mismas referencias sin re-subirlas.
  - Externo (Figma/Stitch): URL en IDEAS.md, nada en `docs/referencias/`.
- **El AI no escribe en `docs/referencias/` salvo solicitud explícita** del usuario ("guardá este wireframe en referencias"). Si necesita generar un esqueleto ASCII, lo embebe directamente en IDEAS.md.
- Para `type=system`, las referencias pueden ser ejemplos de uso de tokens/componentes (no mockups de pantallas).

## Loop de iteración

```
[propuestas] → [feedback usuario] → [refinar] → [propuestas v2] → [...]
                                       ↓
                                  [convergencia]
                                       ↓
                              [→ design-deliver]
```

Cada iteración:
- Editar PROBLEM.md/IDEAS.md (no recrear).
- Si el usuario aporta nuevos mockups en `docs/referencias/`, leerlos y reflejarlos en IDEAS.md. El AI no toca `docs/referencias/` salvo pedido explícito.
- Confirmar con el usuario antes de la próxima iteración.

## Reglas

- **3 variantes es óptimo**: si el espacio de soluciones es claro, 1-2 alcanza. Si el problema es muy abierto, hasta 4. Más es ruido.
- **No saltar a deliver sin convergencia explícita**: el usuario debe confirmar "OK, vamos con la variante X" antes de pasar a `design-deliver`.
- **Mocks de baja fidelidad primero**: alta fidelidad en `design-deliver`. Acá importa el flujo, no el pixel.
- **Spec-only**: NO escribir código de UI. Mocks como imágenes/wireframes/Figma URLs.
- **Frontend-design es referencia, no obligación**: para `type=system`, las decisiones de tokens/componentes ALIMENTAN `frontend-design` (no al revés).

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `design-deliver` | siguiente paso una vez hay convergencia |
| `frontend-design` | consultar patterns existentes para validar consistencia |
| `design-discover` | si surge nueva pregunta que requiere investigación, retroceder |

## Sandbox read-only

Reglas universales en el canon (`sandbox-readonly-rules.md`). En plan mode esta skill describe en el plan file:

- **Paths destino**: `.workflow/sessions/<folder>/PROBLEM.md`, `IDEAS.md`, opcional lectura de `<workspace-root>/docs/referencias/` (carpeta transversal manual del usuario, DEC-004 v2) con mocks/wireframes que el usuario aporte.
- **Problem statement** propuesto: 1-2 oraciones que capturan QUÉ resolver y POR QUÉ.
- **Variantes a explorar**: 2-4 enfoques distintos (estructura, layout, interacción) con pros/cons textuales — sin diseñar mocks aún.
- **Iteración prevista**: cuántas rondas con el usuario, qué validar en cada una.

NO ejecuta: `Write` sobre PROBLEM.md/IDEAS.md, generación de mocks en `docs/referencias/` (manual del usuario), ediciones a `docs/especificaciones/`.

## Recursos

- skill `frontend-design` — patterns reutilizables (form/list/modal/navigation/feedback).
- shared-contract §14 — fase execution del lifecycle universal.
