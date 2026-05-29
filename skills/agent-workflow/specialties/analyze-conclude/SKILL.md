---
name: analyze-conclude
description: "Produce CONCLUSIONS.md como cierre del análisis para las 3 modalidades (technical/incident/data). Una sola estructura: summary + conclusions con evidencia + recommendations con responsable + traceability. Vive en la sesión, no se gradúa por defecto. Invocado al final de execution en sesiones analyze cuando ya existe FINDINGS.md. Reemplaza a analyze-rfc, analyze-data y analyze-postmortem."
version: 2.1.0
---

# analyze-conclude — qtc v2.1+

Specialty skill **analyze**: produce el cierre del análisis para cualquier modalidad (technical / incident / data). Última fase de execution para sesiones analyze.

> **v2.0+ unifica el output**: reemplaza a `analyze-rfc`, `analyze-data` y `analyze-postmortem`. Las 3 modalidades comparten una sola estructura (`CONCLUSIONS.md`) con la sección `## Modality` embebida. La diferencia entre modalidades queda en el contenido de Conclusions / Recommendations, no en archivos separados.

## Cuándo se invoca

- Composición desde `agent-workflow:session` al final de execution si OBJECTIVE declara `## Modality: technical|incident|data` (legacy: `## Modalidad: tecnica|incidente|datos`) y existe `FINDINGS.md` (legacy: `HALLAZGOS.md`).
- NL del usuario: "armá las conclusiones", "cerrá el análisis", "documentá las recomendaciones", "armá la propuesta", "spec final del análisis", "armá el post-mortem", "armá el informe".

## Acción

Producir `.workflow/sessions/<folder>/CONCLUSIONS.md` con la estructura canónica única.

### Estructura canónica de CONCLUSIONS.md

```markdown
# Conclusions — sessionNNN-analyze-<slug>

## Modality

<technical | incident | data>

## Summary

[1-3 oraciones: qué se investigó, qué se concluyó, qué hacer al respecto.]

## Conclusions

- **C1**: <conclusión + link a evidencia (`EVIDENCE.md#section` o `FINDINGS.md#patron`)>
- **C2**: <conclusión + evidencia>
- **C3**: ...

## Recommendations

- **R1**: <acción concreta + responsable + cuándo (fecha objetivo o ventana)>
- **R2**: <acción + responsable + cuándo>
- **R3**: ...

## Traceability

- EVIDENCE: `.workflow/sessions/<folder>/EVIDENCE.md`
- FINDINGS: `.workflow/sessions/<folder>/FINDINGS.md`
- queries/: lista de archivos si aplica
- Decisiones derivadas: <DEC-NNN si aplica> (en DECISIONS.md de la sesión)

## Open (gaps)  [opcional]

- <pregunta sin respuesta que requiere más investigación>
- <hipótesis sin probar>
```

### Reglas comunes a las 3 modalidades

- **Conclusions con evidencia**: cada `**CN**` enlaza al artefacto que lo sustenta (EVIDENCE o FINDINGS). Sin evidencia no se afirma.
- **Recommendations accionables**: cada `**RN**` declara responsable (persona/equipo, no "alguien") y cuándo (fecha objetivo o ventana, no "pronto").
- **Sin código de implementación**: el documento describe QUÉ hacer, no CÓMO. La implementación es de flow=dev (otra sesión, vía handoff `--from analyze:NNN`).
- **Honest gaps**: si quedan preguntas sin responder, va `## Open (gaps)`. No esconder debilidades del análisis.
- **Modality embebida**: la sección `## Modality` declara el sabor (technical / incident / data). El contenido del cuerpo se modula por modalidad pero la estructura no cambia.

## Modulación por modalidad

La estructura es única. Lo que cambia es el peso y el contenido de cada sección.

### Modality: technical (propuesta tradicional)

- **Summary**: qué decisión técnica se recomienda y por qué.
- **Conclusions**: opciones evaluadas con tradeoffs (pros/cons/costo S/M/L). Cada CN puede ser una opción descartada con su razón o la opción recomendada con su justificación.
- **Recommendations**: típicamente una `**R1**` que describe la decisión final + acciones de seguimiento (handoff a dev, ajustes de doctrina).
- **Open**: dependencias externas, decisiones que dependen de otra sesión.

Reglas específicas:
- **Moderación primero (anti sobre-análisis)**: antes de enumerar opciones, decisiones o riesgos, validá contra el OBJECTIVE literal y el material adjunto:
  - ¿El stakeholder pidió esta decisión? Si no aparece en `OBJECTIVE.question` ni en las referencias, **no la inventes** — omitila.
  - ¿La infraestructura ya existe en el repo (GCP, colas, motor de decisiones, generación/envío de documentos, auth, etc.)? **Asumila disponible** y no la rediscutas como si fuera greenfield. El análisis compone sobre lo existente; no re-decide lo ya provisto.
  - ¿El "riesgo" bloquea realmente el dev, o es especulación (vector OSINT teórico, duplicidad hipotética)? Si no bloquea, **omitilo**.
  - Si el scope es claro sobre un stack maduro: una CONCLUSIONS de **≤1 página con 1 recomendación** basta. No fuerces secciones cuando no hay una decisión real que tomar.
- **Opciones solo si hay decisión genuina**: cuando el stakeholder sí planteó una decisión abierta, 3 opciones es óptimo (2 si el espacio es claro, hasta 4 si la ambigüedad es alta; más es ruido). Si **no** hay decisión pedida, no fabriques un set de opciones — describí la composición sobre lo existente y pasá directo a la recomendación.
- **Tradeoffs explícitos**: nunca "ventaja: bueno". Cada Pro/Con específico.
- **Costo estimado obligatorio**: S/M/L de implementación.
- **Decisión recomendada con justificación**: no presentar opciones sin elegir. Si genuinamente no hay una mejor, declararlo y describir cómo decidir (ej. "depende de tolerancia a downtime: A si 0, B si <1h").
- **Máximo 1 sesión dev derivada**: la recomendación propone **una** sesión dev de handoff por default. Solo proponé múltiples si el stakeholder lo pidió explícitamente o si hay una dependencia técnica dura que las separa (declarala).

### Modality: incident (post-mortem tradicional)

- **Summary**: qué pasó, cuándo, impacto, causa raíz, qué se hizo. Incluir severidad declarada (SEV1/2/3/4) con justificación de 1 línea.
- **Conclusions**: timeline (`**C1**`: timeline), causa raíz (`**C2**`: causa raíz), impacto cuantificado (`**C3**`: impacto), lo que funcionó / no funcionó (`**C4**`/`**C5**`).
- **Recommendations**: acciones inmediatas hechas (`**R1**`), acciones preventivas con owner + fecha (`**R2**`/`**R3**`/...). Priorizar P1 = bloqueo de SEV similar futuro; P2 = reduce probabilidad; P3 = mejora detección/respuesta.
- **Open**: lecciones aprendidas pendientes de socializar.

Reglas específicas:
- **Sin culpas**: foco en sistemas y procesos, no personas. "El deploy no tenía smoke test" > "Juan deployó sin testear".
- **Timeline en hora local + UTC si cross-timezone**.
- **Acciones preventivas con owner + fecha**: vagueness mata follow-up.
- **Honest about gaps**: si no se sabe la causa raíz exacta, decirlo.

Para detalles de severidad, impacto cuantitativo y timeline de comunicación, ver `references/incident-classification.md`.

### Modality: data (informe de análisis)

- **Summary**: qué se midió, qué se encontró, qué hacer al respecto.
- **Conclusions**: hallazgos numéricos con valor + comparación + tendencia (`**C1**`: métrica X = ..., +33% vs período anterior, link a query). Interpretación en contexto del negocio.
- **Recommendations**: acciones SUGERIDAS basadas en los datos (técnicas, de producto/proceso, investigación adicional).
- **Traceability**: agregar `queries/*.sql` con cada métrica enlazada a la query que la produjo.
- **Open**: limitaciones del análisis (sample size, sesgos conocidos, datos faltantes).

Reglas específicas:
- **Números siempre con unidad y contexto**: "2.4M" sin más es ruido; "2.4M solicitudes en Q1 2026 (vs 1.8M Q4 2025, +33%)" tiene contenido.
- **Citar queries**: cada métrica enlaza a la query que la produjo. Reproducibilidad.
- **Metodología documentada**: tamaño de muestra, ventana, manejo de nulos, outliers, tests de hipótesis si aplican. Sin metodología los números son indefendibles.
- **Limitaciones honestas**: si hay sample bias, datos faltantes, ventana corta, decirlo en `## Open`.
- **Acciones SUGERIDAS, no ordenadas**: el informe propone; el usuario/equipo decide qué accionar.

#### Metodología estadística (modality=data)

Decisiones metodológicas que el documento debe declarar al elegir modality=data:

- **Tamaño de muestra**: `n = X (universo|sample, ventana <fecha>–<fecha>)`. Para sampling: `n ≥ 384` para 95% confianza, ±5% margen sobre proporción 0.5 (peor caso).
- **Intervalos de confianza**: default 95%. Reportar como `valor ± margen` o `[lower, upper]`. Wilson/Clopper-Pearson para proporciones; t-Student si n<30; Poisson exact CI para conteos.
- **Manejo de nulos**: excluir (<5% sin bias), imputar (<15% con justificación), reportar separado (≥15% o estado-nulo informativo), o bloquear análisis si invalida conclusiones.
- **Outliers**: IQR (default), z-score (normal), percentil 1/99 (robustez), o domain rule. Reportar cuántos hay y su impacto.
- **Tests de hipótesis** (opcional): H0/H1 explícitas, p-value + tamaño de efecto, α=0.05 default, Bonferroni si múltiples comparaciones.

## Loop de iteración

1. Primer draft de CONCLUSIONS.md.
2. Mostrar al usuario.
3. Iterar (Edit, no recreación) hasta que el usuario confirme: "OK, lo dejo así".

## Cierre y graduación

**Default: no graduar.** CONCLUSIONS.md vive en la sesión (`.workflow/sessions/<folder>/CONCLUSIONS.md`). La sesión cierra y el artefacto queda como referencia consultable; las recommendations accionables se ejecutan vía sesiones de handoff (`--from analyze:NNN`) o quedan en backlog informal.

**Si el usuario pide graduarlo explícitamente**: usar `kind = conclusion` (uno de los 6 kinds del modelo nuevo):

```
agent-workflow graduate --kind conclusion --session <CODE> --slug <kebab>
```

Destino:
- **workspace_mode=hub** → `<hub>/docs/conclusiones/NNN-<slug>.md`.
- **workspace_mode=project** → `<project>/docs/conclusiones/NNN-<slug>.md`.

La regla canónica DEC-002 manda destino sin prompt por sesión: hub mode → hub root; project mode → cwd. Sin override.

Sugerir handoff post-cierre: `/agent-workflow:session --from analyze:NNN "<acción de implementación>"`.

> Regla canónica de routing: `agent-workflow/skills/session/references/graduacion-routing.md`.

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `analyze-synthesize` | pre-requisito (FINDINGS.md debe existir) |
| `analyze-investigate` | si surge nueva pregunta durante el cierre, retroceder con queries adicionales |
| `agent-workflow:session --from analyze:NNN` | post-cierre, para implementar acciones |

## Sandbox read-only

Reglas universales en `../session/references/sandbox-readonly-rules.md`. En plan mode esta skill describe en el plan file:

- **Path destino**: `.workflow/sessions/<folder>/CONCLUSIONS.md`.
- **Modality declarada** en OBJECTIVE (`technical`/`incident`/`data` requerido; legacy ES `tecnica`/`incidente`/`datos` se normaliza). Si falta o es otra, plan dice "preguntar al usuario".
- **Esqueleto de CONCLUSIONS.md**: secciones canónicas (Modality, Summary, Conclusions, Recommendations, Traceability, Open opcional). Modulación según modalidad.
- **Investigación previa requerida**: si hay sub-preguntas pendientes en FINDINGS, listar para que el usuario decida si invoca `analyze-investigate` antes.

NO ejecuta: `Write` sobre CONCLUSIONS.md, queries MCP costosas (>10k filas estimadas), `agent-workflow graduate`.

## Recursos

- **`references/incident-classification.md`** — severidad SEV1/2/3/4, impacto cuantitativo, timeline de comunicación, trazabilidad de acciones (aplica a modality=incident).
- shared-contract §10 — handoff `--from analyze:NNN`.
- shared-contract §11 — convención `## Modality`.
- shared-contract §14 — fase execution del lifecycle universal.
