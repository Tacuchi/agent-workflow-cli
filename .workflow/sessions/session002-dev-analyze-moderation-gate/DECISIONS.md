# Decisions — session002-dev-analyze-moderation-gate

## DEC-001 — Alcance Nivel 1 (doctrina) sobre Niveles 2/3

**Contexto**: el issue 001 propone 3 niveles para frenar el sobre-análisis en
flow=analyze sobre hubs maduros. Sus criterios de aceptación se cumplen con
"cualquiera de los 3".

**Decisión**: aplicar solo **Nivel 1** (reglas de moderación en doctrina
markdown). Diferir Nivel 2 (`analyze:lite` en el CLI) y descartar por ahora
Nivel 3 (detección automática de "hub maduro").

**Razón**:
- Nivel 1 es markdown-only → propaga a todo host vía npm + `self install-skill`,
  sin tocar CLI/tests.
- Cumple los 4 criterios de aceptación por sí solo.
- Coherente con la propia lección del issue: no sobre-construir el arreglo del
  sobre-análisis.
- Nivel 2 queda como fast-follow si Nivel 1 resulta insuficiente; Nivel 3 tiene
  heurísticas frágiles (ROI especulativo).

## DEC-002 — CONSOLIDADO.md / MAPEO-*.md no son artefactos canónicos

**Hallazgo**: `grep` en el repo source y en los skills instalados
(`~/.claude/skills/agent-workflow/`) → 0 hits de `CONSOLIDADO`/`MAPEO`. El
reproducer del issue describe artefactos que el agente improvisó; la doctrina
canónica del flow=analyze es `EVIDENCE → FINDINGS → CONCLUSIONS`.

**Decisión**: la regla de moderación reafirma explícitamente los artefactos
canónicos y trata los mapeos por-repo como evidencia, no como deliverable
separado. El locus real del síntoma "decisiones D1–D5" es
`analyze-conclude` modality=technical (rúbrica "opciones evaluadas + decisión
recomendada"), no un template CONSOLIDADO inexistente.

## Loci editados (Nivel 1)

- `specialties/analyze-conclude/SKILL.md` — modality=technical: "Moderación
  primero", opciones solo si hay decisión genuina, máx 1 sesión dev derivada.
- `workflows/analyze-workflow/SKILL.md` — sección "Moderación" transversal +
  caveat en la definición de `modality=technical`.
- `doctrine/session/SKILL.md` — bullet cross-cutting en "Reglas generales"
  apuntando al canon.
