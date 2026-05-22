# Plantilla Variante C — Informe ejecutivo extenso (3-pager · 1620w)

Plantilla para audiencia comité de seguimiento (audit-grade). Cota dura **1620 palabras (±10%; hard fail ±20%)** (v1.1: subió de 1500w a 1620w para acomodar Componentes impactados). 10 secciones obligatorias en orden fijo (8 hasta v1.0) + "Oportunidades de mejora" condicional. Variante de B con "Contexto del período" agregado y "Logros del período" sub-seccionado por capacidad. **Sin sección Métricas** (decisión usuario session056).

---

```markdown
{{PRODUCTO}} — Informe ejecutivo extenso
Período: Del {{FECHA_INICIO}} al {{FECHA_FIN}}. {{N_SESIONES}} sesiones trabajadas.
Audiencia: Comité de seguimiento

# Resumen ejecutivo

<!-- 120 palabras (±15%). Prosa estructurada.
     Estructura sugerida: estado del sistema + qué se hizo en el período + por qué importa + qué viene.
     1-2 párrafos. Sin acrónimos sin glosar. -->

{{RESUMEN}}

# Contexto del período

<!-- 100 palabras (±15%). Prosa narrativa.
     Estructura: estado previo al período + motivación de los cambios realizados + condiciones del entorno.
     Establece el "por qué ahora" antes de entrar al objetivo y los logros. -->

{{CONTEXTO}}

# Objetivo

<!-- 200 palabras (±15%). Prosa estructurada.
     2-4 objetivos mayores, cada uno en su propio párrafo (40-60w).
     Cada objetivo declara qué problema de negocio resuelve y cómo.
     v1.1 (session076): renombrada desde "Finalidades" y reubicada antes de Cambios por capacidad. -->

{{OBJETIVO}}

# Cambios por capacidad

<!-- 400 palabras (±15%). Sub-secciones por capacidad (3-5 sub-secciones).
     Cada sub-sección con header `## ` (h2) titulada con la capacidad de negocio.
     Cada sub-sección: 1 párrafo corto (30-50w) + 2-4 bullets con detalle. -->

## {{CAPACIDAD_1}}
{{LOGROS_CAPACIDAD_1}}

## {{CAPACIDAD_2}}
{{LOGROS_CAPACIDAD_2}}

## {{CAPACIDAD_3}}
{{LOGROS_CAPACIDAD_3}}

## {{CAPACIDAD_4_OPT}}
{{LOGROS_CAPACIDAD_4_OPT}}

## {{CAPACIDAD_5_OPT}}
{{LOGROS_CAPACIDAD_5_OPT}}

# Componentes impactados

<!-- 80 palabras (±20%; tabla — pesa menos por palabra). Tabla markdown 3 columnas:
     | Componente | Tipo | Estado |
     - Componente: nombre legible de la fuente / repo / módulo / esquema+tabla. Puede incluir
       sub-clasificación cuando varios módulos de la misma fuente cambiaron.
     - Tipo: "BackEnd" | "FrontEnd" | "Base de datos" (en español, no abreviado).
     - Estado: "Completo" | "Cambios pendientes".
     4-10 filas en C (más granular que B). Una fila por componente impactado en el período.
     v1.1 (session076): sección nueva. Sourcing en SKILL.md §Paso 4. -->

{{COMPONENTES_IMPACTADOS}}

# Diagrama de flujo

<!-- 0 palabras contadas (code-fenced; exento de V1).
     v1.2 (session077): Mermaid `flowchart LR` por default (4-8 nodos típicos en C);
     audiencia comité consume mejor el render visual del viewer Markdown.
     ASCII (arrows ↔ → ←, boxes [Nombre]) permanece como fallback opt-in.
     Máx ~20 líneas dentro del code fence en C.
     Mostrar conexión/integración entre los componentes listados arriba.
     v1.1 (session076): sección agregada. Sourcing en SKILL.md §Paso 4. -->

{{DIAGRAMA_FLUJO}}

# Alcances

<!-- 150 palabras (±15%). Bullets cortos detallados.
     5-7 items. Describir lo que el sistema CUBRE hoy con suficiente granularidad. -->

{{ALCANCES}}

# Límites

<!-- 150 palabras (±15%). Bullets cortos detallados.
     4-6 items. Describir lo que el sistema NO cubre hoy.
     Sin tono defensivo, sin excusas; expectativas claras. -->

{{LIMITES}}

# Riesgos y deuda

<!-- 150 palabras (±15%). Bullets cortos categorizados.
     Sub-categorías: "De negocio", "Operativos", "Técnicos" (todas opcionales — incluir las que apliquen).
     3-5 items totales. ≤25 palabras por item. -->

{{RIESGOS}}

{{OPORTUNIDADES_OR_OMIT}}

# Referencias

<!-- Resto. Bullets con links por categoría.
     Hasta 8 referencias. Agrupar por categoría con sub-headers `## ` si la cantidad lo justifica. -->

{{REFERENCIAS}}
```

---

## C vs B (default)

| Aspecto | Variante B (default) | Variante C (extensa) |
|---|---|---|
| Cota | 760w (v1.1) | 1620w (v1.1) |
| Secciones | 9 obligatorias + Oportunidades cond. | 10 obligatorias + Oportunidades cond. |
| "Contexto del período" | omitido | sección propia (100w) |
| "Logros del período" | bullets planos agrupados por capacidad | sub-seccionado con `##` por capacidad (titulado "Cambios por capacidad") |
| "Alcances / Límites" | una sección con dos sub-bloques | 2 secciones separadas (Alcances y Límites) |
| "Componentes impactados" | tabla 3-7 filas (60w) | tabla 4-10 filas (80w) |
| "Diagrama de flujo" | Mermaid `flowchart LR` ~15 líneas (default) + link mermaid.ink debajo; ASCII fallback opt-in (sin link) | Mermaid `flowchart LR` ~20 líneas (default) + link mermaid.ink debajo; ASCII fallback opt-in (sin link) |
| Tiempo de lectura | 5-7 min | 8-12 min |
| Audiencia natural | gerencia + jefatura | comité de seguimiento, audit-grade |
| Header | 2 líneas | 3 líneas (incluye "Audiencia:") |
| Diagrama opt-in adicional | máx 1 (más allá del obligatorio) | máx 1 (más allá del obligatorio) |

## Renderizado del header (3 líneas)

```
{{PRODUCTO}} — Informe ejecutivo extenso
Período: Del {{FECHA_INICIO}} al {{FECHA_FIN}}. {{N_SESIONES}} sesiones trabajadas.
Audiencia: Comité de seguimiento
```

V5 verifica que la línea 3 contenga literalmente "Audiencia: Comité de seguimiento" cuando la variante es C.

## `{{OPORTUNIDADES_OR_OMIT}}` — v1.1 (renombrado desde `{{RECOMENDACIONES_OR_OMIT}}`)

**Condicional**, misma lógica que B.

**A. Si corpus tiene items abiertos** → incluir:

```markdown

# Oportunidades de mejora

<!-- 150 palabras (±15%). Bullets con responsable + horizonte.
     3-5 items. Sin priorización P1/P2/P3.
     Detalle ligeramente mayor que en B (puede incluir contexto de cada oportunidad).
     v1.1 (session076): renombrada desde "Recomendaciones / próximos pasos". -->

{{OPORTUNIDADES}}
```

**B. Si NO hay items abiertos** → cadena vacía. Doc fluye de "Riesgos y deuda" a "Referencias".

## Reglas de render específicas

1. **Cota total 1620w**: hard fail >1944w o <1296w. Tolerancia warning ±10% (1458-1782w). **Cuando Oportunidades de mejora se omite (corpus sin items abiertos), ventana efectiva de V1 se desplaza a 1470w ±10% (1323-1617w)** — V1 honora el escenario sin emitir warning low. Hallazgo H13 / DEC-005 (session079): los pesos sin Op suman 1470w; mantener la ventana original 1458-1782w generaría warnings de borde sin valor.
2. **NO incluye sección "Métricas"**: decisión de usuario en session056. Si se necesitan datos cuantitativos, van en `export-arq` o `export-mt` (citados en Referencias).
3. **Sub-secciones `##` en "Cambios por capacidad"**: V3 valida que el header `#` "Cambios por capacidad" exista y que tenga al menos 3 sub-headers `##` bajo él.
4. **Diagrama Mermaid obligatorio en C (v1.2)**: el `{{DIAGRAMA_FLUJO}}` es ` ```mermaid ` con `flowchart LR` por default (4-8 nodos típicos). ASCII en plain code fence es fallback opt-in cuando Mermaid no aporta claridad. v1.1 había introducido la sección como ASCII obligatorio; v1.2 invierte el default por audiencia comité de seguimiento (mejor consumo visual). Un segundo diagrama opt-in adicional sigue permitido si el usuario lo solicita.
5. **Link mermaid.ink obligatorio cuando engine=mermaid (v1.3 — session078)**: blockquote inline debajo del fence con `> Ver diagrama renderizado: <https://mermaid.ink/img/BASE64>`. Encoding plain base64 URL-safe del código Mermaid plano. ASCII fallback NO lleva link. Mismo formato canónico que en B.
5. **Léxico**: misma tabla que B; léxico vetado idéntico (V2 mismo grep).
6. **Validations**: V1-V6 igual que B; V1 con cota 1620w; V3 verifica 10 secciones obligatorias.

## Cuándo elegir C en lugar de B

- Audiencia: comité de seguimiento, audit-grade.
- Período: largo (trimestre completo o semestre).
- Cantidad de cambios: ≥30 sesiones cerradas en el período.
- Necesidad de granularidad por capacidad (B agrupa todo en una sección).
- Acompañamiento al cierre fiscal o reporting estratégico (no operacional).
