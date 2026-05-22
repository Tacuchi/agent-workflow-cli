---
name: design-discover
description: Fase de investigación divergente del diseño dentro del lifecycle universal. Investiga usuarios, flows existentes, código relacionado, design system actual y referencias externas. Produce DISCOVERY.md como artefacto lazy. Invocado desde execution cuando ya hay OBJECTIVE con Type capturado por design-brief y el usuario está listo para divergir antes de converger en problema/soluciones.
version: 1.2.0
---

# design-discover — qtc v1.1+

Specialty skill **design**: investigación divergente. Primer paso de `execution` para sesiones design.

## Cuándo se invoca

- Composición desde `agent-workflow:session` en `execution` cuando hay OBJECTIVE con `## Type` (legacy: `## Tipo`) y todavía no existe `DISCOVERY.md`.
- NL del usuario: "investigá el contexto", "qué hay del usuario X", "miremos cómo está hecho hoy".
- Recomendado por `design-brief` como siguiente paso natural.

## Acción

Producir o iterar `.workflow/sessions/<folder>/DISCOVERY.md` con investigación divergente sobre 4 ejes:

### 1. Usuarios

- Quién va a usar esto, en qué contexto, con qué frecuencia.
- Si hay personas/role-models existentes, referenciarlas.
- Si hay usuarios reales accesibles, considerar entrevistas (lo decide el usuario).

### 2. Flows / proceso actual

- Cómo se hace HOY (si existe). Pasos, frustraciones, walking skeleton.
- Capturas de pantalla / refs al código existente si aplica.
- Para `type=project` → mirar pantallas existentes del módulo.
- Para `type=system` → mirar componentes/tokens existentes en `docs/especificaciones/` (kind=`especificacion`, modelo nuevo) o el design system instalado.

### 3. Design system existente

- Qué tokens / componentes ya tenemos que aplican.
- Patterns establecidos (`skill frontend-design references/*-patterns.md`).
- Decisiones previas en `docs/especificaciones/NNN-*/DELIVERY.md` (kind=`especificacion`; legacy: `ENTREGA.md`).

### 4. Referencias externas

- Productos parecidos (con screenshots/links si el usuario los provee).
- Buenas prácticas del dominio.
- Restricciones de accesibilidad / responsive / multi-idioma.

## Estructura típica de DISCOVERY.md

```markdown
# Discovery — sessionNNN-design-<slug>

## Users

- ...

## Current flow

- ...

## Applicable design system

- Tokens: ...
- Components: ...
- Patterns: ...

## External references

- ...

## Key findings

- [1-3 hallazgos accionables que el siguiente paso (define+develop) usa]
```

## Reglas

- **Divergir ahora, converger después**: no proponer soluciones todavía — eso es `design-develop`.
- **Citar fuentes**: cada afirmación con un link/path a evidencia (código, screenshots, docs).
- **DISCOVERY.md es lazy**: si el OBJECTIVE es trivial (ej. cambio menor a un componente existente), saltar a `design-develop` directo.
- **No escribir código**: spec-only siempre.

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `design-develop` | siguiente paso una vez DISCOVERY tiene hallazgos accionables |
| `frontend-design` | consultar patterns existentes para el inventario "design system aplicable" |
| `analyze-investigate` | si la investigación requiere análisis técnico profundo (latencia, datos), invocar acá |

## Sandbox read-only

Reglas universales en el canon (`sandbox-readonly-rules.md`). En plan mode esta skill describe en el plan file:

- **Path destino**: `.workflow/sessions/<folder>/DISCOVERY.md`.
- **Fuentes a consultar**: pantallas existentes (paths o screenshots), flows del repo, design system actual (`docs/especificaciones/` con kind=`especificacion` y `## Type: system` interno), referencias externas (links). Material aportado por el usuario en `<workspace-root>/docs/referencias/` también se considera (carpeta transversal — DEC-004 v2).
- **Preguntas de investigación**: lista priorizada (qué hacen los usuarios hoy, qué duele, qué falta).
- **Esqueleto del DISCOVERY.md**: secciones (Contexto, Stakeholders, Estado actual, Pain points, Referencias, Preguntas abiertas).

NO ejecuta: `Read` sobre código fuente (sí permitido — read-only), `Write` sobre DISCOVERY.md.

## Recursos

- skill `frontend-design` — patterns reutilizables.
- shared-contract §14 — fase execution del lifecycle universal.
