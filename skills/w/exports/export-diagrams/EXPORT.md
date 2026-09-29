---
name: export-diagrams
description: "Promotes diagram material from a declared session corpus to a numbered docs/diagrams dossier. Uses evidence from source code and plans, requires no notation or diagram skill, and publishes only after validation and approval."
---

# export-diagrams — dossier from source evidence

## Category

`docs/diagrams/` is the only destination. Each publication is a new numbered dossier with `README.md`; no prior dossier is overwritten.

## Composes

Diagram help from the host is optional. It may propose content, but its installation or notation never proves a gate, chooses the corpus, or bypasses preview and approval. Pick a useful notation for the evidence at hand, or use plain Markdown. C4, Mermaid, Structurizr and any external provider are not prerequisites.

## When to use

Promote architecture, system, integration, data-flow or lifecycle diagrams derived from source code and the declared sessions.

## What it does

1. `aw export-diagrams prepare` fixes the selected session corpus, destination, output limits and scope seal. `aw release-data` and `aw session-artifacts --code <NNN> --dump objetivo` show the underlying sessions and plan references; inspect only the necessary source code, `## Solution` and `## Impacted` to substantiate the diagram.
2. Assemble `README.md` (index, evidence, scope and how to read) and one or more diagram files. Markdown, textual DSL, PlantUML, Mermaid or DOT are accepted as content, not mandated as the modeling technique. Mark unknown or omitted parts instead of inventing components.
3. Return an answer carrying the prepared `version`, `operation`, `input_digest` and `scope` unchanged plus `state: "proposed"` and `{path, content}` artifacts under the prepared destination. `aw export-diagrams validate` checks the complete dossier and produces the approval digest; `apply --approval <digest>` publishes it atomically. On an ambiguous or unsupported corpus, report the reason without writing.

## What it does NOT do

- Does not write outside `docs/diagrams/`, mutate sessions or code, execute DML/DDL, commit, merge or push.
- Does not treat a host skill as an authorization or send private sources to a remote renderer. Optional database evidence is read-only and never a reason to execute DML/DDL.
- Does not assume a diagram syntax, mandatory C4 levels, a particular file named `diagrams.md`, or a renderer. Publication validates destination and shape, not the choice of modeling technique.

## Read-only sandbox

In plan mode, describe the corpus and proposed diagrams without publishing or reserving a number. `aw next-number --dry-run docs/diagrams` is a pure numbering preview.

## Inputs

`/w:export-diagrams [--sessions NNN[,NNN]] [--since YYYY-MM-DD] [--source <alias>]`

The same scope flags apply to `aw export-diagrams prepare`; validate/apply read the sealed scope from the answer. With no filter the corpus is all eligible sessions; `--sessions` chooses explicit ones, `--since` starts after a date, and `--source` restricts an alias. The snapshot comes from current source evidence; sessions explain what changed, not a replacement for inspection. An optional read-only MCP can inform a requested data model, but an unreachable database is not a publishing dependency unless the chosen content claims its evidence.

## Flow

Read prepared corpus → inspect evidence → author diagram material with or without host help → validate the proposed files → show the preview → publish only with the exact approval digest → report the dossier path and any unsupported/unknown claims.

## Output location

`docs/diagrams/NNN-export-diagrams-YYYY-MM-DD/README.md` plus diagram files in Markdown or a supported textual source extension (`.dsl`, `.puml`, `.mmd`, `.dot`).

## Re-run

Each invocation uses the next number; corrections publish a later dossier rather than deleting or silently replacing an earlier one.

## Resources

Input: the selected plan's `## Solution`/`## Impacted` and the actual source tree. Siblings: [`../export-scripts/EXPORT.md`](../export-scripts/EXPORT.md), [`../export-manuals/EXPORT.md`](../export-manuals/EXPORT.md), [`../export-reports/EXPORT.md`](../export-reports/EXPORT.md).
