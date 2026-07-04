---
name: harness
description: >-
  Harness-agnostic capability layer for agent-workflow. Read-and-follow doc (not
  invocable by name): defines the contract that keeps the tool harness-agnostic
  (Claude Code, Codex, Gemini/Antigravity, OpenCode, Crush, Warp/Oz, generic) without
  giving up each harness's rich capabilities. Catalogs the capabilities the workflow
  depends on, binds each to the concrete mechanism of every harness (binding matrix),
  and fixes the two principles (capability-not-tool · progressive-enhancement).
  Referenced from SKILL.md (overview) and the loops when they name structured-choice /
  compaction.
---

# harness — harness-agnostic capability layer (cross-cutting)

**Read-and-follow** doc (never invoked by name). Here lives the contract that keeps agent-workflow **harness-agnostic** (Claude Code, Codex, opencode, Gemini CLI, …) without giving up each harness's rich capabilities. Referenced from `../SKILL.md` (overview) and from the loops when they name a capability (`structured-choice`, `compaction`, …).

## The problem

The doctrine (commands + loops + artifacts) describes **what** the AI does, never **with which tool** of a concrete harness. Natural vocabulary drags in Claude-Code-specific mechanisms — `AskUserQuestion`, `/compact`, `$ARGUMENTS`, `Task`/`Agent` — as if they were universal. This document abstracts them: the doctrine references **capabilities**; here each capability maps to each harness's **concrete mechanism**.

## Two principles

1. **Capability, not tool.** Loops/commands name an abstract **capability** (e.g. *structured-choice*, *compaction*). A single table — this one — binds it to each harness's mechanism. Switching harness = switching column, never doctrine.
2. **Progressive enhancement.** Use the **richest** mechanism the harness offers; **degrade** to a universal fallback when it does not exist. That satisfies both "harness-agnostic" **and** "leverage each harness".

> **Symmetry with the skills cascade (`.workflow/skills.toml`):** that category binds **roles → skills** by config; this one binds **capabilities → harness mechanisms** by detection. Same pattern (binding + default), different axis: one is *what knowledge the loop composes*, the other is *which host primitives execute it*.

## Capability catalog

The capabilities the harness layer depends on, with their universal fallback (what is used when the harness offers nothing better):

| Capability | What the workflow needs | Universal fallback (lowest common) |
|---|---|---|
| **command-invocation** | the user triggers a flow by name (`spec-new`, `plan-exec`, …) | the user writes "run the `<cmd>` procedure" and the AI reads its doc |
| **procedure-loading** | load a loop's/command's doctrine | the AI **reads the `.md`** of the loop and follows it (read-and-follow) |
| **structured-choice** | ask the human ≤3 content questions **+ always** a `flow` control (`Compactar`/`Cerrar`) through a side channel | a **numbered markdown** question in chat; the `flow` control is offered as one more option |
| **compaction** | shrink the context without losing the thread | write `CHECKPOINT` and ask the user to restart the context and resume (resume keys off `CHECKPOINT`) |
| **subagent-dispatch** | *(optional)* parallelize research breadth | **inline sequential** research in the same session (the default anyway) |
| **persistent-context** | the `WORKSPACE` block + conventions always present | the repo's context file (standard **`AGENTS.md`**; `CLAUDE.md` on Claude Code) |
| **external-data** | read-only DB reads or other sources for research/validation | **MCP** (widely supported); without it, the gap degrades to a human question |
| **dry-run / preview** | preview what a command would do without writing | the command **describes** the change instead of applying it (e.g. `spec-new` lists the draft without creating the file) |

> **Only two capabilities are `must` for a loop's cycle**: `structured-choice` and `compaction`. Both degrade to a purely textual fallback → **any** harness with chat + a filesystem runs the full model. The rest (subagents, MCP, slash commands, native skills) is *enhancement*.

## Harness binding matrix

Concrete mechanism per harness (**Jul-2026**, verified against official docs; `~` partial). Antigravity CLI reuses Gemini's surfaces (`~/.gemini/`); Oz reuses Warp's (they share the **Warp / Oz** column, with MCP via flag — see the note under the matrix).

| Capability | Claude Code | Codex | Gemini / Antigravity | OpenCode | Crush | Warp / Oz | Generic |
|---|---|---|---|---|---|---|---|
| command-invocation | `.claude/commands/` (slash) | skills only (`$` mention; no commands dir, prompts removed) | skills only in agy (system slash commands; `.gemini/commands/*.toml` = legacy Gemini CLI) | `.opencode/command/` | `.crush/commands` (palette) + user-invocable skills | skills as `/name` | text |
| procedure-loading (skills) | `SKILL.md` `.claude/skills` | `SKILL.md` `.agents/skills` | `SKILL.md` (agentskills) | `SKILL.md` `.opencode`+`.claude`+`.agents` | `SKILL.md` `.agents`+`.crush`+`.claude` | `SKILL.md` `.agents`+`.warp`+`.claude` | read-and-follow `.md` |
| structured-choice | `AskUserQuestion` (**main-agent only**) | — | — | — | — | — | numbered markdown |
| compaction | `/compact` | Pre/PostCompact hooks | ~ | `session.compacted` | ~ | ~ | CHECKPOINT + resume |
| subagent-dispatch | `Task` (parallel) | `SubagentStart` / agents | agents (`.gemini/agents`) | `.opencode/agent/*.md` | ~ | ~ (cloud agents) | inline |
| persistent-context | `CLAUDE.md` (does **not** read AGENTS.md → symlink) | `AGENTS.md` | `GEMINI.md` + `AGENTS.md` | `AGENTS.md` | `CRUSH.md` + `AGENTS.md` | `AGENTS.md` (auto) | `AGENTS.md` |
| external-data (MCP) | `.mcp.json` | `.codex/config.toml` `[mcp_servers]` | `settings.json` `mcpServers` | `opencode.json` `mcp` | `crush.json` `mcp` | `.warp/.mcp.json` (+auto-discovers `.mcp.json`) · Oz: `--mcp` flag | — |
| **enforcement (deny tool)** | `PreToolUse` → `permissionDecision:deny` / exit 2 | `PreToolUse` (**≈same protocol**) | `BeforeTool` → `decision:deny` / exit 2 | plugin `tool.execute.before` (`throw`) | `allowed_tools` (+ preliminary hooks) | allow/deny lists (**coarse**) | doctrine (git-safe #5) |
| plugin / dist | `.claude-plugin` + marketplace | `.codex-plugin` + `/plugins` marketplace | Extension `gemini-extension.json` | JS/TS plugin (npm) | MCP + skills + config | Warp Drive | — |

> **Notes (field research Jul-2026):** **`SKILL.md` skills** are the **universal** portable unit — **all six** harnesses support them (Codex added them Dec-2025; **`.agents/skills` is the cross-host anchor**, read by Codex/OpenCode/Crush/Warp). **Structured choice** (`AskUserQuestion`) remains **Claude Code / main-agent only** → elsewhere `structured-choice` degrades to numbered markdown. The **enforcement layer** (new row) is **NO longer Claude-exclusive**: Codex + Gemini use a near-identical protocol (`permissionDecision:deny` / exit 2) and OpenCode blocks via `throw` in a JS plugin; Crush/Warp only offer **coarse** allow/deny (no custom per-command logic) → there, conventions stay **advisory** + allow/deny lists. Enforced **plan mode** is never trusted for safety; git-safe (invariant #5) is our own. **MCP** is universal (each host its file/key). The **guaranteed floor** (last column) runs the full model.

> **Oz (Warp's cloud sibling).** `oz agent run` is a cloud agent orchestrator that **reuses Warp's surfaces**: same skills (`.agents/skills`, top-level dirs like Warp) and `AGENTS.md`, with `structured-choice` equally degraded to numbered markdown. It differs in three points: **detection** via `OZ_RUN_ID` (takes priority over Warp when both markers coexist); **MCP without a config file** — the JSON is passed via the `--mcp` flag of `oz agent run` (or the `OZ_MCP_CONFIG` env), it never writes `.warp/.mcp.json`; and **no plugin or hooks** (advisory enforcement, like Warp). Hence it shares the **Warp / Oz** column with that MCP caveat.

## Leverage installed skills

"Leverage whatever skills the harness has installed" resolves through the **same** `.workflow/skills.toml` binding: a role can point at a skill **installed on the host** (third-party, via skills.sh) instead of the built-in. Rule:

- If the host has a **better** skill for a role (e.g. a superior diagram generator for `diagrams`, or a specialized investigator for `research`), **bind it** in `.workflow/skills.toml` and the loop composes it unchanged.
- The built-in default is the **floor**, not the ceiling: it guarantees the role works on any host; the binding **enriches** it where the host can do more.

## Convention for the rest of the corpus

- Loops/commands reference the **capability** by name (e.g. "*structured-choice* (see `harness/HARNESS.md`)"), **never** the concrete tool.
- The historical name `AskUserQuestion` survives **only** as the Claude-Code binding of `structured-choice` (this table), never as doctrine vocabulary.
- The `flow` lifecycle control (`Compactar`/`Cerrar`) belongs to the `structured-choice` capability, not to a tool: on harnesses without structured choice it is offered as one more textual option.

## Distribution (install-time)

Proven pattern (Spec Kit, 30+ agents): **one canonical source** + generate/symlink into the per-harness dirs at install (`.claude/`, `.codex/`, `.gemini/`, …). agent-workflow already does this via `aw self install-skill`. Recommended convention: **canonical `AGENTS.md` + `CLAUDE.md` symlink** (Claude Code does not read `AGENTS.md` natively; the rest do).

## Command packaging (harness-specific)

Each command's **contract** (Flow, Trigger, Input, Mode, …) is agnostic. The **file** the harness executes wraps that contract in its native format — the installer (`aw self install-skill`) emits the right wrapper per host:

| Host | Wrapper installed | Invoked as |
|---|---|---|
| Claude Code | `~/.claude/commands/w/<cmd>.md` (frontmatter `description`/`argument-hint`/`allowed-tools`) | `/w:<cmd>` |
| Codex | synthesized skill `~/.codex/skills/w-<cmd>/SKILL.md` (Codex reads no commands dir; custom prompts deprecated/removed since 0.14x) | `$w-<cmd>` mention |
| Gemini/Antigravity | synthesized skill `~/.gemini/skills/w-<cmd>/SKILL.md` (agy reads NO commands dir — slash commands are system-only; verified vs agy 1.0.16 binary) + `~/.gemini/commands/w/<cmd>.toml` kept for legacy Gemini CLI | skill (agy) · `/w:<cmd>` (legacy CLI) |
| OpenCode | `~/.opencode/command/w/<cmd>.md` | `/w/<cmd>` |
| Crush | `~/.crush/commands/w/<cmd>.md` (plain body — Crush parses no frontmatter) | palette `user:w:<cmd>` |
| Warp/Oz | synthesized skill `w-<cmd>/SKILL.md` next to the bundle (Warp lists skills as `/name`) | `/w-<cmd>` |

*Skill-as-command* (a synthesized `w-<cmd>` skill whose body is the command, with bundle references rewritten to `../w/…`) is the **universal fallback** for any host without a native commands surface. The loop/role/export manuals are deliberately **not** `SKILL.md` files (`LOOP.md`/`ROLE.md`/`EXPORT.md`/`HARNESS.md`): hosts that scan skill roots **recursively** (Codex ≤6 levels; OpenCode and Crush — which also cross-read `~/.claude/skills` and `~/.agents/skills`) must never index the internals as invocable skills. The contract never changes; the wrapper does (another column).

## Status

Capability model + binding matrix **defined** and **validated** with field research (**Jul-2026**, against official docs). Coverage: **6 real harnesses** (families; Warp/Oz counts as one, like Gemini/Antigravity): Claude Code, Codex, Gemini/Antigravity, OpenCode, Crush, Warp/Oz — all support `SKILL.md` (anchor `.agents/skills`) + MCP + `AGENTS.md`; deterministic enforcement on Claude/Codex/Gemini/OpenCode, advisory + coarse allow/deny on Crush/Warp/Oz. The CLI (`aw`) implements the registry (`domain/harnesses.ts`), the per-host MCP writers, `detect-hosts` and `install-skill --target <host>`. The universal floor (`AGENTS.md` + text + files + skills) runs the full model today.
