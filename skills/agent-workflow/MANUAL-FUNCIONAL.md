# Manual funcional — agent-workflow

Manual de uso del workflow universal para usuarios finales.

Audiencia: developers, líderes técnicos y equipos que adoptan el workflow para llevar adelante trabajo estructurado en sesiones.

Esta documentación es del **workflow universal**, no de los plugins downstream específicos.

## 1. Qué resuelve

El workflow `agent-workflow` te da una forma estructurada de:

- **Acordar** qué se va a hacer (OBJETIVO).
- **Descomponer** el trabajo en tareas accionables (TASKS).
- **Avanzar** con visibilidad de criterios y decisiones (DECISIONES).
- **Cerrar** dejando trazas reproducibles (HISTORY + CHECKPOINT).

Está pensado para colaboración con un AI (Claude Code, Codex, etc.), pero el CLI funciona también sin AI.

Beneficios:

- Sesiones aisladas: cada trabajo tiene su carpeta, su rama, su brief.
- Recuperación post-compact: si el contexto del modelo se libera, retomás con `CHECKPOINT.md`.
- Historial trazable: `HISTORY.md` lista todas las sesiones del workspace.
- Portátil: el mismo CLI funciona en cualquier dominio cambiando solo el namespace.

## 2. Conceptos clave

### Sesión

Carpeta `.<ns>/sessions/sessionNNN-<flow>-<slug>/` con artefactos. NNN es correlativo, `<flow>` es el tipo (dev/design/analyze/etc.), `<slug>` es el nombre.

### Workspace

Directorio del proyecto con un bloque `<NS>-PROJECT` declarado en `CLAUDE.md` o `AGENTS.md`. El bloque define las fuentes (paths de los repos), modo (project simple o hub multi-repo), y status.

### Namespace

Identificador del dominio (ej. `workflow`, `acme`, `agent-workflow`). Define dónde viven las sesiones (`.<ns>/`) y el bloque project (`<NS>-PROJECT`).

### Flow

Tipo de trabajo: `dev` (implementación), `design` (UX/UI), `analyze` (investigación). Otros flows pueden agregarse por plugins downstream.

### Plugin downstream

Capa opcional que agrega skills de negocio sobre el workflow universal. Sin plugin, el workflow funciona igual; con plugin, ganás reglas específicas del dominio.

## 3. Las 4 fases

```
1. planning   →   2. execution   →   3. validation   →   4. closure
```

### Fase 1 — Planning

Acordás qué hacer.

Salidas:
- `OBJETIVO.md`: brief, criterios de aceptación, fuera de alcance.
- `TASKS.md`: lista accionable de tareas.

Comandos típicos:
```bash
agent-workflow auto-plan-decide --objetivo-file ...   # ¿el plan necesita ser ligero o detallado?
agent-workflow specialty-choose --phase planning ...  # ¿qué skills aplican?
agent-workflow tasks-data --code sessionNNN           # leer estado del plan
```

### Fase 2 — Execution

Hacés el trabajo.

Salidas:
- Edits en código / docs / scripts.
- `DECISIONES.md`: registro de elecciones no obvias.
- Artefactos opcionales según flow (`EVIDENCIA.md` en analyze, `ENTREGA.md` en design, etc.).

Comandos típicos:
```bash
agent-workflow tasks-data --only-open                 # próxima tarea
agent-workflow check-branch --source <alias>         # rama coincide?
agent-workflow topic-change-check --request "..."    # ¿cambió el OBJETIVO?
```

### Fase 3 — Validation

Verificás criterios cumplidos.

Salidas:
- Tareas marcadas cerradas.
- Notas de validación en `DECISIONES.md` si aporta.

Comandos típicos:
```bash
agent-workflow tasks-data --only-open                 # quedan tareas?
agent-workflow phase-detect --code sessionNNN         # ¿qué fase soy?
```

### Fase 4 — Closure

Cerrás y dejás trazas.

Salidas:
- `CHECKPOINT.md`: estado para retomar luego si hace falta.
- Fila `closed` en `HISTORY.md`.
- Artefactos graduados (`docs/decisiones/`, `docs/propuestas/`, etc. — si aplica).

Comandos típicos:
```bash
agent-workflow checkpoint-write --code sessionNNN
agent-workflow graduate --code sessionNNN --decisiones DEC-001-slug
agent-workflow session-close --code sessionNNN
```

## 4. Artefactos

| Artefacto | Cuándo aparece | Quién lo escribe | Lector CLI |
|---|---|---|---|
| `OBJETIVO.md` | Fase 1 | Vos / el modelo | `objetivo-data` |
| `TASKS.md` | Fase 1 | Vos / el modelo | `tasks-data` |
| `DECISIONES.md` | Fase 2 | El modelo registra elecciones | `decisiones-list` |
| `DEPENDENCIAS.md` | Fase 2 (opcional) | Si hay handoffs entre sesiones | `dependencias-list` |
| `CHECKPOINT.md` | Fase 4 | El modelo / hook PreCompact | `checkpoint-read` |
| `HISTORY.md` | Continuo | Auto-mantenido por el CLI | `history-data` |
| Convencionales (`EVIDENCIA`, `HALLAZGOS`, `RECOMENDACION`, `DISCOVERY`, `ENTREGA`...) | Fase 2 | El modelo según flow del plugin downstream | (no hay reader universal — markdown free-form) |

Regla práctica: si vas a escribir algo a mano, hacelo en el editor. El CLI no edita artefactos por vos — solo los lee y publica fila en HISTORY.

## 5. Flujos día a día

### 5.1 Crear sesión

```bash
agent-workflow session-create \
  --flow dev \
  --name fix-login-loop \
  --objetivo "Resolver redirect loop tras login en producción" \
  --branches "core:feature/fix-login,api:feature/fix-login"
```

Resultado: carpeta `.<ns>/sessions/sessionNNN-dev-fix-login-loop/` con `OBJETIVO.md` scaffold.

Variantes:
- `--tipo refactor` (sesiones de refactor con phased Phase 0-5).
- `--modalidad tecnica|datos|incidente` (sesiones analyze).
- `--from <flow>:NNN` (origen handoff de otra sesión).

### 5.2 Listar sesiones

```bash
agent-workflow sessions                           # activas
agent-workflow sessions --all                     # todas
agent-workflow sessions --include-legacy          # incluir folders legacy (.claude/.codex)
```

### 5.3 Retomar sesión

```bash
agent-workflow session-resume --code session042
agent-workflow checkpoint-read --code session042  # si hay checkpoint
```

Si retomás en otro día, el CLI te recuerda en qué fase estás (`phase-detect`) y qué tareas quedan abiertas (`tasks-data --only-open`).

### 5.4 Trabajar dentro de la sesión

Loop típico:
1. `agent-workflow tasks-data --code sessionNNN --only-open` → tomar próxima tarea.
2. Editar código (el modelo lo hace; el hook `branch-check` te avisa si la rama no coincide).
3. Marcar la tarea cerrada en `TASKS.md`.
4. Registrar decisión no obvia en `DECISIONES.md` si aplica.
5. Volver a 1.

### 5.5 Compactar contexto

Cuando el modelo se acerca al límite de contexto:

```bash
agent-workflow checkpoint-write --code sessionNNN   # persistir estado
# Luego /compact en el host (Claude Code, Codex)
agent-workflow checkpoint-read --code sessionNNN    # reentrar limpio
```

`auto-compact-on-close` (hook SessionEnd) lo hace por vos al cerrar el cliente.

### 5.6 Cerrar sesión

```bash
agent-workflow session-close \
  --code session042 \
  --graduated-decisions "DEC-001-slug-a,DEC-003-slug-b" \
  --refs "[CHECKPOINT](.<ns>/sessions/session042-.../CHECKPOINT.md)"
```

Antes de cerrar, considerá:
- Graduar decisiones importantes a `docs/decisiones/` con `agent-workflow graduate`.
- Hacer commits por fuente afectada (cada repo modificado).
- Compactar si tu cliente lo soporta.

## 6. Workspace mode: project vs hub

### Project mode

Workspace simple con 1 repo. La carpeta donde vivís y trabajás contiene `CLAUDE.md` con un bloque `<NS>-PROJECT` simple.

```bash
agent-workflow project-md-upsert --init
```

### Hub mode

Workspace que coordina varios repos pares. Útil cuando un trabajo cruza repositorios (frontend + backend + DB).

```bash
agent-workflow upgrade-hub-mode --dry-run
agent-workflow upgrade-hub-mode
```

El bloque `<NS>-PROJECT` lista cada fuente (alias, path, rama principal). Las sesiones declaran su rama de trabajo por fuente: `--branches alias1:rama1,alias2:rama2`.

`workspace-mode` te dice en qué modo estás:

```bash
agent-workflow workspace-mode
```

## 7. Quick start (sin plugin downstream)

Empresa nueva que adopta el workflow desde cero.

```bash
# 1. Instalar CLI
npm install -g @tacuchi/agent-workflow-cli

# 2. Instalar skill (si usás Claude Code)
agent-workflow self install-skill

# 3. Verificar
agent-workflow self doctor
# → cli_version, namespace, skill.installed

# 4. Setear namespace de tu organización (opcional, si no usás default)
echo "acme" > ~/.config/agent-workflow/namespace
# o per-call: agent-workflow --namespace acme ...

# 5. Inicializar workspace
cd /path/to/proyecto
agent-workflow project-md-upsert --init
# Editar CLAUDE.md / AGENTS.md para completar el bloque ACME-PROJECT (paths, ramas)

# 6. Primera sesión
agent-workflow session-create \
  --flow dev \
  --name primer-feature \
  --objetivo "Hello world: arrancar el workflow"

# 7. Ver estado
agent-workflow sessions
agent-workflow workspace-mode

# 8. Cerrar (cuando termines)
agent-workflow session-close --code session001
```

A partir del paso 8 ya tenés `HISTORY.md` poblado y la sesión cerrada con trazas.

## 8. Cuando agregar un plugin downstream

Considerá un plugin downstream cuando:

- Tu equipo necesita reglas específicas (coding standards, formato de scripts SQL, principios de UX).
- Querés flows propios (ej. `incident-response` además de `dev/design/analyze`).
- Querés hooks que enforce políticas internas (ej. PR template, branch naming).

El plugin no reescribe el workflow universal — solo agrega capas. Reglas:

- No re-implementar lógica del CLI (parsing, lifecycle, sources).
- Hooks invocan `agent-workflow ...` directamente.
- Skills propias solo cubren reglas de negocio del dominio.

Ver `MANUAL-TECNICO.md` sección 7.1 para los pasos.

## 9. Errores frecuentes (para usuarios)

| Síntoma | Probable causa | Acción |
|---|---|---|
| `error.code = "NOT_IN_WORKSPACE"` | Estás en un directorio sin bloque `<NS>-PROJECT`, o el namespace activo apunta a otro lado | `agent-workflow self namespace` para ver el resuelto. Si necesitás otro namespace: `--namespace <name>` o setear `~/.config/agent-workflow/namespace`. |
| El hook bloquea mi edit | La rama actual no matchea la rama declarada en la sesión | `agent-workflow check-branch --source <alias>` para ver mismatch. Hacer checkout o re-declarar la rama. |
| Las sesiones de la versión vieja no aparecen | Estaban en `.claude/` o `.codex/` (legacy) y no se migraron | `agent-workflow sessions --include-legacy` o ejecutar el migrador del plugin downstream si aplica. |
| El skill no aparece en el cliente AI | No se instaló o la versión está vieja | `agent-workflow self install-skill --force` |

## 10. Referencias

- API completa del CLI: `SKILL.md` + `references/<familia>.md`.
- Manual técnico (mantenimiento + extensión): `MANUAL-TECNICO.md`.
- Test plan: `docs/TEST-PLAN.md`.
- Repo CLI: github.com/Tacuchi/agent-workflow-cli (la skill vive bundled adentro del tarball; ya no hay repo standalone).
