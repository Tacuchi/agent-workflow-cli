---
name: research
description: >
  On-demand investigation capability that loops compose when they need evidence to
  move forward. Investigates INLINE inside the active session (never creates a
  separate session): reads the workspace + associated repos + MCPs read-only,
  produces ANALYSIS-FILE → CONCLUSIONS inside that session. Concludes INCONCLUSIVE
  when the question cannot be answered with the available sources. Discriminates
  when to investigate ("can I answer by reading repo/data?") vs when to ask the
  human ("does it depend on what the user wants?").
---

# research — On-demand investigation capability

## Role

`research` — built-in default implementation. Rebindable to another skill (third-party or `off`) in `.workflow/skills.toml`.

## Purpose

Resolve factual questions about the system before acting: read the repo, trace data via read-only MCP, produce synthesized findings. **It creates no production artifacts** — it produces evidence and conclusions so the composing loop can move forward with quality information.

The key discriminator:

| The question... | Action |
|---|---|
| can be answered by reading repo / data (objective system facts) | **investigate** |
| depends on the user's preferences, priorities or decisions | **ask the human** via *structured-choice* (canonical rule: `../../loops/CHASSIS.md` § *Structured-choice*; per-harness binding: `../../harness/HARNESS.md`) |
| is partly in the repo and partly user intent | investigate first, then ask only about the uncertain part |

## Composed by

Every loop loads it on demand:

| Loop | When it composes it |
|---|---|
| `spec-refine-loop` | to understand the existing system before refining a spec |
| `plan-new-loop` | to discover dependencies, integrations, repo conventions |
| `plan-exec-loop` | to investigate a component's real behavior before modifying it |
| `quick-loop` | to answer orientation questions about the code or data |

## Knowledge

### Investigation lifecycle

```
[loop's question] → [investigate inline in the active session] → [collect evidence] → [synthesize] → [CONCLUSIONS]
                                                          ↕
                                               [new hypothesis or gap] → [more evidence or INCONCLUSIVE]
```

1. **Investigate inline** — no separate session is created; artifacts are written into the loop's active session (`.workflow/sessions/NNN-<run>/`).
2. **Collect evidence** — read-only: `Read`, `Grep`, `Glob`, MCP SELECT, `git log`.
3. **Write `ANALYSIS-FILE.md`** (optional scratchpad) with raw findings.
4. **Synthesize** into `CONCLUSIONS.md` with evidence-backed conclusions.
5. **Report to the loop**: `concluded` if it converges; `inconclusive` if there is not enough material — the loop degrades/defers the gap.

### Ask-vs-research discriminator (examples)

```
"what naming convention does this repo use?"     → investigate (Grep + Read)
"which endpoint does the spec need?"             → investigate (read spec + code)
"do you prefer approach A or B?"                 → ask the human
"what is the state of table X?"                  → investigate (read-only MCP)
"how urgent is this for you?"                    → ask the human
"does service Y already have auth implemented?"  → investigate (read code)
```

### Artifact schemas

`ANALYSIS-FILE.md` (optional scratchpad) and `CONCLUSIONS.md` follow the **canonical templates** in `artifacts/artifacts-research/` — never duplicated here, to avoid drift. Light research needs only `CONCLUSIONS.md`; `ANALYSIS-FILE.md` is optional for deeper investigations.

### DB rule (invariant #4)

- **SELECT only** — never DML/DDL.
- **Write the query first** into the active session's `SCRIPTS.sql` (type A, read-only; see the `artifacts/artifacts-core/SCRIPTS.sql` template) with its purpose + MCP + origin header.
- **With >1 candidate MCP and no declared default**: ask the human which to use before executing.
- **Cost guard before executing**:
  - `COUNT(*) ≤ 1,000` or PK lookup → run directly.
  - `1,000–10,000` rows or a small-table seq scan → tell the user the estimate.
  - `> 10,000` rows or a large-table seq scan → explicit user confirmation.
  - UPDATE/INSERT/DELETE → refuse.

### Code reading rules

- Use `Grep` and `Read` extensively. **Never** `Edit/Write` during investigation.
- Cite with path + lines: `src/services/Foo.java:142`.
- Scattered code: `Glob` + `Grep` to narrow down.

### Read-only git (git-safe, invariant #5)

Only: `git log`, `git show`, `git diff`, `git blame`, `git branch --show-current`.
Never during investigation: `commit`, `push`, `merge`, `rebase`, `reset`, `checkout`.

### Inconclusive closure

If, after investigating, gaps persist and cannot be closed with the available sources:

- Document the gaps in `CONCLUSIONS.md` (`## Details`) and tick `Defer (insufficient evidence)` in Recommended Action.
- Mark the investigation `inconclusive`.
- Report to the loop: what could and could not be resolved — the loop decides whether to ask the human.

### Inline research artifacts (in the active session)

```
.workflow/sessions/NNN-<run>/      # the loop's session (refine/exec/quick)
├── ANALYSIS-FILE.md    # raw findings (optional scratchpad)
├── CONCLUSIONS.md      # synthesis + recommendations for the loop
└── SCRIPTS.sql         # read-only SQL (type A), if MCP was used
```

## Output

Produces, **inline in the loop's active session** (`.workflow/sessions/NNN-<run>/`):

- `ANALYSIS-FILE.md` — raw, unsynthesized findings (optional).
- `CONCLUSIONS.md` — evidence-backed conclusions + recommendations for the loop.
- `SCRIPTS.sql` — read-only queries (type A), only if MCP was used.

It never graduates to `docs/` (invariant #1). The composing loop consumes the conclusions and acts on them.

## Source

Rationale and history: design (`docs/referencias/workflow-roles/`).
