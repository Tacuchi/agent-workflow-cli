---
name: harness
description: >-
  Harness-agnostic capability layer for agent-workflow. Read-and-follow doc (no es
  invocable por nombre): define el contrato que mantiene a la herramienta agnóstica al
  arnés (Claude Code, Codex, opencode, Gemini CLI, genérico) sin renunciar a las
  capacidades ricas de cada uno. Cataloga las capacidades de las que depende el
  workflow, las liga al mecanismo concreto de cada arnés (binding matrix), y fija los
  dos principios (capacidad-no-tool · progressive-enhancement). Referenciado desde
  SKILL.md (overview) y los loops cuando nombran structured-choice / compaction.
---

# harness — capa de capacidades agnóstica al arnés (cross-cutting)

Doc de **lectura y seguimiento** (no se invoca por nombre). Aquí vive el contrato que mantiene a agent-workflow **agnóstico al arnés** (Claude Code, Codex, opencode, Gemini CLI, …) sin renunciar a las capacidades ricas de cada uno. Referenciado desde `../SKILL.md` (overview) y desde los loops cuando nombran una capacidad (`structured-choice`, `compaction`, …).

## El problema

La doctrina (comandos + loops + artefactos) describe **qué** hace la IA, no **con qué tool** de un arnés concreto. El vocabulario natural arrastra mecanismos específicos de Claude Code —`AskUserQuestion`, `/compact`, `$ARGUMENTS`, `Task`/`Agent`— como si fueran universales. Este documento los abstrae: la doctrina referencia **capacidades**; aquí se mapea cada capacidad al **mecanismo concreto** de cada arnés.

## Dos principios

1. **Capacidad, no tool.** Los loops/comandos nombran una **capacidad** abstracta (ej. *structured-choice*, *compaction*). Una sola tabla —esta— la liga al mecanismo de cada arnés. Cambiar de arnés = cambiar de columna, no de doctrina.
2. **Progressive enhancement.** Usá el mecanismo **más rico** que ofrezca el arnés; **degradá** a un fallback universal cuando no exista. Así se cumple a la vez "agnóstica al arnés" **y** "aprovechar las capacidades de cada uno".

> **Simetría con la cascada de skills (`.workflow/skills.toml`):** esa categoría liga **roles → skills** por config; esta liga **capacidades → mecanismos del arnés** por detección. Mismo patrón (binding + default), distinto eje: una es *qué saber compone el loop*, la otra es *con qué primitivas del host se ejecuta*.

## Capability catalog

Las capacidades de las que depende el harness, con su fallback universal (lo que se usa si el arnés no ofrece algo mejor):

| Capability | Qué necesita el workflow | Fallback universal (mínimo común) |
|---|---|---|
| **command-invocation** | el usuario dispara un flujo por nombre (`spec-new`, `plan-exec`, …) | el usuario escribe "corré el procedimiento `<cmd>`" y la IA lee su doc |
| **procedure-loading** | cargar la doctrina de un loop/comando | la IA **lee el `.md`** del loop y lo sigue (read-and-follow) |
| **structured-choice** | preguntar al humano ≤3 preguntas de contenido **+ siempre** un control `flow` (`Compactar`/`Cerrar`) por un canal lateral | pregunta en **markdown numerado** en el chat; el control `flow` se ofrece como una opción más |
| **compaction** | encoger el contexto sin perder el hilo | escribir `CHECKPOINT` y pedir al usuario reiniciar el contexto y reanudar (resume keya off `CHECKPOINT`) |
| **subagent-dispatch** | *(opcional)* paralelizar breadth de research | research **inline secuencial** en la misma session (es el default igual) |
| **persistent-context** | bloque `WORKSPACE` + convenciones siempre presentes | archivo de contexto del repo (**`AGENTS.md`** estándar; `CLAUDE.md` en Claude Code) |
| **external-data** | lecturas read-only de BD u otras fuentes para research/validación | **MCP** (ampliamente soportado); si no hay, el gap se degrada a pregunta-al-humano |
| **dry-run / preview** | previsualizar lo que haría un comando sin escribir | el comando **describe** el cambio en vez de aplicarlo (ej. `spec-new` lista el borrador sin crear el archivo) |

> **Las capacidades `must` para el ciclo de un loop son solo dos**: `structured-choice` y `compaction`. Ambas degradan a un fallback puramente textual → **cualquier** arnés con chat + sistema de archivos corre el modelo completo. El resto (subagents, MCP, slash commands, skills nativas) es *enhancement*.

## Harness binding matrix

Mecanismo concreto por arnés (jun-2026; `~` parcial · `?` sin confirmar).

| Capability | Claude Code | Codex CLI | opencode | Gemini CLI | Genérico |
|---|---|---|---|---|---|
| command-invocation | `.claude/commands/` (slash) | skills (prompts custom **deprecados**) | `.opencode/commands/` | `.gemini/commands/*.toml` | texto |
| procedure-loading | skills `SKILL.md` | skills `SKILL.md` | skills `SKILL.md` | skills (extensiones) | read-and-follow `.md` |
| structured-choice | `AskUserQuestion` (**solo main-agent**) | — | — | — | markdown numerado |
| compaction | `/compact` | `?` | `?` | `?` | CHECKPOINT + resume |
| subagent-dispatch | `Task` (paralelo) | agents (depth=1) | Explore/Scout | agents | inline |
| persistent-context | `CLAUDE.md` (**no** lee AGENTS.md → symlink) | `AGENTS.md` | `AGENTS.md` | `AGENTS.md`/`GEMINI.md` | `AGENTS.md` |
| external-data | MCP | MCP | MCP | MCP | — |
| dry-run / plan | plan mode (enforced) | `/plan` (prompt, **no** enforced) | Plan agent | plan mode | describir sin escribir |

> **Notas (investigación de campo jun-2026):** las **skills `SKILL.md`** son la unidad portable **universal** (las cinco las soportan; Codex deprecó los prompts custom) → la doctrina se empaqueta como skill. La **elección estructurada** (`AskUserQuestion`) es **solo de Claude Code y solo del main-agent** → en el resto, `structured-choice` degrada a markdown numerado. El **plan mode** está *enforced* solo en Claude Code/opencode (prompt-level en Codex) → **no se confía para safety**; el git-safe (invariante #5) es propio. **MCP** es universal. El **piso garantizado** (última columna) corre el modelo completo.

## Leverage installed skills

"Aprovechar las skills que el arnés tenga instaladas" se resuelve por el **mismo binding** de `.workflow/skills.toml`: un rol puede apuntar a una skill **instalada en el host** (de tercero, vía skills.sh) en vez del built-in. Regla:

- Si el host tiene una skill **mejor** para un rol (ej. un generador de diagramas superior para `diagrams`, o un investigador especializado para `research`), se la **bindea** en `.workflow/skills.toml` y el loop la compone sin cambios.
- El built-in default es el **piso**, no el techo: garantiza que el rol funcione en cualquier host; el binding lo **enriquece** donde el host puede más.

## Convención para el resto del corpus

- Los loops/comandos referencian la **capacidad** por nombre (ej. "*structured-choice* (ver `harness/SKILL.md`)"), **no** el tool concreto.
- El nombre histórico `AskUserQuestion` se conserva **solo** como el binding Claude-Code de `structured-choice` (esta tabla), no como vocabulario de la doctrina.
- El control de ciclo de vida `flow` (`Compactar`/`Cerrar`) es parte de la capacidad `structured-choice`, no de un tool: en arneses sin elección estructurada se ofrece como una opción textual más.

## Distribution (install-time)

Patrón probado (Spec Kit, 30+ agentes): **una fuente canónica** + generar/symlinkear a los dirs por-arnés en la instalación (`.claude/`, `.codex/`, `.gemini/`, …). agent-workflow ya lo hace vía `aw self install-skill`. Convención recomendada: **`AGENTS.md` canónico + `CLAUDE.md` symlink** (Claude Code no lee `AGENTS.md` nativo; el resto sí).

## Command packaging (harness-specific)

El **contrato** de cada comando (Flow, Trigger, Input, Mode, …) es agnóstico. El **archivo** que el arnés ejecuta envuelve ese contrato en su formato nativo: Claude Code = slash-command con frontmatter (`description`, `argument-hint`, `allowed-tools`) + cuerpo que invoca la skill o el `aw` CLI; Codex = skill (los prompts custom en `~/.codex/prompts/` están deprecados); otros, su equivalente. El contrato no cambia; el envoltorio sí (otra columna). El comportamiento en *dry-run / plan mode* (previsualizar sin escribir) se documenta en el cuerpo del comando cuando aplica.

## Status

Modelo de capacidades + matriz de binding **definidos** y **validados** con investigación de campo (jun-2026). El piso universal (`AGENTS.md` + texto + archivos + skills) corre el modelo completo hoy.
