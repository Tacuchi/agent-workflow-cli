---
description: Use when work already produced in this conversation (analysis, conclusions, a plan) should be saved into docs/ — classifies its shape and routes it to research, spec draft or plan adoption. Backed by `aw persist`, which owns the inventory, numbering, destination and the write. Transversal: no flow, no loop, no session.
argument-hint: [what to persist — empty = the conversation's latest finished deliverable]
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# persist — persist in-conversation work into `docs/`

Captures **work already produced in this conversation** — with or without host-native features (a `/goal` run, plan mode, plain chat analysis) — and persists it into `docs/`, classified by shape. The host→`docs/` counterpart of `export-*`.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **Adopt, don't re-derive** — single pass, **NO RESEARCH**: transcribe/organize what the conversation already established. New investigation is flow work (`spec-refine`, `quick`), never this command's.
> 2. **You classify and write; the CLI decides everything else** — inventory, anti-duplicate, numbering, destination, authorization and the write itself belong to `aw persist`. Never write into `docs/` with a file tool here; `Write`/`Edit` are deliberately not in `allowed-tools`.
> 3. **Never invent the number** — the `NNN` you put in the path is consultative; `apply` reassigns it inside the lock. Do not renumber it.
> 4. **Confirm before writing** — classification and destination go through **structured-choice** (canonical [option shape](../loops/CHASSIS.md#structured-choice-design--batching) + [per-host binding](../harness/HARNESS.md#harness-binding-matrix)); `apply` refuses without the digest `validate` returned. **Never creates sessions** (sessions are loop-created only).
> 5. **Language** — headings in English (parse contract); content in the **user's language**.

## Input

`$ARGUMENTS` names what to persist (or is empty → the conversation's most recent finished deliverable). The **source is the conversation itself**. If nothing persistable exists yet, say so and stop — do not manufacture content.

## Run

1. `aw persist prepare --format human` (`--detail` prints the full response contract). Returns the inventory of the three categories, the consultative numbering, the allowed destinations, the limits and an `input_digest`.
2. **Classify and write.** Compose one JSON answer:
   - `version`, `operation`, `input_digest` — copied **verbatim** from the request;
   - `state` — `proposed`, or `ambiguous` when the inventory already holds this work (explain in `reason`; the CLI turns that into a question, never a write);
   - `decisions` — `{ category, slug, mode }`, plus `target` + `target_digest` when `mode` is `update`;
   - `artifacts` — exactly one `{ path, content }`.
3. `echo '<json>' | aw persist validate --format human` → preview + `approval_digest`.
4. **Confirm classification and destination** with the user via structured-choice, showing that preview.
5. `echo '<json>' | aw persist apply --approval <digest> --format human`.

Every rejection names its cause and one valid next action; nothing was written. Fix the answer and repeat from step 3.

Requires a **workspace** (`docs/` is the managed surface). Without one → degrade: propose `/w:workspace-init`.

## More context

`aw context-plan --command persist --signal classification --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` returns the routing table — which shape goes to `docs/research/`, which becomes a spec draft, which is a plan adoption — plus the anti-duplicate rule: [`../modules/PERSIST-ROUTING.md`](../modules/PERSIST-ROUTING.md). Read exactly what it lists.
