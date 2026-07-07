---
description: Use when work already produced in this conversation (analysis, conclusions, a plan) should be saved into docs/ — classifies its shape and routes it. analysis → docs/research/ · requirement → spec draft (docs/specs) · plan → plan adoption (docs/plans). Transversal (no flow, no loop, no session); records ## Origin + attribution (host · model · date); anti-duplicate aware (update vs sibling perspective). The host→docs/ counterpart of export-*.
argument-hint: [what to persist — empty = the conversation's latest finished deliverable]
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# persist — persist in-conversation work into `docs/`

Captures **work already produced in this conversation** — with or without host-native features (a `/goal` run, plan mode, plain chat analysis) — and persists it into `docs/`, classified by shape. It is the explicit form of *direct no-flow authoring* (`../SKILL.md` § *Operating context*, row 3) and the doctrinal entry for **host as producer** (`../loops/CHASSIS.md` § *Adopted context*).

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Adopt, don't re-derive** — single pass, **NO RESEARCH**: transcribe/organize what the conversation already established. New investigation is flow work (`spec-refine`, `quick`), never this command's.
> 2. **Confirm before writing** — classification and destination go through **structured-choice** (recommendation first). Never write `docs/` silently.
> 3. **Numbering via `aw next-number docs/<category>`** (it creates the folder when missing) — never invent numbers. **Never creates sessions** (sessions are loop-created only).
> 4. **Language** — headings in English (parse contract); content in the **user's language**.

## Input

`$ARGUMENTS` names what to persist (or is empty → the conversation's most recent finished deliverable). The **source is the conversation itself**: what was analyzed, concluded, designed or planned up to this point. If nothing persistable exists yet, say so and stop — do not manufacture content.

## Classification → routing

Classify the content by **shape**, recommend the route, confirm via structured-choice:

| Shape | Signals | Route |
|---|---|---|
| **Analysis / conclusions / design notes** | findings, comparisons, diagnoses, adjudications, recommendations | `docs/research/NNN-research-<slug>.md` (schema below) |
| **Requirement** | describes a *wish*: what should exist/change, acceptance criteria derivable | **spec draft** via the [`spec-new`](spec-new.md) procedure (same schema, same NO RESEARCH), `## Origin` = "adopted from host conversation" → offer `/w:spec-refine` |
| **Plan** | already answers the *how*: phases/tasks/solution — e.g. the host plan-mode output | **plan adoption** via [`plan-new`](plan-new.md) § *Input resolution* mode 4 (`docs/plans/PPP-plan-<slug>.md`) → offer `/w:plan-refine` / `/w:plan-exec` |
| Mixed / ambiguous | e.g. analysis that ends in a requirement | structured-choice between the candidate routes (split is a valid option: research doc + spec draft referencing it) |

Requires a **workspace** (`docs/` is the managed surface). Without one → degrade: propose `/w:workspace-init` or ask for an explicit destination path.

## `docs/research/` — the analysis home (owned by this command)

`docs/research` hosts standalone analyses: neither spec nor plan, but worth keeping. Written by this command (or by direct no-flow authoring following this same schema). Belongs to **no flow**; `export-*` never writes it; loops never read it implicitly (a flow uses it by **reference** — e.g. cited in a spec's `## Origin` or a quick prompt).

```markdown
# Research NNN — <slug>

## Origin
adopted from host conversation — <host> · <model> · <YYYY-MM-DD>
(what prompted the analysis: goal, prior doc, question)

## Objective
The question/situation the analysis addresses. In the user's language.

## Analysis
The analysis, transcribed/organized (not re-derived).

## Conclusions
The settled conclusions — actionable, falsifiable where possible.

## Perspectives        (opt. — multi-agent)
### <host · model · YYYY-MM-DD>
An additional agent's view on the same objective (see below).

## Sources             (opt.)
Docs / repos / prior research docs referenced (for a synthesis: the N crossed docs).

## Open questions      (opt.)
```

## Anti-duplicate → update vs sibling perspective

Before writing, scan `docs/research/*-research-*.md` for a doc whose `## Origin`/`## Objective` matches this objective. If one exists, **never** silently create a second: structured-choice —

- **`Actualizar`** *(recommended when it is the same line of thought)* — correct/extend the existing doc in place (confirmation to overwrite).
- **`Agregar perspectiva`** — append a `### <host · model · date>` subsection under `## Perspectives`: same objective, **different agent's view** (this is intentional and legitimate — the multi-host pattern below).
- **`Documento nuevo`** — only if the objective genuinely differs.

## Multi-host cross-analysis (the docs-mediated pattern)

`docs/research` is git-shareable — unlike sessions (gitignored, machine-local, loop-owned). That makes it the exchange surface for **N agents analyzing the same situation**:

1. **Each host** analyzes in-conversation, then runs `/w:persist` → first agent creates the research doc; the rest **add perspectives** (or sibling docs), always attributed (host · model · date).
2. **The final cross**: the user picks the strongest host; its input is the N research docs/perspectives (referenced explicitly in the prompt or via this command's argument). The synthesis persists as a **new research doc** whose `## Origin` states "synthesis" and whose `## Sources` lists every doc/perspective crossed — attribution lets it weigh who concluded what.
3. Sessions stay **out** of the exchange path — no concurrent-session doctrine is needed; hosts meet only in `docs/`.

## What this command is NOT

- **Not export-*** — it never reads sessions; `export-*` remains the only session→`docs/` path.
- **Not a flow** — no loop, no session, no `CHECKPOINT`; single pass.
- **Not research** — it investigates nothing (NO RESEARCH); it persists what already exists.

## Plan mode

Classifies the content, resolves `NNN`/destination (`aw next-number --dry-run`) and describes the doc it would write (or the update/perspective it would append) without writing anything.

## Resources

- Adopted-context doctrine: `../loops/CHASSIS.md` § *Adopted context* · `../SKILL.md` § *Host as producer*
- Spec-draft procedure: [`spec-new.md`](spec-new.md) · Plan adoption: [`plan-new.md`](plan-new.md) § *Input resolution* (mode 4)
- Session→docs counterpart: [`../exports/README.md`](../exports/README.md)
