---
name: analyze-investigate
description: Recolección de evidencia divergente sin juicio. Lee código, corre queries read-only contra <mcp-cert>/<mcp-prod> (MCPs), tracea logs, cava git history. Produce EVIDENCE.md + queries/. Invocado en execution de sesiones analyze (cualquier modalidad). Pre-requisito de analyze-synthesize en analyze sessions.
version: 1.2.0
---

> **Profile parametrization**: lee `mcp_databases[]` de `profile.json` (resuelto vía cascade 5 capas). Ver [`references/profile-parametrization.md`](../../references/profile-parametrization.md) para el contrato completo y comportamiento por defecto cuando el profile está vacío.

# analyze-investigate — qtc v1.1+

Specialty skill **analyze**: investigación divergente. Primer paso de `execution` para sesiones analyze (cualquier modalidad). **Read-only**.

## Rama base — verificar antes de leer/queries

Antes de lecturas extensivas o queries (`Grep`, `Read`, MCP `<mcp-cert>`/`<mcp-prod>`), confirmar que cada fuente está en su `main_branch` (default `certificacion`). El análisis sobre otra rama puede divergir de producción y producir conclusiones erradas.

- El lifecycle ya valida esto al entrar a execution (skill `session`, bloque "Verificación interactiva de ramas"). Si no se ejecutó, correr `agent-workflow sources` antes de la primera evidencia.
- Si una fuente está en otra rama, **avisar** explícitamente en `EVIDENCE.md` que el análisis se hizo sobre `<current_branch>` y aclarar el riesgo de divergencia.
- Para decidir editar código durante la investigación, ver Caso C en `../session/references/branch-verification.md` (no aplica a este skill — es read-only).

## Cuándo se invoca

- Composición desde `agent-workflow:session` en `execution` cuando es sesión `analyze` y todavía no existe `EVIDENCE.md` (legacy: `EVIDENCIA.md`).
- NL: "investigá", "buscar evidencia", "qué dice el código sobre X", "corré la query".
- Devuelta por `specialty-choose --phase execution` cuando OBJECTIVE menciona análisis/investigación/propuesta/post-mortem.

## Acción

Producir `.workflow/sessions/<folder>/EVIDENCE.md` + opcionalmente `queries/*.sql`.

### Estructura de EVIDENCE.md

```markdown
# Evidence — sessionNNN-analyze-<slug>

## Original question

[Copiar `## Question` del OBJECTIVE.md.]

## Sources consulted

- Código: <repo+path/file.java líneas X-Y>
- Logs: <archivo o sistema>
- BD (<mcp-cert> / <mcp-prod>): <queries en queries/>
- Git history: <commits relevantes con SHA y fecha>
- Refs externas: <links si aplica>

## Raw finding 1: <título>

- **Qué se observó**: ...
- **Dónde**: <link/path>
- **Cuándo**: <fecha si aplica>

## Raw finding 2: ...

## Notes / tentative hypotheses

- [hipótesis sin compromiso, para revisar en analyze-synthesize]
```

### Lectura estructurada del OBJECTIVE

Para extraer la pregunta original sin leer todo el archivo:

```
agent-workflow objetivo-data --code <CODE>
```

Devuelve `{titulo, tipo, modalidad, brief, criterios_aceptacion, fuentes_mencionadas, origen}`. El `brief` aplica como "Original question" para sesiones analyze. El comando lee tanto `OBJECTIVE.md` (canónico EN) como `OBJETIVO.md` (legacy ES) vía bilingual readers de R1.

### Reglas para queries (modalidad=datos o tecnica con datos)

- **Read-only siempre**: SELECT, no DML. Los MCP servers `<mcp-cert>` y `<mcp-prod>` lo enforcan a nivel server.
- **Guardar en `.workflow/sessions/<folder>/queries/NNN-<slug>.sql`** con header:
  ```sql
  -- Query: <propósito>
  -- Server: <mcp-cert> | <mcp-prod>
  -- Fecha: 2026-04-26
  -- Sesión: sessionNNN-analyze-<slug>
  -- Costo estimado: <filas|N/A>; índices usados: <lista|none>
  ```
- **Numerar secuencialmente** por orden de ejecución.
- **Resultado resumido en EVIDENCE.md**, no el dump completo (puede ser MB).

### Cost guard — antes de ejecutar (v1.1+)

Las queries contra `<mcp-cert>` / `<mcp-prod>` tienen costo real (latencia, I/O, hold de conexión). Aplicar el cost guard antes de cualquier query no-trivial.

**Resumen de categorías**:
- **Barata**: COUNT(*) ≤ 1.000 filas o PK lookup → ejecutar directo.
- **Moderada**: 1.000-10.000 filas o seq scan sobre tabla pequeña → avisar al usuario tamaño + duración estimada antes.
- **Costosa**: > 10.000 filas o seq scan sobre >100k → **confirmación explícita** del usuario antes.
- **Bloqueada**: UPDATE/INSERT/DELETE → refusarse.

Procedimiento completo (4 pasos: estimar tamaño con COUNT(*) + EXPLAIN; clasificar; aviso al usuario con formatos exactos; registrar costo real en header) + excepciones permitidas + anti-patrones en **`references/cost-guard.md`**.

### Reglas para lectura de código

- Usar `Grep` y `Read` extensivamente. NUNCA `Edit/Write` durante investigate (read-only).
- Citar paths con líneas: `mscore-solicitud-spring/src/main/java/.../Foo.java:142`.
- Si el código está disperso, usar `Glob` + `Grep` para zoom.

### Reglas para logs y git history

- Logs: si hay acceso (SSH o herramienta del proyecto), describir la query/comando. Capturar timestamps relevantes.
- Git: `git log --oneline --since="<fecha>" -- <path>` para acotar. Capturar SHA + fecha + autor + mensaje. Si modalidad=incidente, capturar commit "culpable" destacado.
- **Solo git read-only**: `log`, `show`, `diff`, `blame`, `branch --show-current`. NUNCA ejecutar `git commit`/`push`/`merge`/`rebase`/`tag`/`reset --hard`/`checkout` durante investigate. Ver `agent-workflow:commits-policy`.

## Loop de investigación

```
[hipótesis] → [buscar evidencia] → [actualizar EVIDENCE.md] → [nueva hipótesis o convergencia]
                                           ↓
                                  [→ analyze-synthesize cuando hay suficiente]
```

Iterar hasta material suficiente para sintetizar.

## Reglas

- **NO juzgar durante investigate**: capturar lo que es, no lo que "debería ser". El juicio viene en `analyze-synthesize`.
- **Sin escribir código**: read-only. NUNCA Edit/Write durante investigate.
- **Honest about gaps**: si una fuente no está disponible, declararlo en EVIDENCE.
- **Sospechar de la pregunta original**: si surge evidencia que sugiere que la pregunta del OBJECTIVE está mal formulada, marcarlo en "Notes / tentative hypotheses".

## Composición con otras skills

| Skill | Cuándo |
|---|---|
| `analyze-synthesize` | siguiente paso una vez EVIDENCE tiene material suficiente |
| `analyze-conclude` | después de synthesize, produce CONCLUSIONS.md modulado por modalidad (technical/incident/data) |

## Sandbox read-only

`../session/references/sandbox-readonly-rules.md` (canon). En plan mode describe en el plan file:

- **Paths destino**: `.workflow/sessions/<folder>/EVIDENCE.md` + `queries/*.sql`.
- **Fuentes a consultar**: archivos de código (paths), tablas BD (schema + nombre), logs/dashboards (con ventanas), git history.
- **Queries propuestas**: lista con SELECT + tabla + ventana + costo estimado. Marcar costosas para que decida el usuario.
- **Estructura de EVIDENCE.md**: hallazgos crudos sin sintetizar.

NO ejecuta: queries MCP (aunque sean read-only — respetar plan mode), `Read` está permitido pero limitado a navegación, `Write` sobre EVIDENCE.md o queries/.

## Recursos

- **`references/cost-guard.md`** — protocolo completo de cost guard (4 pasos + excepciones + anti-patrones).
- MCP servers `<mcp-cert>` y `<mcp-prod>` — read-only por server config.
- shared-contract §14 — fase execution del lifecycle universal.
