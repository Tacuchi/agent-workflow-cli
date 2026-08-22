---
name: harness
description: >-
  Harness-agnostic capability layer for Workline. Read-and-follow doc (not
  invocable by name): defines the contract that keeps the tool harness-agnostic
  (Claude Code, Codex, Gemini/Antigravity, OpenCode, Crush, Warp/Oz, generic) without
  giving up each harness's rich capabilities. Catalogs the capabilities Workline
  depends on, binds each to the concrete mechanism of every harness (binding matrix),
  and fixes the two principles (capability-not-tool · progressive-enhancement).
  Referenced from SKILL.md (overview) and the loops when they name structured-choice /
  compaction.
---

# harness — harness-agnostic capability layer (cross-cutting)

**Read-and-follow** doc (never invoked by name). Here lives the contract that keeps Workline **harness-agnostic** (Claude Code, Codex, opencode, Gemini CLI, …) without giving up each harness's rich capabilities. Referenced from `../SKILL.md` (overview) and from the loops when they name a capability (`structured-choice`, `compaction`, …).

## The problem

The doctrine (commands + loops + artifacts) describes **what** the AI does, never **with which tool** of a concrete harness. Natural vocabulary drags in Claude-Code-specific mechanisms — `AskUserQuestion`, `/compact`, `$ARGUMENTS`, `Task`/`Agent` — as if they were universal. This document abstracts them: the doctrine references **capabilities**; here each capability maps to each harness's **concrete mechanism**.

## Two principles

1. **Capability, not tool.** Loops/commands name an abstract **capability** (e.g. *structured-choice*, *compaction*). A single table — this one — binds it to each harness's mechanism. Switching harness = switching column, never doctrine.
2. **Progressive enhancement.** Use the **richest** mechanism the harness offers; **degrade** to a universal fallback when it does not exist. That satisfies both "harness-agnostic" **and** "leverage each harness".

> **Symmetry with the skills cascade (`.workflow/skills.toml`):** that category binds **roles → skills** by config; this one binds **capabilities → harness mechanisms** by detection. Same pattern (binding + default), different axis: one is *what knowledge the loop composes*, the other is *which host primitives execute it*.

## Capability catalog

The capabilities the harness layer depends on, with their universal fallback (what is used when the harness offers nothing better):

| Capability | What Workline needs | Universal fallback (lowest common) |
|---|---|---|
| **command-invocation** | the user triggers a flow by name (`spec-new`, `plan-exec`, …) | the user writes "run the `<cmd>` procedure" and the AI reads its doc |
| **procedure-loading** | load a loop's/command's doctrine | the AI **reads the `.md`** of the loop and follows it (read-and-follow) |
| **structured-choice** | ask the human ≤3 content questions **+ always** a `flow` control (`Compactar`/`Cerrar`); every option has a semantic label + one-sentence functional explanation/example | **labeled markdown** in chat; answer by label or ratify all first options with `Aceptar recomendaciones` |
| **compaction** | shrink the context without losing the thread (+ a context-pressure **signal** for the chassis' self-regulation) | write `CHECKPOINT` and ask the user to restart the context and resume (resume keys off `CHECKPOINT`) |
| **subagent-dispatch** | *(optional)* parallelize research breadth | **inline sequential** research in the same session (the default anyway) |
| **persistent-context** | the `WORKSPACE` block + conventions always present | the repo's context file (standard **`AGENTS.md`**; `CLAUDE.md` on Claude Code) |
| **host-memory** | *(optional)* recover state/pending work from the host's accessible history — a **second source** after the workline signals | recent **git** / **`docs/`** signals + (in `/resume`) **ask the user**; plus Workline's own `.workflow/CHECKPOINT` via `aw resume-summary` |
| **web-research** | *(optional)* search/fetch external online evidence inside a consented ideation round (spec-refine § *Ideation gate*) | **offline ideation** (own knowledge + workspace + repos) — the loop **declares** the web was unavailable |
| **external-data** | read-only DB reads or other sources for research/validation | **MCP** (widely supported); without it, the gap degrades to a human question |
| **dry-run / preview** | preview what a command would do without writing | the command **describes** the change instead of applying it (e.g. `spec-new` lists the draft without creating the file) |

> **Only two capabilities are `must` for a loop's cycle**: `structured-choice` and `compaction`. Both degrade to a purely textual fallback → **any** harness with chat + a filesystem runs the full model. The rest (subagents, MCP, slash commands, native skills) is *enhancement*.

## Resource authority — the CLI spends, the host supplies

The host advertises primitives; the CLI owns whether their cost is justified.
`aw harness` reports **`agent_host`** and **`terminal_host`** separately, so Codex
inside Warp is not mistaken for Warp. A host-specific installed wrapper binds its
own target explicitly; environment detection is the fallback, while a shared
`.agents/skills` wrapper stays unbound because several hosts can read it.

- A deterministic tranche dispatches **zero** model workers, subagents and
  external processes. `aw flow advance` exhausts it locally until the first
  semantic, human, authorization, execution, blocked or final frontier.
- A semantic tranche is inline by default. It may use subagents only for three
  or more independent partitions with no dependency and no overlapping writes;
  then the CLI caps them at **3** (at most **4** model workers including the
  coordinator). Human and authorization frontiers never fan out.
- An execution frontier has one external invocation at a time and returns its
  actual evidence; it is not a request to run more agents.
- Token usage is recorded only when the host supplies a real count. Bytes,
  context size and estimates are never relabeled as tokens.

This lets a capable host contribute parallel analysis when it is cheaper than
coordination, without turning a deterministic CLI rule into model work.

## Harness binding matrix

Concrete mechanism per harness (matrix base verified **Jul-2026**; the `structured-choice` row re-verified **2026-08-22**, the Codex `hooks` row **2026-08-05** and the crush/gemini/opencode `hooks` contract **2026-08-18**, all against the INSTALLED runtimes plus real runs — not docs; `~` partial). Antigravity CLI reuses Gemini's surfaces (`~/.gemini/`); Oz reuses Warp's (they share the **Warp / Oz** column, with MCP via flag — see the note under the matrix).

| Capability | Claude Code | Codex | Kimi Code | Gemini / Antigravity | OpenCode | Crush | Warp / Oz | Generic |
|---|---|---|---|---|---|---|---|---|
| command-invocation | `.claude/commands/` (slash) | skills only (`$` mention; no commands dir, prompts removed) | skills only, as `/skill:<name>` (no commands dir) | skills only in agy (system slash commands; `.gemini/commands/*.toml` = legacy Gemini CLI) | `.opencode/command/` | `.crush/commands` (palette) + user-invocable skills | skills as `/name` | text |
| procedure-loading (skills) | `SKILL.md` `.claude/skills` | `SKILL.md` `.agents/skills` | `SKILL.md` `.kimi-code/skills`+`.agents/skills` (user and project tiers) | `SKILL.md` (agentskills) | `SKILL.md` `.opencode`+`.claude`+`.agents` | `SKILL.md` `~/.config/crush`+`.agents`+`.claude` (`.crush/skills` is project-only) | `SKILL.md` `.agents`+`.warp`+`.claude` | read-and-follow `.md` |
| structured-choice | `AskUserQuestion` (**main-agent only**; 1–4 questions, 2–4 options; label + description; free-text always offered) | `request_user_input` gated **per turn** (~): the TUI ships its selection overlay, but Default mode does not list the tool and `codex exec` never supports it; the `default_mode_request_user_input` opt-in does **not** add it (probed), so only a TUI mode switch (`/plan`, `/pair`) does → use it when the turn lists it, else labeled markdown | `AskUserQuestion` (1–4 questions, 2–4 options; label + description; free-text offered) — **not called in `auto`/non-interactive mode** by the host's own rule → labeled markdown | `AskQuestion` (Antigravity/`agy`, the live binary: option `text` only, **no description field** → `Label — sentence`; write-in; no ceiling declared). `ask_user` is the retired Gemini CLI's and is **absent** from `agy` | `question` (label + description as separate fields; `custom` free-text on by default; no ceiling declared) — **denied in a non-interactive run** → labeled markdown | `question` (≤5 questions, ≤5 choices; description required per question <300 chars and **per choice <100 chars**; automatic fill-in) | no structured-choice surface → labeled markdown | labeled markdown (label + sentence) |
| compaction | `/compact` | Pre/PostCompact hooks | `/compact` + Pre/PostCompact hooks | ~ | `session.compacted` | ~ | ~ | CHECKPOINT + resume |
| subagent-dispatch | `Task` (parallel) | `agents` | `SubagentStart` | agents (`.gemini/agents`) | `.opencode/agent/*.md` | inline | inline (Oz cloud orchestration is not a direct worker binding) | inline |
| persistent-context | `CLAUDE.md` (does **not** read AGENTS.md → symlink) | `AGENTS.md` | `AGENTS.md` (hierarchical) | `GEMINI.md` + `AGENTS.md` | `AGENTS.md` | `CRUSH.md` + `AGENTS.md` | `AGENTS.md` (auto) | `AGENTS.md` |
| **host-memory** | `MEMORY.md` (cheap) + transcripts/`--resume` (deep) | `AGENTS.md` (static → fallback) | sessions with resume/fork (`kimi -S`) + `AGENTS.md` | `GEMINI.md`+`AGENTS.md` (static → fallback) | `AGENTS.md` (static → fallback) | `CRUSH.md`+`AGENTS.md` (static → fallback) | rules / history (~) | git/`docs/` + ask |
| **web-research** | `WebSearch` / `WebFetch` | `web_search` (opt-in config) | moonshot search + fetch services | `google_web_search` + `web_fetch` | `webfetch` (~) | ~ | ~ (agent web access) | — (offline + declare) |
| external-data (MCP) | `.mcp.json` | `.codex/config.toml` `[mcp_servers]` | `~/.kimi-code/mcp.json` `mcpServers` (also reads project `.mcp.json`) | `settings.json` `mcpServers` | `opencode.json` `mcp` | `crush.json` `mcp` | `.warp/.mcp.json` (+auto-discovers `.mcp.json`) · Oz: `--mcp` flag | — |
| **enforcement (deny tool)** | `PreToolUse` → `permissionDecision:deny` / exit 2 | `PreToolUse` (**≈same protocol**) | `PreToolUse` → block / exit 2 | `PreToolUse` in its `hooks.json` (Claude-shaped; `BeforeTool` **does not exist**) | plugin `tool.execute.before` (`throw`) | `PreToolUse` in `crush.json` → `hooks` (+ `allowed_tools` allowlist) | allow/deny lists (**coarse**) | doctrine (git-safe #5) |
| plugin / dist | `.claude-plugin` + marketplace | `.codex-plugin` + `/plugins` marketplace | plugins + marketplace (no manifest we ship) | Extension `gemini-extension.json` | JS/TS plugin (npm) | MCP + skills + config | Warp Drive | — |

> **Kimi Code caveats** (verified 2026-07-29 vs the shipped v0.29.2 binary + live probes): it exports **no env markers** to its subprocesses, so `aw harness` legitimately answers `unknown` inside it and detection goes through binary + config dir. Its hooks live **only** in the user-global `config.toml` — there is no project-level config — and their schema is `event`/`matcher`/`command`/`timeout`, so the bundled JSON template is *transformed*, not copied: `type: "prompt"` hooks cannot be expressed and are reported as skipped, and matchers are carried only for the tool-name events.

> **Codex hooks caveats** (verified **2026-08-05** vs codex-cli 0.146.0 + real runs). Its user-level hooks are **not** in `config.toml`: they live in **`~/.codex/hooks.json`** with the **same JSON shape as Claude's** — `{"hooks": {"<Event>": [{"matcher": …, "hooks": [{"type": "command", "command": …, "timeout": N}]}]}}`. The event enum (`HookEventsToml`) is `PreToolUse` · `PermissionRequest` · `PostToolUse` · `PreCompact` · `PostCompact` · `SessionStart` · `SessionEnd` · `UserPromptSubmit` · `SubagentStart` · `SubagentStop` · `Stop`, so **all 5 events of the bundled template fit**, and its handlers admit `command`, **`prompt`** and `agent` — the `type: "prompt"` hook kimi cannot express, codex can. One observed limit: `SessionEnd` clamps its timeout to **3 s**.
>
> **But writing that file does not arm it, and that is why Workline does not manage hooks here.** Codex requires an **interactive human review per new or changed hook** (`New hook - review required`, `Modified since last trusted - review required`) and persists the decision as `trusted_hash` under `[hooks.state]`, keyed `"<file>:<event_snake_case>:<i>:<j>"`; the hash pins the command, so any edit re-requires review. Probe: in a clean `CODEX_HOME` a freshly written `hooks.json` was **read and validated** (it clamped a timeout) yet **no hook ran** across two consecutive runs, and codex recorded no trust entry of its own. Forging that hash would forge the person's security approval, so the surfaces say **available, not armed** and name this reason. `--dangerously-bypass-hook-trust` is per-invocation and self-describing. Plugin-bundled hooks skip the review (`Managed hooks are always on`), and **that route is now generated**: `aw self install-hooks --target codex` writes a bundle — `.codex-plugin/plugin.json` with `"hooks": "./hooks.json"`, the five template events verbatim — under `~/.agent-workflow/codex-plugin/`, and reports `generated`, never `installed`. Codex takes plugins **through a marketplace** (`codex plugin marketplace add` then `codex plugin install`), so arming it is the person's step; the uninstaller removes the bundle, and only when its descriptor `name` is ours. Verified against codex-cli 0.147.0 (its plugin validator's required fields and its own scaffold).

> **Hooks contract per host** (catalog dated **2026-08-18**; runtimes read 2026-08-04 and 2026-07-29). Three catalog rows described mechanisms their runtimes do not have. **crush** was declared hookless and has hooks: `crush.json` → `hooks` (`command` · `matcher` · `timeout`), **only `PreToolUse`** (v0.87.0, its embedded docs + JSON schema). **gemini/Antigravity** named a `BeforeTool` event that appears **nowhere in `agy` 1.0.16**: what it has is one `hooks.json` at its customization root, with `PreToolUse`/`PostToolUse` Claude-shaped plus `PreInvocation`/`PostInvocation`/`Stop`. **opencode** named its event but never its artifact, which is a **JS/TS module in `.opencode/plugin/`** declared under `"plugin": []` — code, not config. That module is now **generated** (`aw self install-hooks --target opencode`): it registers `tool.execute.before`, and it TRANSLATES — opencode calls its tools `edit`/`write`/`bash` while our hooks read a Claude-shaped `{tool_name, tool_input}` and act only on names they know, so the module bridges both ways and throws on the CLI's exit 2. The SQL guard does **not** travel: its matcher (`mcp__.*__execute_sql`) names no opencode tool the bridge can produce, and the generated file's own header lists that omission next to the four missing events. Ownership is the module's first line; uninstall removes it and its `plugin[]` entry, and leaves anyone else's. Against the bundle's five template events: Claude and Codex carry all five; Kimi carries all five with `PostCompact` **partial** (its `type: "prompt"` handler is not expressible in `config.toml`); **crush, gemini and opencode carry `PreToolUse` and nothing else**. So on those three the **enforcement travels and the resumability does not** — no session pin, no compaction checkpoint — and that is declared, never simulated: agy's `Stop` fires at the end of every turn rather than at session close, and opencode's only compaction candidate is `experimental.session.compacting`.
>
> **crush and agy are now MANAGED** (`aw self install-hooks --target crush|gemini`, and the uninstaller removes what it wrote). Their `PreToolUse` matchers are TRANSLATED, never copied: ours name Claude's tools, crush's are `edit`/`write`/`multiedit`/`bash` and agy's are its step types lowercased (`file_change`, `run_command`), so a verbatim matcher would install a hook that never fires. A matcher with no translation **skips its hook and says so**. Ownership is per entry, by the command invoking this CLI: on crush ours are merged beside the person's own `hooks` inside `crush.json`, and on agy ours live under one named hook (`agent-workflow`) in `~/.agents/hooks.json` — a hook of that name whose commands are not ours is left alone. agy documents its customization root as the workspace's `.agents/`; whether a user-global one is read is **not verified**, and the install result says so rather than implying it.

> **Notes (field research Aug-2026):** **`SKILL.md` skills** are the **universal** portable unit — **every harness in the matrix** supports them (Codex added them Dec-2025; **`.agents/skills` is the cross-host anchor**, read by Codex/OpenCode/Crush/Warp/Oz/**Kimi Code** — every host except Claude Code, which reads only `.claude/skills`). The **enforcement layer** is **not Claude-exclusive**: Codex + Gemini use a near-identical protocol (`permissionDecision:deny` / exit 2) and OpenCode blocks via `throw` in a JS plugin; Crush blocks through `PreToolUse` in its own `crush.json` (its ONLY hook event) on top of its `allowed_tools` allowlist; Warp/Oz only offer **coarse** allow/deny (no custom per-command logic) → there, conventions stay **advisory** + allow/deny lists. Enforced **plan mode** is never trusted for safety; git-safe (invariant #5) is our own — though a host-planner's *output* (the plan it built) is adoptable input (`../commands/plan-new.md` § *Input resolution*, mode 4). **MCP** is universal (each host its file/key). The **guaranteed floor** (last column) runs the full model.

> **structured-choice routing.** A native binding qualifies only when the current client exposes it and can display the option's functional sentence without loss. When it has separate fields, map the semantic label and sentence to them; when it exposes one visible option string, render `Label — functional sentence`. Otherwise use labeled markdown. Respect the per-call ceilings in the row and reserve one question slot for `flow`; carry overflow into a later call. If the native tool already injects a custom/free-text option, do not add a duplicate `Other` option.

> **structured-choice evidence — what a RUN proved (2026-08-04; re-probed 2026-08-22).** Probed against the runtimes installed on the verification machine (2026-08-22: claude 2.1.239 · codex-cli 0.149.0 · kimi 0.36.1 · opencode 1.18.15 · crush v0.90.0 · agy 1.0.16 · oz v0.2026.08.19). **Codex** (0.149.0, read from the shipped binary): the full `RequestUserInputOverlay` TUI exists (selection + free-form answer + an `Other: ` write-in row) and availability is **per turn** — its embedded prompt says `Use the request_user_input tool only when it is listed in the available tools for this turn` and adds `Never write a multiple choice question as a textual assistant message`; the literals `not supported in exec mode`, `requires an interactive stdin terminal` and `can only be used by the root thread` gate the rest, and `codex features list` still reports the opt-in as `under development  false`. **Three real turns** through `codex debug app-server send-message-v2` settled the rest: in plain Default mode the model answered that the tool is not available in this mode; with `--enable default_mode_request_user_input` (reported `true` by `features list`) it answered the same and added that Plan mode has to be turned on, so **the opt-in alone does not add the tool**; forcing `-c collaboration_mode=plan` → unchanged, because a mode is switched by TUI slash command, not by config (`ModeKind` = `plan|default|code|custom|execute|pair_programming`). That channel has no TTY, which the tool requires, so it bounds what the probe can claim: it proves the opt-in is not the lever, never that an interactive TUI mode fails. **And it found the mode-independent path**: codex's MCP client announces `capabilities.elicitation {form, url}` in its handshake (captured 2026-08-22) and uses that very mechanism for its own tool-approval prompts, so an MCP server can render a native form even in Default mode (supersedes the 0.146.0 router refusal a real run hit on 2026-08-04). **Kimi** (0.36.1): the tool and its auto rule (`Do NOT call AskUserQuestion while auto mode is active`) read verbatim from the binary; in `--prompt` (0.31.1) it degraded to labeled markdown by itself, options intact. **OpenCode** (1.18.15): `QuestionOption` and the non-interactive `{"permission":"question","action":"deny"}` default read from the binary; a real `opencode run` (1.18.5) exported exactly that denial. **Crush** (v0.90.0): ceilings 5×5 and the <300/<100-char caps read from the binary, which now details four question types (`yes_no`/`single_choice`/`multi_choice`/`free_text`) in a tabbed form; the run stays unverified (expired auth). **Antigravity (`agy`)** (1.0.16, unchanged): its shipped proto declares `AskQuestionEntry {options, is_multi_select, write_in_response}` and `AskQuestionOption {id, text}` — no description field — while `ask_user` does not appear in the binary at all. **Warp** ships no CLI, so its row rests on docs; **Oz**'s launcher (v0.2026.08.19) is still a 122-byte Bash shim inside Warp.app with no tool surface of its own.
>
> **Doc references (checked 2026-08-02):** [Claude Code](https://code.claude.com/docs/en/agent-sdk/user-input) · [Codex App Server](https://learn.chatgpt.com/docs/app-server.md) · [Kimi Code](https://moonshotai.github.io/kimi-code/en/reference/tools.html) · [Gemini CLI](https://geminicli.com/docs/tools/ask-user/) · [Antigravity changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) · [OpenCode](https://dev.opencode.ai/docs/tools/) · [Crush source](https://github.com/charmbracelet/crush) · [Warp agents](https://docs.warp.dev/agent-platform/getting-started/agents-in-warp) / [Oz CLI](https://docs.warp.dev/reference/cli). Public docs do not expose Antigravity's full question schema or a dedicated Warp/Oz structured-choice schema; the row says so instead of inferring one.

> **Oz (Warp's cloud sibling).** `oz agent run` is a cloud agent orchestrator that **reuses Warp's surfaces**: same skills (`.agents/skills`, top-level dirs like Warp) and `AGENTS.md`. No dedicated structured-choice schema is documented for Oz itself, so a direct Oz run uses labeled markdown; if Oz delegates to another harness and exposes that harness's native question surface, follow that harness's own binding. Oz differs from Warp in three points: **detection** via `OZ_RUN_ID` (takes priority over Warp when both markers coexist); **MCP without a config file** — the JSON is passed via the `--mcp` flag of `oz agent run` (or the `OZ_MCP_CONFIG` env), it never writes `.warp/.mcp.json`; and **no plugin or hooks** (advisory enforcement, like Warp). Hence it shares the **Warp / Oz** column with those caveats.

> **compaction (signal & self-regulation).** The chassis' *Self-regulation (proactive compaction)* doctrine (`../modules/COMPACTION.md`, loaded under the `compaction` signal) needs two per-host facts: the **context-pressure signal** (does the host surface one the agent can read?) and **`auto`-mode viability** (can compaction fire **without user interaction**?). Claude Code: the signal is the harness' own context warnings; `/compact` is user-invoked — the agent cannot run it itself, so `auto` **degrades to `confirm`** there (the native auto-compact is already cushioned by the PreCompact/PostCompact hooks: checkpoint-write + resume-summary). Hosts with compaction hooks/events (Codex Pre/PostCompact, OpenCode `session.compacted`) cushion resume the same way; hosts with neither signal nor mechanism run the universal fallback (CHECKPOINT + restart + resume) and `auto` likewise degrades. Mode semantics (`[compaction]` config, default, consent): the chassis' subsection — single source.

> **host-memory (tiers & consumers).** Two tiers: *cheap* (structured, bounded — on Claude Code the auto-memory `MEMORY.md` + `CLAUDE.md`) and *deep* (transcript / `--resume` search, expensive). Consumers: **`/status`** reads only the *cheap* tier, **opportunistically and additively** (a `CONTEXTO DEL HOST` section when available; it **never asks** — a read-only dashboard — and silently omits the section on degrade); **`/resume`** **composes `/status`** and escalates a host-only finding **to a proposal only when the workline level does not explain the pending work** (the spec's fixed order governs the proposals, not the summary), optionally using the *deep* tier or asking as fallback. It is *enhancement*, never a `must`.

> **web-research (consumer & consent).** Single consumer today: `spec-refine-loop` § *Ideation gate* (the SPEC flow's divergent gate). Consent is **bundled into accepting that gate's offer** — one accepted offer authorizes that round's searches; never free browsing outside a consented round. It is *enhancement*, never a `must`: on degrade the loop ideates **offline and declares it** (unlike host-memory's silent omit — the user consented expecting the web, so silence would mislead).

## Directive presentation (flow boundaries)

A host surface — a command wrapper, a skill, an adapter — **invokes** the direction engine (`aw flow advance` / `aw flow submit`), **transports** the directive it returns and **presents** it. It never re-derives a transition, re-orders a journey or restates a rule the engine owns: the CLI decides, the surface shows. Two surfaces on two hosts therefore show the *same* boundary through *different* mechanisms, which is precisely the *capability, not tool* principle applied to one more capability.

Each boundary kind maps to a capability **already catalogued above**; this table adds no host column, so per-host mechanisms keep living in exactly one place — the binding matrix.

| Boundary | What it asks for | Capability used | Must survive the presentation |
|---|---|---|---|
| **semantic** | a bounded judgment from the agent | *procedure-loading* — the agent reads the request's `read_set` and answers inline; no human mechanism involved | `request` whole — contract, limits, `read_set` — and `state_digest` |
| **human** | a preference nobody may infer | *structured-choice* | every `choices` entry with its consequence, and the single recommendation |
| **authorization** | an approval over the effect classes it names | *structured-choice* | `choices`, `effects`, `authorizations`, and the approval digest carried in `next_action` |
| **execution** | a step the CLI decided and cannot run inside its own process | *command-invocation* — run exactly the invocation the directive names | `action` whole — program, args, target, input, the `evidence` demanded and the recovery — plus `state_digest` |
| **blocked** | nothing, until the cause is cleared | — (plain report) | `error`: code, message and the one valid action |
| **final** | nothing: the journey is done | — (plain report) | `pending` (empty) and the `applied` trace with each step's authority |

- **Four things a presentation may never drop**, whatever the host: the **options** with their consequence (`choices`), the **explanation** of what is being asked (`request` at a semantic boundary), the **effects** at stake (`effects` + `authorizations`), and the **resume evidence** (`state_digest` + `session`) — without that last pair the boundary cannot be answered from another host, or after the conversation is gone.
- **Degrade the mechanism, never the content.** A host with no native question surface renders labeled markdown (see the matrix); it does not merge, truncate or drop alternatives to fit. Losing content is a *degradation* and is declared as one.
- **Ownership travels with every step.** The trace says each applied transition is `cli-owned`, and a surface may not present one as its own decision — the registry (`domain/flow/authority.ts`) is the only place ownership changes.
- **An execution boundary is answered with output, never with agreement.** The surface transports `action` unchanged, the executor runs *that* invocation, and `aw flow submit` brings back the real result: the outcome, the invocation it actually ran, and one validation per demanded evidence id carrying the tool's own output in `detail`. A boolean confirmation, a narration or an approval already granted prove nothing ran — the engine refuses them and the transition stays pending with the action's declared recovery.

## Leverage installed skills

"Leverage whatever skills the harness has installed" resolves through the **same** `.workflow/skills.toml` binding: a role can point at a skill **installed on the host** (third-party, via skills.sh) instead of the built-in. Rule:

- If the host has a **better** skill for a role (e.g. a superior diagram generator for `diagrams`, or a specialized investigator for `research`), **bind it** in `.workflow/skills.toml` and the loop composes it unchanged.
- The built-in default is the **floor**, not the ceiling: it guarantees the role works on any host; the binding **enriches** it where the host can do more.

## Convention for the rest of the corpus

- Loops/commands reference the **capability** by name (e.g. "*structured-choice* (see `harness/HARNESS.md`)"), **never** the concrete tool.
- Concrete tool names survive **only** as per-host bindings in this document, never as doctrine vocabulary.
- The `flow` lifecycle control (`Compactar`/`Cerrar`) belongs to the `structured-choice` capability, not to a tool: a required native field adds neutral `Continuar`; the text fallback leaves flow optional.

## Distribution (install-time)

Proven pattern (Spec Kit, 30+ agents): **one canonical source** + generate/symlink into the per-harness dirs at install (`.claude/`, `.codex/`, `.gemini/`, …). Workline already does this via `aw self install-skill`. Recommended convention: **canonical `AGENTS.md` + `CLAUDE.md` symlink** (Claude Code does not read `AGENTS.md` natively; the rest do).

## Command packaging (harness-specific)

Each command's **contract** (Flow, Trigger, Input, Mode, …) is agnostic. The **file** the harness executes wraps that contract in its native format — the installer (`aw self install-skill`) emits the right wrapper per host, retargets bundle-relative links to that host's installed `skills/w` directory, binds its flow/capability calls with `--host <target>`, and materializes the authored `${CLAUDE_PLUGIN_ROOT}/skills/w` token to the same absolute bundle for `aw context-plan --root`. Claude's plugin surface expands that token natively; installed wrappers never rely on the CLI's potentially different packaged copy:

| Host | Wrapper installed | Invoked as |
|---|---|---|
| Claude Code | `~/.claude/commands/w/<cmd>.md` (frontmatter `description`/`argument-hint`/`allowed-tools`) | `/w:<cmd>` |
| Codex | synthesized skill `~/.codex/skills/w-<cmd>/SKILL.md` (Codex reads no commands dir; custom prompts deprecated/removed since 0.14x) | `$w-<cmd>` mention |
| Gemini/Antigravity | synthesized skill `~/.gemini/skills/w-<cmd>/SKILL.md` (agy reads NO commands dir — slash commands are system-only; verified vs agy 1.0.16 binary) + `~/.gemini/commands/w/<cmd>.toml` kept for legacy Gemini CLI | skill (agy) · `/w:<cmd>` (legacy CLI) |
| OpenCode | `~/.opencode/command/w/<cmd>.md` | `/w/<cmd>` |
| Crush | `~/.crush/commands/w/<cmd>.md` (plain body — Crush parses no frontmatter) | palette `user:w:<cmd>` |
| Warp/Oz | synthesized skill `w-<cmd>/SKILL.md` next to the bundle (Warp lists skills as `/name`) | `/w-<cmd>` |
| Kimi Code | synthesized skill `~/.kimi-code/skills/w-<cmd>/SKILL.md` (reads no commands dir; verified vs v0.29.2) | `/skill:w-<cmd>` |

*Skill-as-command* (a synthesized `w-<cmd>` skill whose body is the command, with bundle references rewritten to `../w/…`) is the **universal fallback** for any host without a native commands surface. The loop/role/export manuals are deliberately **not** `SKILL.md` files (`LOOP.md`/`ROLE.md`/`EXPORT.md`/`HARNESS.md`): hosts that scan skill roots **recursively** (Codex ≤6 levels; OpenCode and Crush — which also cross-read `~/.claude/skills` and `~/.agents/skills`) must never index the internals as invocable skills. The contract never changes; the wrapper does (another column).

## Status

Capability model + binding matrix **defined** and **validated** with field research (base **Jul-2026**; the `structured-choice` row re-verified **2026-08-22**, the Codex `hooks` row **2026-08-05** and the crush/gemini/opencode `hooks` contract **2026-08-18** against the INSTALLED runtimes plus real runs — see the evidence note under the matrix for which claims rest on a run and which still rest on a doc). The per-host hook contract lives in `domain/harnesses.ts` (artifact + one answer per template event) and its fixtures are the guards in `host-catalog-guards.test.ts` plus the dialect and HOME-temp cases in `hooks-json-dialects.test.ts`; opencode's plugin artifact is still later work, and observing any of them inside an installed host is an optional handoff, never a closing condition.

The catalog counts **8 hosts** — `claude-code`, `codex`, `oz`, `warp`, `gemini`, `opencode`, `crush`, `kimi` — each with its own entry in `domain/harnesses.ts`. The columns above group two pairs that share a config surface (Warp/Oz, Gemini/Antigravity), which is a presentation choice, not a second taxonomy: the host set is whatever `HARNESSES` says. Anti-drift guards cover the CODE projections (TUI, install targets, doctor, detection); `chassis-consistency.test.ts` additionally parses the `structured-choice` row and asserts every host binding or explicit limitation. Support levels: **official** — Claude Code, Codex, Warp, Gemini/Antigravity, Kimi Code; **best-effort** — Oz, OpenCode, Crush. `agents` (`~/.agents/skills`) is a **shared destination**, never a host.

All support `SKILL.md` (anchor `.agents/skills`) + MCP + `AGENTS.md`; deterministic enforcement on Claude/Codex/Kimi/Gemini/OpenCode/Crush, advisory + coarse allow/deny on Warp/Oz. The CLI (`aw`) implements the registry (`domain/harnesses.ts`), the per-host MCP writers, `detect-hosts` and `install-skill --target <host>`. The universal floor (`AGENTS.md` + text + files + skills) runs the full model today.
