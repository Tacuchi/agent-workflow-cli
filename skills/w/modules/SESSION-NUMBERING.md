# SESSION-NUMBERING — who owns the NNN, and how a session is found again

Loaded when the run has to locate or name a session beyond creating its own (signal `sessions`).

## The CLI owns the number (hard rule)

`aw session-create` prepends a **global, sequential** `NNN` by scanning **all** sessions under `.workflow/sessions/` (any type). The caller passes **only the descriptor** via `--name` — **never** a number. Numbering neither restarts per type nor collides, and every folder is **self-describing**: `NNN-<slug>-<flow>` (e.g. `002-correo-otp-spec-refine`, `003-correo-otp-plan-new`, `004-correo-otp-plan-exec`, `005-validacion-correo-quick`).

> `<run>` = the session's **descriptor** (no number), always shaped **`<slug>-<flow>`**: `<slug>-spec-refine`, `<slug>-plan-new`, `<slug>-plan-refine`, `<slug>-plan-exec`, `<slug>-quick`. The `<slug>` is **descriptive** and comes from the flow's input doc — `docs/specs/NNN-spec-<slug>.md` for spec-refine/plan-new; `docs/plans/PPP-plan-<slug>.md` for plan-refine/plan-exec; the prompt for quick — so the folder says at a glance what it is about, not just which flow created it. Research being **inline** in this same session, there are no child `*-research-*` sessions to number (compat: old ones are historical).

## Finding one again

**Resume**: locate the existing session by **scanning** `.workflow/sessions/` for descriptor + `## Origin` (which spec/plan), **not** by reconstructing the number (global, not derivable from the artifact). `aw session-resume --code <NNN | folder>` resolves both forms.

**Reopen to continue**: `aw session-resume --code <NNN> --reopen` reactivates a **closed** session (removes `.closed` → active) to keep working in it; without `--reopen`, resume is read-only. To detect the most recent closed one: `aw resume-summary --include-recent-closed` (or `aw sessions --state all`).

## When the durable record fails to update

`aw session-close` also upserts the session's row in `.workflow/HISTORY.md` — the durable record, since `sessions/` is gitignored. That upsert is **non-fatal**: on `history_error` in its output, re-run `aw history-update --code <NNN> --state closed`. `aw session-artifacts` inspects what a session holds.
