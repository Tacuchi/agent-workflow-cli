# CODE-POLICIES — policies for code-editing loops

They apply to **`plan-exec-loop`** (per plan phase) and **`quick-loop`** (the single task; **proportional** gate): each orders this doc read from its `## Inherits`, **together with the chassis** ([`CHASSIS.md`](CHASSIS.md)). The document loops (spec-refine, plan-new, plan-refine) edit no code and do **not** load this doc — that is why it lives apart from the chassis. These policies materialize the **DB scripts-only** and **safe git** invariants — which also stay summarized **inline** (1-2 lines) in each code-editing loop's `LOOP.md`, because advisory hosts do not follow Reads; the full normative text lives here.

## Safe git — verified branch + proposed commits

- **Before editing** a source's files: verify current branch = that source's expected branch (`aw check-branch --source <alias>`; see the `git` role). On mismatch → **pause and resolve with the human**; never `stash`/`reset --hard`/`checkout -- .`/`clean` without per-source confirmation.
- **Proposed commits** (propose-then-execute, approve before): **after the closing review gate passes** (below), propose commits **per source** — in plan-exec at each phase close (or on `Cerrar`); in quick, **a single commit** at the end if there were code changes. Never `push`/`--amend`/`--no-verify`. Nothing reaches a proposed commit without review.
- **Rejected commit**: the changes **stay in the working tree** (never reverted). Re-proposing / editing the message is allowed. Record in `CHECKPOINT` + `BACKLOG` that the phase/task remained **uncommitted** (resumable).
- **Between-phase precondition** (plan-exec): `branch-check` validates branch *identity*, **not** working-tree *cleanliness*. Before starting the next phase, each source's working tree must be **clean** (committed) or explicitly **acknowledged** as "uncommitted changes from phase N" — so two phases never co-mingle in one commit.

## DB scripts-only — the AI never executes DML/DDL

Distinguished by **execution**, not by file (see the [`SCRIPTS.sql`](../artifacts/artifacts-core/SCRIPTS.sql) schema):

- **Read-only queries** (diagnosis/validation) → `SCRIPTS.sql` (session artifact); the AI **does** execute them read-only via MCP (`sql-mutation-guard`).
- **DDL/DML migrations** (schema/data changes) → the AI **drafts them in `SCRIPTS.sql`** (session artifact) but **NEVER executes them**.

> Mutating SQL **stays in the session**; it is never moved to `docs/`. Its promotion to `docs/scripts/` (forward + rollback) is done by a separate `export-*`, never by the loop.

## Closing review gate (conventions, pre-commit)

After validation (of the phase in plan-exec; of the task in quick, proportional) and **before proposing its commits** (also on an early `Cerrar`, before proposing the pending commits), the diff passes a **closing review gate**:

- **Independent re-read** of the diff (subagent or clean re-read — the engine's *independent verification*: it does not assume the implementation is correct; *only command output counts*).
- **Apply the installed ambient conventions** relevant to the touched stack (code/stack standards, security, diff review, the workspace's own families) — the host **auto-discovers them by `description`**. Workline **names and binds no** concrete conventions skill: **it creates the moment; the installed skills fill it** (that is why review is **not a role** — see [`../roles/README.md`](../roles/README.md)). With no convention skills installed → minimal generic checklist: SOLID/early-return, clear names, DRY, no silenced errors, no secrets/PII, parametrized SQL, no dead code, + the plan's `Validations` (if any).
- **Minimality lens** (floor — holds with **no external skill**; chassis § *Minimality*): re-read the diff for over-building. Flag `delete` (dead/speculative code), `stdlib` (reinvented standard library), `native` (a dep or code doing what the platform already does), `yagni` (one-implementation abstraction, config nobody sets, one-caller layer), `shrink` (same behavior, fewer lines). An installed ambient review skill *raises* this; it never lowers it.
- **Tooling check** (`docs/tools`): did the run create **reusable auxiliary tooling** (support scripts/CLIs/generators/reusable configs — not product code, not session probes)? → the host applies the **ambient `creating-tools` skill** (auto-discovered by its `description`; Workline does not bind it) so the tool gets its home under `docs/tools/<slug>/` (README + run/output structure per that skill's contract + its index row). Host without such a skill → the loop still **never writes `docs/tools` itself**: **declare the gap** — the homeless tool goes to the plan's `Open questions` + `BACKLOG` (in quick, `BACKLOG`) — never silent.
- **Findings**: **fix** them in the working tree and **re-run validation** (the gate does not replace the tests: it re-verifies after fixing), or **defer them justified** (→ the plan's `Open questions` + `BACKLOG`; in quick, `BACKLOG`); the non-obvious → `DECISION`. Gate integrity (see [`CHASSIS.md`](CHASSIS.md) § *Verification-first*): never weaken a check or lower a convention to pass.
- **Artifact-first + verification-first**: `CHECKPOINT.Next = "review <phase/task>"` before the pass; `SESSION.Success criteria` includes from the start "the diff passed the review gate before its commits".

Only with the gate green are the commits proposed.

## Location

Same as the chassis: code-editing loops reference it as `../CODE-POLICIES.md` — the `w/loops/` tree is installed intact on every host (chassis § *Reference resolution*).
