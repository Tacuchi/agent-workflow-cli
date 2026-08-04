# IDEATION-GATE — widen the option space before the spec hardens

Loaded when a trigger says the solution space is unexplored (signal `web`).

## Ideation gate (creativity)

The loop's one **divergent** gate: every other resolver closes a gap; this one widens the option space before the spec hardens around its first idea. **Unexplored solution space is not a universal gap** — exploring what is already decided burns context and invites gold-plating, so the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document: you declare whether a trigger fires, and the offer appears only then.

**Triggers.** The user knows the problem but not the desired outcome · several functional directions carry materially different consequences · the spec adopted the first alternative prematurely · a choice can materially change scope · the alternatives change experience, rules or acceptance · the user asks to explore.

**Not triggers.** More than one technical solution exists · no library is chosen yet · the system uses several technologies · every implementation admits alternatives · the request is already functionally clear. Purely technical alternatives belong to `PLAN`.

1. **Offer & consent.** Declining marks the gap **exhausted** (never re-offered this run); an explicit user request for ideas at any point counts as an accepted offer (on-demand entry). Alternatives already weighed in the conversation are *adopted context* — the trigger does not fire.
2. **Ideation round** (one per consent). Propose fresh ideas and **combinations** (the user's + found ones). If the host exposes **web-research** ([`../harness/HARNESS.md`](../harness/HARNESS.md)), the accepted offer also authorizes that round's web searches — no per-search consent; findings + sources land in the session's `CONCLUSIONS`, like inline research. Without the capability, ideate offline (own knowledge + workspace + repos) and **declare it** — never silently.

**Verdicts (back to convergence).** Present the top ≤3 ideas via the same structured-choice, each with a recommended verdict: `Adoptar` → integrate into `Requirement`/`Scope`/criteria + record it in `## Decisions` (the choice and its why, with the source/URL when web-found) · `Descartar` → the reason goes to `CONCLUSIONS`, not to the spec · `Aparcar` → `## Open questions` with its destination. Ideas beyond the top 3 stay summarized in `CONCLUSIONS`. Divergence is bounded by *Minimality* (chassis): nothing enters the spec without an explicit `Adoptar`. This gate exists **only** in this loop — `spec-new` stays single-pass (bounded reconnaissance at most, no web) and the plan/quick loops inherit none of it.
