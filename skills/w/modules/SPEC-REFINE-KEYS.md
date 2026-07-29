# SPEC-REFINE-KEYS — compact / resume keys for SPEC

Loaded when a refinement resumes or re-runs over the same spec (signal `resume`).

## Compact / resume — SPEC keys

Full mechanism (3 cases, `Compactar`, re-run on demand with `--reopen`) in the chassis (§ *Compact / resume*). SPEC keys:

- The **prior-work mark** is the frontmatter `status: ready-for-plan` (legacy specs: `## Refinement decisions`, older ones also `## Q&A traceability`).
- The **shape decision survives a resume.** It is written to `CHECKPOINT` the moment it is taken, before anything acts on it, so a compact, a `Cerrar` or a crash between the gate and the save re-enters with the shape settled — the gate is not re-run and the question is not re-asked. Only a *new* run over a spec whose baseline changed re-opens it.
- Re-refining on demand is a **first-class operation** while the flow stays in SPEC (new requirements, scope changes, after re-reading the spec): it always reads the **spec itself**, incremental re-refinement; on `Guardar`, edits in place with confirmation.
- **Legacy migration happens only here.** A re-refined legacy spec runs the gate like any other; on `Guardar`, its `## Refinement decisions` is renamed `## Decisions` and pruned to the material decisions — **in the same write that stamps `status`**, so the spec is never left with no mark. Specs nobody re-refines are not migrated.
- **`Cerrar` before converging leaves the spec untouched**: the progress lives in the `CHECKPOINT`, and `status` is neither invented nor downgraded. `refining` is understood **on read** (a hand-written spec may declare it) — this loop never writes a partial spec.
- **The legacy glob still resolves.** `NNN-spec*.md` also catches old `NNN-spec.md` / `NNN-spec-refined.md` specs; re-running spec-refine edits them in place from then on.
