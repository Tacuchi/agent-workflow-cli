# Plantilla canónica — INDEX.md (modo `complementar`)

Plantilla para el archivo único `docs/manuales/INDEX.md` que el skill sobrescribe en modo `complementar`. Es re-generable, sin numeración NNN — siempre vive en el mismo path.

---

```markdown
# Manuales técnicos — {{PRODUCTO}}

Índice consolidado actualizado al {{FECHA_GENERACION}}.
Total: {{N_MANUALES_GRADUADOS}} manuales graduados · {{N_TEMAS_NO_GRADUADOS}} temas sin graduar detectables.

## Manuales graduados

<!-- Tabla de manuales graduados (`kind=manual`) presentes en docs/manuales/NNN-*.md.
     Una fila por manual. Columna "Sesiones de origen" si el manual está vinculado
     a sesiones específicas (extraído de YAML frontmatter o primer párrafo). -->

| Slug | Manual | Sesiones de origen |
|---|---|---|
{{TABLA_MANUALES_GRADUADOS}}

## Temas sin graduar detectables

<!-- Tabla de temas con potencial de ser manuales pero aún no graduados.
     Detección por `## Topics`/`## Temas` en OBJECTIVE.md del corpus + heurística por
     keywords operativos. Confidence: alta (declarado) / media (inferido). -->

| Tema | Slug | Sesiones de origen | Confidence |
|---|---|---|---|
{{TABLA_TEMAS_NO_GRADUADOS}}

## Próximos pasos sugeridos

<!-- Sólo aparece si hay ≥1 tema no graduado. Lista de bullets con sugerencias para
     materializar los temas en manuales formales graduados. -->

{{PROXIMOS_PASOS_OR_OMIT}}

## Cómo refrescar este índice

Este archivo se re-genera ejecutando:

```
/agent-workflow:export-tech-manuals
```

(modo `complementar` es el default). El comando sobrescribe `INDEX.md` con el estado actual del workspace; no requiere borrar manualmente. Cada invocación es idempotente sobre el mismo corpus.

Para producir un dossier consolidado de manuales (paquete onboarding, por ej):

```
/agent-workflow:export-tech-manuals --mode regenerar
```

Esto crea un dossier dentro de `docs/manuales/` con número secuencial y fecha en el nombre, conteniendo un manual por tema detectado.
```

---

## Placeholders detallados

### `{{PRODUCTO}}`

Nombre del workspace/producto. Mismo patrón que en `template-c4.md` de export-arq.

### `{{FECHA_GENERACION}}`

Formato natural ES: `18 de mayo de 2026`.

### `{{N_MANUALES_GRADUADOS}}`

Count de archivos `docs/manuales/NNN-*.md` (excluyendo `INDEX.md` y dossiers `NNN-export-tech-manuals-*/`).

### `{{N_TEMAS_NO_GRADUADOS}}`

Count de temas detectables del corpus que no tienen un manual graduado correspondiente.

### `{{TABLA_MANUALES_GRADUADOS}}`

Filas con:
- Slug (extraído del filename `NNN-<slug>.md`).
- Manual (link al path, ej. `[Configurar MCP](007-configurar-mcp.md)`).
- Sesiones de origen (lista coma-separada, si extraíble del manual).

Si 0 manuales graduados:
```
| _Sin manuales graduados en este workspace todavía._ | — | — |
```

Una sola fila informativa, no múltiples.

### `{{TABLA_TEMAS_NO_GRADUADOS}}`

Filas con:
- Tema (descripción humana corta).
- Slug (kebab-case).
- Sesiones de origen.
- Confidence: `alta` (declarado en `## Topics`/`## Temas`) o `media` (inferido por keywords).

Si 0 temas detectables: omitir la sección entera (no aparece encabezado vacío).

### `{{PROXIMOS_PASOS_OR_OMIT}}`

**A. Si N_TEMAS_NO_GRADUADOS > 0** → bullets:

```
- Crear sesión dev `flow=dev` para materializar el tema "{{tema_1}}" como manual graduado.
- Crear sesión dev para "{{tema_2}}".
- (...)
- Para cada manual nuevo: `agent-workflow graduate --kind manual --session <CODE> --slug <kebab>`.
- Tras graduar: re-correr `/agent-workflow:export-tech-manuals` para actualizar este índice.
```

**B. Si N_TEMAS_NO_GRADUADOS == 0** → cadena vacía. La sección no aparece.

## Reglas de render

1. **Idempotente conceptual**: misma invocación sobre mismo corpus produce mismo `INDEX.md`.
2. **Sin numeración NNN para INDEX**: el INDEX vive en `docs/manuales/INDEX.md` siempre, sobrescribible.
3. **Cero placeholders sin reemplazar**: V2 grep determinístico atrapa fallas del render.
4. **Tablas vacías → fila informativa, no eliminadas**: comunica al lector que la sección fue evaluada.
5. **Sección "Próximos pasos" condicional**: V4 honored; ausencia significa "no hay nada que sugerir".
