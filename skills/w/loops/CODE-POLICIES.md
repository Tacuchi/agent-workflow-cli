# CODE-POLICIES — policies for code-editing loops

They apply to **`plan-exec-loop`** (per effective batch) and **`quick-loop`** (the single task;
**proportional** gate), read with the chassis. They own the DB scripts-only, Git unit and
closing-review invariants.

## Git within a flow — verified branch + approved exact-path commits

Sources are edited on a **verified** branch (`aw check-branch`), and commits are
**proposed**: in plan-exec the CLI commits only the batch's approved paths once per source; in quick
the task closes with one proposed commit. Branch switches need consent. A **rejected** commit leaves the changes in the tree and the unit
recorded as uncommitted in `CHECKPOINT` and `BACKLOG`. Between units each working tree is clean or
explicitly acknowledged; a `continuous` batch is the narrow exception that intentionally co-mingles
its internal phases in one reviewed commit, and no batch may co-mingle with another.

Concurrent flows declare sources. By default a run writes in an **isolation unit** per source (a worktree on its own branch, `aw worktree ensure | list | release`); an edit outside is blocked naming the command that gets one. At close the CLI integrates each unit; a conflict stays pending for external resolution, never aborted.
An in-place workspace declares `Modo de edición: in-place`; a plan may override it with `> Aislamiento: unidad`. In-place declares and approves only its own paths against the acquisition snapshot, without integration.

For frontend sources, install dependencies (`npm ci` if the lockfile changes) inside each acquired unit: `node_modules` belongs to that worktree, never to a sibling checkout.

> **When the branch is verified, when a commit becomes available and what an approval covers:** `aw flow` decides. Approving is the person's act and committing is a separate effect that comes back as the units' own git state — which is what makes "the checks passed" impossible to assert without having run them.

## Closing review gate (conventions, pre-commit)

After validation and before commits, the whole execution-unit diff passes a **closing review
gate**: an effective batch in plan-exec, or the proportional task in quick. Early `Cerrar` uses the
same gate before any pending commit.

- **Independent re-read** of the diff — the engine's *independent verification*: it does not assume the implementation is correct; *only command output counts*. In `quick` a subagent reviewer is optional; `plan-exec` requires a distinct one (its Delta 5).
- **Apply the installed ambient conventions** relevant to the touched stack (code/stack standards, security, diff review, the workspace's own families) — the host **auto-discovers them by `description`**. Workline **names and binds no** concrete conventions skill: **it creates the moment; the installed skills fill it** (that is why review is **not a role** — see [`../roles/README.md`](../roles/README.md)). With no convention skills installed → minimal generic checklist: SOLID/early-return, clear names, DRY, no silenced errors, no secrets/PII, parametrized SQL, no dead code, + the plan's `Validations` (if any).
- **Minimality lens** (floor — holds with **no external skill**; chassis § *Minimality*): re-read the diff for over-building. Flag `delete` (dead/speculative code), `stdlib` (reinvented standard library), `native` (a dep or code doing what the platform already does), `yagni` (one-implementation abstraction, config nobody sets, one-caller layer), `shrink` (same behavior, fewer lines). An installed ambient review skill *raises* this; it never lowers it.
- **Test-value lens** (floor, next to minimality): every test the diff adds must demonstrate an observable behavior, protect a business rule, verify a contract, exercise a real integration or prevent a known regression. Flag `overtest` for the ones that only mirror structure — a test per class or method, mocked call chains, the same happy path re-asserted at every layer, trivial getters/setters/mappers, cases written for coverage, broad snapshots where a functional assertion is clearer. Bounded by *Gate integrity*: `overtest` prunes redundancy, **never** a check that guards behavior, a trust boundary, security or accessibility.
- **Temporary simulation check** (only when the change carries one): stubs, fakes and in-memory adapters are **explicit and named as such** (`Stub…` / `Fake…`), they sit at the boundary the plan declares, and no configuration can select them in a production runtime. A simulation still active on the main path with no declared removal is a finding, not a detail.
- **Tooling check** (`docs/tools`): reusable support scripts/CLIs/generators/configs (not product code or session probes) belong under `docs/tools/<slug>/`, with README, run/output structure and an index row in `docs/tools/README.md`. Review their usability and evidence before closing. Any host help is optional, from any origin; its absence never defers the tool.
- **Findings**: **fix** them in the working tree and **re-run validation** (the gate does not replace the tests: it re-verifies after fixing), or **defer them justified** (→ the plan's `Open questions` + `BACKLOG`; in quick, `BACKLOG`); the non-obvious → `DECISION`. Gate integrity (see [`CHASSIS.md`](CHASSIS.md) § *Verification-first*): never weaken a check or lower a convention to pass.
- **Artifact-first + verification-first**: seed `CHECKPOINT.Next = "review <batch/task>"`; Success
  criteria require the whole diff to pass before commits.

**Close first.** Before the commit run validations and review, not exploration. After integration,
report only what the CHECKPOINT actually owes. On a separate line offer an optional parallel
follow-up, not a next action or pending item: probe only if the user asks. Its agents never modify
the delivered work or commit; each finding returns as a ready `/w:quick` without reopening the
closed document or session. A host without subagents runs it inline.

## Conditional modules

- `db` — the DB scripts-only rule → `../modules/DB-SCRIPTS-ONLY.md`
