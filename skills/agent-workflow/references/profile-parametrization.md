# Profile parametrization — guía para los 10 skills sensibles a empresa

Este documento centraliza qué campos de `profile.json` (resuelto por `src/application/profile/profile-service.ts`) drivean el comportamiento de cada skill parametrizado.

Profile cascade (de mayor a menor precedencia):
1. Flag `--profile <path>`
2. Env `AW_PROFILE`
3. `~/.config/agent-workflow/profile.json` (XDG-ish, user-level)
4. `<cwd>/.<namespace>/profile.json` (workspace-level)
5. `DEFAULT_PROFILE` embebido (todos los campos en valores agnósticos)

Schema completo en `src/application/profile/profile-service.ts:Profile`.

## Skills parametrizados (10)

### 5 antes-QTC (D4 ampliado — session082)

#### 1. `doctrine/project-init/`
- **Campo**: `profile.claude_md_block` (default `AW-PROJECT`; QTC profile: `QTC-PROJECT`).
- **Behavior**: el bloque insertado en `CLAUDE.md`/`AGENTS.md` lleva el marker `<!-- <claude_md_block>-START -->` / `<!-- <claude_md_block>-END -->`.
- **Detección legacy**: `<!-- QTC-WORKFLOW-START -->` (pre-v0.8) se detecta sin importar el profile; si presente, recomendar `/agent-workflow:migrate`.

#### 2. `doctrine/hub-init/`
- Idem `project-init` para el marker del bloque hub.
- Adicional: detección de "modo hub vs project" sigue siendo agnóstica.

#### 3. `doctrine/doctor/`
- **Campo**: `profile.mcp_databases[]`.
- **Behavior**: la sección "MCP connectivity check" itera sobre `profile.mcp_databases[]`. Si el array está vacío, la sección se omite ("no MCP configured, skip BD section").

#### 4. `doctrine/migrate/`
- **Campo**: `profile.migrate_legacy_rules[]`.
- **Behavior**: la lista de reglas legacy → moderno se carga del profile. Profile QTC trae ~10 reglas (`.claude/sessions/` → `.workflow/sessions/`, ES headers → EN, `QTC-WORKFLOW` → `claude_md_block`, etc.). Profile vacío → migrate es no-op.
- **Reglas hard-coded en el skill**: cero. Lo que migre depende 100% del profile.

#### 5. `doctrine/rules/`
- **Campo**: `profile.custom_anchors[]`.
- **Behavior**: el bundle de anchors universales (`agent-workflow:commits-policy`, `agent-workflow:sandbox-readonly`, etc.) se renderiza siempre. Los anchors del profile se agregan al final del bundle bajo "## Anchors específicos del profile". Profile QTC inyecta `qtc:mcp-readonly` (legacy alias) automáticamente si `profile.mcp_databases[]` no está vacío.

### 5 ambiguos (parametrizados por contexto)

#### 6. `specialties/analyze-investigate/`
- **Campo**: `profile.mcp_databases[]`.
- **Behavior**: la fase "BD investigation" enumera las MCPs disponibles desde el profile. Si vacío, advierte "no MCP configured, skip BD section" y prosigue con read-only de código.

#### 7. `standards/coding-standards/`
- **Campo**: `profile.mcp_databases[]` (sección BD) + `profile.examples_path` (ejemplos override).
- **Behavior**: sección "BD vía MCP" se renderiza dinámicamente desde el profile. Las secciones Angular/Spring/Node + FE-BE R1-R6 son agnósticas; profile.examples_path permite override de ejemplos para empresas que no usan Angular/Spring.

#### 8. `exports/export-arq/`
- **Campo**: `profile.mcp_databases[]` (paso 4 BD esquemas).
- **Behavior**: el paso "Resolución BD" extrae esquemas iterando sobre `profile.mcp_databases[]`. C4 model conceptual es agnóstico.

#### 9. `exports/export-report/`
- **Campo**: `profile.lexicon_path` (default `null` = sin lexicon).
- **Behavior**: si `profile.lexicon_path` apunta a un archivo, se carga como léxico empresa-específico y se aplica a la prosa del export. Profile QTC apunta a su archivo de léxico; profile vacío → no se aplica léxico.

#### 10. `specialties/refactor/`
- **Campo**: `profile.examples_path` (override de ejemplos Strangler Fig).
- **Behavior**: la doctrina (Strangler Fig + 4 fases) es agnóstica. Los ejemplos en cada fase se cargan desde `profile.examples_path` si está definido. Profile QTC carga ejemplos QTC; profile vacío → ejemplos genéricos.

## Hook adicional

#### `hooks/hooks.template.json` — `sql-mutation-guard` matcher
- **Campo**: `profile.mcp_databases[]`.
- **Behavior**: el matcher `mcp__<db>__execute_sql` se compila dinámicamente desde el profile. Sin profile → matcher disabled, hook no se registra (skip silencioso).

## Cómo cargar el profile en un skill (para devs)

Patrón canónico en TypeScript:

```typescript
import { resolveProfile } from "../../application/profile/profile-service.js";

const resolved = await resolveProfile(fs, env, { flagPath: args.values.get("profile") });
if ("code" in resolved) {
  // PROFILE_NOT_FOUND / PROFILE_INVALID_JSON / PROFILE_INVALID_SCHEMA
  return errorResult(resolved);
}
const { profile, source, path } = resolved;
// Use profile.mcp_databases, profile.claude_md_block, etc.
```

Para skills en markdown (sin código), referenciar este documento en el frontmatter o en una sección "## Profile parametrization" del SKILL.md específico.

## Anchors legacy

Los anchors `qtc:<topic>` se mantienen como alias permanentes en `references/legacy-anchors.md` para que CLAUDE.md históricos no rompan. Anchor canónico nuevo: `agent-workflow:<topic>`.
