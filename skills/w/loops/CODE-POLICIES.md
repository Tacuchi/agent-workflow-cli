# CODE-POLICIES — policies for code-editing loops

They apply to **`plan-exec-loop`** (per effective batch) and **`quick-loop`** (the single task;
**proportional** gate): each reads this doc with the chassis. Document loops do not edit code and
do not load it. These policies own the DB scripts-only, safe Git and closing-review invariants;
code loops keep only a short inline floor for advisory hosts.

## Safe git — verified branch + proposed commits

Sources are edited on a **verified** branch (`aw check-branch`), and the unit's commits are
**proposed**: exactly one commit per affected source — at effective-batch close in plan-exec, at task
close in quick — never `push`/`--amend`/`--no-verify`, and never a destructive clean or a branch
switch without confirmation. A **rejected** commit leaves the changes in the tree and the unit
recorded as uncommitted in `CHECKPOINT` and `BACKLOG`. Between units each working tree is clean or
explicitly acknowledged; a `continuous` batch is the narrow exception that intentionally co-mingles
its internal phases in one reviewed commit, and no batch may co-mingle with another.

Concurrent flows never share a working tree: each edits in its own **isolation unit** — a worktree
of the source on its own branch (`aw worktree ensure | list | release`), released at close. An edit
outside it is blocked, and the block names the command that creates one.

> **When the branch is verified, when a commit becomes available and what an approval covers is not this document's call:** the deterministic steps below are decided by the CLI (`aw flow advance`), not by this document. Approving is the person's act and committing is a separate effect that comes back as the sources' real git state — which is also what makes "the checks passed" impossible to assert without having run them.

## Closing review gate (conventions, pre-commit)

After validation and before commits, the whole execution-unit diff passes a **closing review
gate**: an effective batch in plan-exec, or the proportional task in quick. Early `Cerrar` uses the
same gate before any pending commit.

- **Independent re-read** of the diff (subagent or clean re-read — the engine's *independent verification*: it does not assume the implementation is correct; *only command output counts*).
- **Apply the installed ambient conventions** relevant to the touched stack (code/stack standards, security, diff review, the workspace's own families) — the host **auto-discovers them by `description`**. Workline **names and binds no** concrete conventions skill: **it creates the moment; the installed skills fill it** (that is why review is **not a role** — see [`../roles/README.md`](../roles/README.md)). With no convention skills installed → minimal generic checklist: SOLID/early-return, clear names, DRY, no silenced errors, no secrets/PII, parametrized SQL, no dead code, + the plan's `Validations` (if any).
- **Minimality lens** (floor — holds with **no external skill**; chassis § *Minimality*): re-read the diff for over-building. Flag `delete` (dead/speculative code), `stdlib` (reinvented standard library), `native` (a dep or code doing what the platform already does), `yagni` (one-implementation abstraction, config nobody sets, one-caller layer), `shrink` (same behavior, fewer lines). An installed ambient review skill *raises* this; it never lowers it.
- **Test-value lens** (floor, next to minimality): every test the diff adds must demonstrate an observable behavior, protect a business rule, verify a contract, exercise a real integration or prevent a known regression. Flag `overtest` for the ones that only mirror structure — a test per class or method, mocked call chains, the same happy path re-asserted at every layer, trivial getters/setters/mappers, cases written for coverage, broad snapshots where a functional assertion is clearer. Bounded by *Gate integrity*: `overtest` prunes redundancy, **never** a check that guards behavior, a trust boundary, security or accessibility.
- **Temporary simulation check** (only when the change carries one): stubs, fakes and in-memory adapters are **explicit and named as such** (`Stub…` / `Fake…`), they sit at the boundary the plan declares, and no configuration can select them in a production runtime. A simulation still active on the main path with no declared removal is a finding, not a detail.
- **Tooling check** (`docs/tools`): did the run create **reusable auxiliary tooling** (support scripts/CLIs/generators/reusable configs — not product code, not session probes)? → the host applies the **ambient `creating-tools` skill** (auto-discovered by its `description`; Workline does not bind it) so the tool gets its home under `docs/tools/<slug>/` (README + run/output structure per that skill's contract + its index row). Host without such a skill → the loop still **never writes `docs/tools` itself**: **declare the gap** — the homeless tool goes to the plan's `Open questions` + `BACKLOG` (in quick, `BACKLOG`) — never silent.
- **Findings**: **fix** them in the working tree and **re-run validation** (the gate does not replace the tests: it re-verifies after fixing), or **defer them justified** (→ the plan's `Open questions` + `BACKLOG`; in quick, `BACKLOG`); the non-obvious → `DECISION`. Gate integrity (see [`CHASSIS.md`](CHASSIS.md) § *Verification-first*): never weaken a check or lower a convention to pass.
- **Artifact-first + verification-first**: seed `CHECKPOINT.Next = "review <batch/task>"`; Success
  criteria require the whole diff to pass before commits.

## Location

Same as the chassis: code-editing loops reference it as `../CODE-POLICIES.md` — the `w/loops/` tree is installed intact on every host (chassis § *Reference resolution*).

## Conditional modules

- `db` — the DB scripts-only rule → `../modules/DB-SCRIPTS-ONLY.md`
