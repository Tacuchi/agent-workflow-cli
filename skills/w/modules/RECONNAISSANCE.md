# RECONNAISSANCE — the bounded look that precedes a scope decision

Loaded when a draft is being cut from a raw prompt and the terrain is not yet known (signal
`reconnaissance`).

## Bounded reconnaissance

A scope decision taken from the prompt alone mistakes **technical** boundaries for **functional**
ones. So, before deciding, take **one** shallow look at the terrain — enough to form a reasonable
hypothesis of the functional unit, never enough to answer how it will be built.

**Scope of the pass.** It runs **only on a raw user prompt** (direct invocation, or the `plan-new`
mode-3 handoff). The reuse entries skip it: the quick escalation and the `persist` adoption arrive
with their context **already established**, and adopting it is transcription, not reconnaissance
(**NO RESEARCH** — chassis section *Adopted context*).

One pass, in this order: **adopt** what the conversation already settled (never re-derive it),
**identify** the candidate sources, **look** at their surface, **stop**.

- **Sources allowed** (a permission, not an obligation to read them all):
  - the workspace's registered sources — `aw sources --no-git`, or the `WORKSPACE` block.
  - each candidate source's main instructions file, plus the head of its `README`.
  - build manifests: `package.json`, `pom.xml`, `build.gradle`, `requirements.txt`, equivalents.
  - a top-level directory listing per candidate source.
  - one or two entry points the prompt itself names, plus a handful of search hits.
- **Budget: ≤5 reads + ≤3 searches.** Read a whole file only when a head or a search will not
  do. The ceiling is a **cap, never a target**.
- **Stop at the first of these:**
  - the evidence already decides one spec vs sibling specs.
  - the next question needs a deep technical chain.
  - it would need running code, tests or services.
  - it would need an external source that is not available.
  - the remaining uncertainty does not block a first draft.
  - the digging starts answering *how it will be built* instead of *what functional unit was
    asked for*.
- **Never:** follow a full import/call chain, run anything, query a database, search the web, or
  open a source the prompt gives no reason to open.

**Scope hypothesis (internal).** The pass ends in a short judgement: functional outcome · likely
sources · apparent responsibility of each · coupling · independent acceptance · recommended shape
· confidence. It is **reasoning, not an artifact** — never persisted, never printed verbatim. It
exists so the cut is never intuitive but opaque; its only visible residue is what the filling
notes admit.

**Degrade safely.** A missing workspace, unreachable sources or contradictory evidence **never**
block the command and **never** justify a speculative cut. Keep **one spec**, declare the
assumption used, and record the uncertainty for `spec-refine`. Prefer the functional outcome the
user declared over any inference drawn from the code.
