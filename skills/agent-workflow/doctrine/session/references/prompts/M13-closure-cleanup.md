# M13 — closure-cleanup (gate de calidad pre-commit en closure)

Spec literal del prompt M13. Index: [`../prompts-catalog.md#m13--closure-cleanup-gate-de-calidad-pre-commit-en-closure`](../prompts-catalog.md#m13--closure-cleanup-gate-de-calidad-pre-commit-en-closure).

- **Cuándo**: en `skills/session/SKILL.md` §1.5 "Inspección y limpieza pre-commit", tras graduate (paso 1) y antes de propose commits (M1 / paso 2). Auto-disparado por closure cuando se cumple **ambas** condiciones:
  - ≥1 fuente declarada en la sesión tiene `dirty=true` (`agent-workflow sources --session <CODE>`).
  - La inspección del diff produce ≥1 hallazgo en alguna de las 5 categorías canónicas.
- **Skip silencioso**:
  - Todas las fuentes `dirty=false` (nada que limpiar).
  - Inspección no encuentra hallazgos en ninguna fuente (working tree ya limpio).
  - Plan mode activo (el gate describe hallazgos en el plan file sin disparar prompt).
- **Forma**: 1 invocación `AskUserQuestion` con **N questions tab-por-fuente** (max 4 simultáneas; tandas si N>4).
  - Por cada fuente dirty con hallazgos:
    - `header`: `<alias>` (ej. `agent-workflow`, `qtc-workflow-plugin`).
    - `question`: "Cleanup en `<alias>` — `<N>` hallazgos (`<categorías>`). ¿Aplico?"
    - `multiSelect`: false.
    - `options`:
      1. "Aprobar fixes sugeridos (Recomendado)" — "El AI aplica los edits acotados al working tree (`Edit`/`MultiEdit` por archivo, diff visible). Cada fix local y reversible."
      2. "Sólo reportar (no tocar)" — "Deja los hallazgos en `CHECKPOINT.md` como 'Hallazgos pendientes' sin modificar working tree."
      3. "Saltar esta fuente" — "Ignora los hallazgos para esta closure. No se registra."
    - **Other auto** = nota custom del usuario (ej. "fixeo manual después", "ignorá X específico", "aplicá sólo categoría comentarios"). El AI interpreta y actúa en consecuencia.
- **Preview (opcional pero recomendado)**: cuando hallazgos > 5 por fuente, incluir preview ASCII con resumen:

  ```
  Cleanup report — <alias>
  ────────────────────────
  Comentarios redundantes:  3 hallazgos
  Complejidad cognitiva:    1 hallazgo
  Antipatrones:             2 hallazgos
  Code smells:              0
  Código muerto:            1 hallazgo

  Top fixes sugeridos:
    1. src/foo.ts:42 — quitar `// TODO obvio` huérfano
    2. src/bar.ts:88 — extraer helper de método 80-líneas
    3. src/baz.ts:15 — reemplazar magic number 86400 con const
  ```

- **Aplicación de los fixes (opción 1)**:
  - Por archivo: leer (`Read`), aplicar `Edit` o `MultiEdit` con cambios acotados. Mostrar diff antes/después al usuario.
  - Refactor estructural mayor (mover archivos, renombrar packages, cambios cross-paquete): NO aplica aquí — aplazar a sesión `## Type: refactor` con Strangler Fig.
  - Tras aplicar todos los fixes de una fuente: re-ejecutar `agent-workflow sources --session <CODE> --scope <alias>` para validar consistencia.
- **Sin auto-confirmación**: aunque opción 1 esté marcada `(Recomendado)`, requiere selección explícita del usuario por fuente. NO se asume auto-correct.
- **Sandbox plan-mode**:
  - Describir hallazgos por categoría en el plan file (paths + razones). 
  - NO ejecuta `Edit`/`Write`/`Bash` mutante.
  - M13 no se dispara; el reporte queda en plan file para que el usuario decida fuera de plan mode.
- **Categorías canónicas** (referencia, detalles en `session/SKILL.md` §1.5):
  1. **Comentarios redundantes** — qué obvio, código muerto comentado, TODO sin owner/fecha, headers decorativos.
  2. **Complejidad cognitiva** — métodos largos (>50 líneas), nesting profundo (>3), early-return ausente, condicionales anidados.
  3. **Antipatrones** — `catchError(() => of([]))`, magic numbers, side effects no declarados, god class/method, lógica replicada FE+BE.
  4. **Code smells** — DRY violado, naming oscuro, duplicación con `shared/`/`common/`, validación post-uso, mutación de parámetros.
  5. **Código muerto** — imports sin usar, branches inalcanzables, variables huérfanas, funciones no llamadas.
- **Composición**:
  - `agent-workflow:coding-standards` — fuente de verdad de qué es "bien" por stack (anchor #5 del bundle /rules).
  - `agent-workflow:redaccion-simple` — formato del reporte breve (anchor #4 del bundle /rules).
- **Anti-narración**: NUNCA narrar la pregunta en texto plano ("¿quieres que aplique los fixes en agent-workflow?" en chat es un anti-patrón). Siempre vía `AskUserQuestion`.
- **Refs**:
  - `skills/session/SKILL.md` §1.5 — pipeline canónica del gate.
  - `skills/rules/SKILL.md` §8 (`agent-workflow:closure-cleanup`) — anchor en bundle /rules.
  - `skills/coding-standards/SKILL.md` — reglas por stack que el gate consulta.
