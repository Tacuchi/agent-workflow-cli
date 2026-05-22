# Plantilla Variante A — Informe ejecutivo compacto (1-pager · 400w)

Plantilla para audiencia gerencia. Cota dura **400 palabras (±10%; hard fail ±20%)**. 4 secciones obligatorias en orden fijo + Oportunidades condicional. Sin Objetivo, sin Alcances/Límites, **sin Componentes impactados ni Diagrama de flujo** (información esencial absorbida en Resumen y Oportunidades de mejora por cota dura). v1.4 (session079): rebalance de pesos para acomodar Op sin saturar cota (DEC-004).

---

```markdown
{{PRODUCTO}} — Informe ejecutivo
Período: Del {{FECHA_INICIO}} al {{FECHA_FIN}}. {{N_SESIONES}} sesiones trabajadas.

# Resumen

<!-- 90 palabras (±15%) — v1.4 (session079): bajó de 100w por rebalance con Op.
     Prosa densa.
     Estructura sugerida: qué hace el sistema + en qué estado está + qué se hizo + por qué importa.
     Esta sección absorbe parte de lo que B pone en "Objetivo" y "Alcances/Límites":
     mencionar 1-2 objetivos mayores + 1 línea sobre el scope actual.
     Prohibido: acrónimos sin glosar, nombres internos. -->

{{RESUMEN}}

# Cambios

<!-- 120 palabras (±15%) — v1.4 (session079): bajó de 130w por rebalance con Op.
     Bullets agrupados por capacidad (NO por sesión).
     5-7 bullets cortos. Cada bullet ≤20 palabras, empezando con verbo en participio.
     Sin agrupación visible (no sub-headers); todo plano. -->

{{LOGROS}}

# Riesgos

<!-- 70 palabras (±15%). Bullets cortos.
     3-4 items. Mezcla riesgos abiertos y deuda funcional crítica.
     Compactos: ≤18 palabras por item. -->

{{RIESGOS}}

{{OPORTUNIDADES_OR_OMIT}}

# Referencias

<!-- Resto (~100 palabras). Bullets cortos con links por categoría.
     Hasta 4 referencias. Omitir categorías sin material. -->

{{REFERENCIAS}}
```

---

## A vs B (default)

| Aspecto | Variante A (compacta) | Variante B (default v1.1) |
|---|---|---|
| Cota | 400w | 760w |
| Secciones | 4 obligatorias + Oportunidades condicional | 9 obligatorias + Oportunidades condicional |
| Período cubierto | absorbido en línea de header | sección propia (20w) |
| Objetivo | absorbido en Resumen | sección propia (120w) |
| Alcances/Límites | omitido | sección propia (120w) |
| Componentes impactados | **omitido (cota dura)** | tabla obligatoria (60w) |
| Diagrama de flujo | **omitido (cota dura)** | obligatorio (code-fenced, 0w V1) |
| Logros | renombrado a "Cambios"; 5-7 bullets cortos | "Logros del período"; 4-8 bullets más detallados |
| Tiempo de lectura | 3-4 min | 5-7 min |
| Audiencia natural | gerencia | gerencia + jefatura |

## Renderizado del header

Sólo 2 líneas (no agrega "Audiencia: ..." como en C). El header está exento de V2 (léxico vetado) y no cuenta para V1 (cota de palabras del cuerpo).

## `{{OPORTUNIDADES_OR_OMIT}}` — v1.1 (renombrado desde `{{RECOMENDACIONES_OR_OMIT}}`, condicional, mismo comportamiento que en B)

**A. Si corpus tiene items abiertos** → incluir:

```markdown

# Oportunidades de mejora

<!-- 60 palabras (±15%) — v1.4 (session079): bajó de 70w por rebalance.
     Bullets con horizonte (sin responsable detallado en A).
     2-3 items máximo. Tono muy breve.
     v1.1 (session076): renombrada desde "Próximos pasos" para alinear con B/C. -->

{{OPORTUNIDADES}}
```

**B. Si NO hay items abiertos** → cadena vacía. El doc fluye de "Riesgos" a "Referencias".

## Reglas de render específicas

1. **Cota total 400w**: hard fail >480w o <320w. Tolerancia warning ±10% (360-440w). Pesos v1.4: Resumen 90w + Cambios 120w + Riesgos 70w + (Oportunidades cond 60w) + Referencias ~100w (resto). Suma sin Op: 90+120+70+100 = 380w. Suma con Op: +60 = 440w (límite superior warning, sin hard fail).
2. **Sin diagramas**: A no admite el Diagrama de flujo obligatorio de B/C (la cota es demasiado ajustada para que un diagrama aporte sin desplazar contenido).
3. **Sin Componentes impactados**: misma razón — la información de qué componentes cambiaron se absorbe en Resumen+Cambios; los lectores de A (gerencia) no requieren tabla de componentes.
4. **Compresión vs B**: el rendering desde corpus es el mismo; al elegir A, el motor comprime descartando Objetivo, Componentes, Diagrama y Alcances/Límites + reduciendo bullets de Logros + reduciendo prosa de Resumen.
5. **Léxico igual que B**: aplica `lexico.md` con la misma tabla.
6. **Validations**: V1-V6 igual que B; V1 con cota 400w; V3 verifica las 4 secciones obligatorias.
