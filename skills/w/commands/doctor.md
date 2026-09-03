---
description: Use when the user asks if the install, MCPs, skills or auth are healthy across hosts, or to repair what Workline owns.
argument-hint: "(none) | prepare --select <id>… | apply --approval <digest> --select <id>…"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# doctor — diagnosis across every host

The report is read-only and leaves no trace. `prepare` seals and is logged; `apply` is the only step that writes. No loop, no session.

## Run

1. `aw doctor --format human` — emits coverage, findings and a verdict for every detected host. **The exit code IS the verdict**, and `ok:true` keeps the report printing even when it blocks. The default pass asks Claude and Codex for their MCPs, which connects them; `--skip-native` declines it and leaves that coverage `omitida`.
2. **Relay it verbatim** — never paraphrase, re-sort, add or drop a line.
3. `aw doctor prepare --format human`, with no selection, lists what can be repaired (`automatizable`); the report's `accionable` count also includes manual findings no batch accepts, so take the listing, not the count. **One option per listed finding**, in its order, plus the `flow` slot. Canonical [option shape](../loops/CHASSIS.md#structured-choice-design--batching) and [host binding](../harness/HARNESS.md#harness-binding-matrix); the id is the label, `impacto` + `acción` the sentence.
4. `aw doctor prepare --select <id> … --format human` seals that batch. Relay its preview and ask for **its digest**: the approval is over what the preview shows.
5. `aw doctor apply --approval <digest> --select <id> … --format human` applies in order and re-checks each resource. Relay it action by action: that is where a partial batch matters.

> **Nothing here is re-derived.** Ownership, effects, order and what the digest covers are the CLI's answers; never call a resource ours. `EVIDENCE_MISSING` names both digests: the state moved, so run `prepare` again.

> **`--verify-connection` authorizes leaving the machine** to verify a credential. Without it every deep verification degrades and says so: a present variable never reads as a working one. The CLI never holds a secret: guidance names the variable, not its value.

Degradation is declared, never silent: with no structured-choice, list the options as labeled markdown with the `flow` control among them.

## More context

`aw context-plan --command doctor --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the extra documents a case needs; read exactly what it lists.
