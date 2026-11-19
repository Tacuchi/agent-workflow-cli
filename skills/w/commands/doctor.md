---
description: Use when the user asks if the install, skills, hooks or hub visibility are healthy across hosts, or to repair what aw owns.
argument-hint: "(none) | prepare --select <id>… | apply --approval <digest> --select <id>…"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# doctor — diagnosis across every host

The report is read-only and leaves no trace. `prepare` seals and is logged; `apply` is the only step that writes. No loop.

## Run

1. `aw doctor --format human` — verdict first, then what needs action; `detalle` → `--detail`. **The exit code IS the verdict**, and `ok:true` keeps the report printing even when it blocks.
2. **Relay it verbatim** — never paraphrase, re-sort, add or drop lines.
3. `aw doctor prepare --format human`, with no selection, lists what can be repaired (`automatizable`); the report's `accionable` count also includes manual findings no batch accepts, so take the listing, not the count. **One option per listed finding**, in its order, plus the `flow` slot. Canonical [option shape](../loops/CHASSIS.md#structured-choice-design--batching) and [host binding](../harness/HARNESS.md#harness-binding-matrix); the id is the label, `impacto` + `acción` the sentence.
4. `aw doctor prepare --select <id> … --format human` seals that batch. Relay its preview and ask for **its digest**: the approval is over what the preview shows.
5. `aw doctor apply --approval <digest> --select <id> … --format human` applies in order and re-checks each resource. Relay it action by action: a partial batch matters there.

> **Nothing here is re-derived.** Ownership, effects, order and what the digest covers are the CLI's answers; never call a resource ours. `EVIDENCE_MISSING` names both digests: the state moved, so run `prepare` again.

Degradation is declared, never silent: with no structured-choice, list the options as labeled markdown with the `flow` control among them.

## More context

`aw context-plan --command doctor --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists.
