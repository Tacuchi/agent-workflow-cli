# Plantilla canónica — Manual técnico (modo `regenerar`)

Plantilla para un manual técnico individual. Cada archivo del dossier `docs/manuales/NNN-export-tech-manuals-YYYY-MM-DD/` sigue esta estructura.

**Audiencia**: operadores / soporte / nuevos miembros del equipo que necesitan ejecutar la tarea descrita sin invocar al equipo de desarrollo.

---

```markdown
# {{TITULO_MANUAL}}

> Manual técnico generado desde {{SESIONES_ORIGEN}} el {{FECHA_GENERACION}}.
> Audiencia: operadores / soporte / onboarding.

## Propósito

<!-- 1-2 oraciones. Qué problema operativo resuelve este manual. -->

{{PROPOSITO}}

## Pre-requisitos

<!-- Bullets cortos. Conocimientos previos, accesos requeridos, herramientas instaladas. -->

{{PREREQUISITOS}}

## Pasos

<!-- Numeración secuencial. Cada paso ≤2 frases. Si un paso requiere validar algo,
     incluir la verificación inline ("ejecutar X; confirmar que retorna Y"). -->

1. {{PASO_1}}
2. {{PASO_2}}
3. {{PASO_3}}
{{PASOS_RESTO}}

## Validación post-uso

<!-- Cómo el operador confirma que el procedimiento se completó correctamente.
     Bullets con resultados esperados verificables. -->

{{VALIDACION}}

## Troubleshooting

<!-- Errores típicos + cómo resolverlos. Tabla o bullets. Si no se identifican
     errores típicos, escribir "Sin errores típicos identificados al momento de
     generar este manual." -->

{{TROUBLESHOOTING}}

## Referencias

<!-- Links a sesiones de origen, decisiones relacionadas, documentación adicional. -->

{{REFERENCIAS}}
```

---

## Placeholders detallados

### `{{TITULO_MANUAL}}`

Título descriptivo en oración (no en infinitivo de comando). Ejemplos:
- "Configurar un servidor MCP de consulta a base de datos"
- "Crear y cerrar una sesión agent-workflow desde cero"
- "Migrar sesiones legacy al formato común"

### `{{SESIONES_ORIGEN}}`

Lista coma-separada de las sesiones del corpus que aportaron contenido al manual.

Ejemplo: `session031-analyze-revisar-mcp-bd, session032-dev-configurar-mcp-manual, session033-dev-fix-mcp-claude-target`

### `{{FECHA_GENERACION}}`

Fecha en formato natural ES: `18 de mayo de 2026`.

### `{{PROPOSITO}}` (1-2 oraciones)

Qué problema operativo resuelve. Sin marketing. Verbos directos.

### `{{PREREQUISITOS}}` (bullets cortos)

- Conocimientos previos asumidos (ej. "Familiaridad con línea de comandos").
- Accesos requeridos (ej. "Cuenta en npm registry para publicar el CLI").
- Herramientas instaladas (ej. "Node.js ≥ 18, git ≥ 2.20").
- Configuración previa necesaria.

### `{{PASOS}}` (numerados)

Secuencia operativa concreta. Cada paso ejecutable y verificable. Evitar pasos compuestos ("hacer A y B"); separarlos.

Formato sugerido:
```
1. **Ejecutar comando X**: `agent-workflow session-create --flow dev --name foo`. Verificar que retorna `ok: true`.
2. **Abrir archivo Y**: `.workflow/sessions/sessionNNN-dev-foo/OBJECTIVE.md` aparece con headers EN canon.
```

### `{{VALIDACION}}` (bullets)

Resultados verificables que confirman éxito.

```
- El comando devolvió código de salida 0.
- El archivo X existe en el path Y.
- La consulta Z retorna N filas (donde N matchea el conteo previo).
```

### `{{TROUBLESHOOTING}}` (tabla o bullets)

Tabla preferida cuando hay 3+ errores típicos:

```
| Error | Causa probable | Resolución |
|---|---|---|
| "ENOENT: no such file" | Sesión no creada | Ejecutar paso 1 primero |
| "branch mismatch" | Rama incorrecta | `git checkout feature/last` |
```

Si no se identifican: `_Sin errores típicos identificados al momento de generar este manual._`

### `{{REFERENCIAS}}`

Bullets con paths/links:

```
- Sesión origen: `.workflow/sessions/session031-analyze-revisar-mcp-bd/CONCLUSIONS.md`
- Decisiones: `.workflow/sessions/session032-dev-configurar-mcp-manual/DECISIONS.md`
- Propuesta relevante: `docs/conclusiones/004-audit-test.md`
- Comando del CLI: `agent-workflow mcp configure`
```

## Reglas de render

1. **Audiencia operativa**: cada paso debe ser ejecutable por alguien que NO participó en el desarrollo. Sin "obvio", "trivial", "como se sabe".
2. **Léxico técnico OK**: términos del dominio (`agent-workflow`, `session`, `MCP`, `hook`) están autorizados. Los acrónimos no obvios sí glosarse la primera vez.
3. **Verbos directos**: "Ejecutar X", "Verificar Y", "Crear Z". No infinitivos perifrásticos ("Se debe ejecutar X").
4. **Sin pasos compuestos**: una acción por paso. Si la tarea es "A y B", separar en pasos.
5. **Validación inline cuando posible**: cada paso que produce un side-effect debe declarar cómo verificarlo, además de la sección §Validación.
6. **Sin diagramas obligatorios**: si un flow es complejo, opt-in a un Mermaid `flowchart` simple. Default: cero diagramas.
7. **Sin cota dura de palabras**: la longitud la dicta el tema. Manuales de 200w (configuración simple) y de 1500w (procedimiento multi-paso) son ambos válidos.
