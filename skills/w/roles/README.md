# roles/ — Capability role catalog

> Only Workline-owned capabilities are binding roles. Other skills are host-native help, never Workline dependencies.

---

## Capability catalog

The owned roles and their built-in defaults:

| Role | Default built-in | Tier | Composed by |
|---|---|---|---|
| `design` | [`design`](design/ROLE.md) | must | `spec-refine-loop` (when requirement involves UI) · `plan-new-loop` / `plan-refine-loop` · `plan-exec-loop` (reads, never redesigns) |
| `overview` | `w` | should | any loop (orientation about Workline itself) |

**Tiers:**
- `must` — core to almost every session; built-in always active unless explicitly `off`.
- `should` — loaded on-demand; active by default but lower priority to override.

> **Ambient help (not roles).** Code, testing, writing, SQL, Git, research, diagrams and tool authoring are available when the host exposes them. Workline does not bind, inventory, install or require them.
>
> **An external skill is a technique, never an authorization.** Host help cannot override Workline's gates, permissions, destinations or validated receipts. Its absence never blocks core flows; its mere presence never credits an improvement.
>
> **`ui-design` and `ui-spec` are retired names.** The design slot is [`design`](design/ROLE.md), whose only output is the UI Design Package v1. Neither retired name is a role, a binding, an alias or an implementation: they are **rejected**, because two names for one capability are two contracts in disguise. There is no alias, no dual-read, no importer and no migration — a binding that names one is reported as `retired/unsupported`, and a design that is still needed is recreated over the package.
>
> **The closing review is not a role either** (deliberate decision — a `conventions`/`rules`/`review` role was evaluated and discarded): the pre-commit **closing review gate** of `plan-exec-loop`/`quick-loop` is a **loop step**; the loop creates the **moment** and the installed ambient conventions fill it. A role that "points at the marketplace skills" would re-couple what this extraction decoupled. The **minimality / anti-over-engineering** lens is **not a role either**: it is a built-in property of the convergence gate (chassis § *Minimality*), owed with no external skill and merely *raised* by whatever ambient review skills are installed — internal essence without the coupling a role would reintroduce.

---

## Binding cascade

The CLI resolves which skill fulfills a role at compose-time using a 3-level cascade:

```
built-in default
    ↓  (overridden by, if present)
~/.workflow/skills.toml        (global — applies to all workspaces on this machine)
    ↓  (overridden by, if present)
.workflow/skills.toml          (workspace — applies only to this workspace)
```

**Resolution rules:**

1. **Owned role with a binding** → its canonical Workline skill name or `off` applies. Other names are warned as inapplicable, with the file left untouched.
2. **Role with no binding at any level** → use the built-in default (table above). No config needed for the common case.
3. **`off`** → capability disabled. The loop continues without it; if the task required it, the loop reports why it cannot proceed or asks the human.

**`design`** uses its built-in floor for required operations. A legacy replacement binding does not select a contributor or disable the floor; `off` follows the descriptor's per-operation policy. `[docs]` is independent and remains supported.

---

## skills.toml format

```toml
[skills]
# Built-in defaults (no entry needed — listed here for reference only)
# design           = "design"
# overview         = "w"

# Per-operation policy for an owned capability:
# design           = "off"
```

### Override: disable a capability

```toml
[skills]
design = "off"
```

The `design` descriptor decides operation by operation: validation retains its own floor while authoring operations are disabled.

---

## Inspecting resolved bindings

```bash
aw skills
```

Lists the resolved binding for every role in the current workspace, showing which level of the cascade provided it (built-in / global / workspace) and whether it is `off`.

Example output:

```
Role              Resolved skill          Source
----------------- ----------------------- -----------
design            design                  built-in
overview          w                       built-in
```

---

## Adding a new role

1. Define the role in this README (name, default built-in, tier, composed by).
2. Author the built-in skill under `roles/<name>/ROLE.md` following the schema.
3. Register it in the CLI resolver so `aw skills` lists it.
4. Document the binding key in the `skills.toml` reference above.

## Authoring a built-in skill

Each `ROLE.md` follows this schema:

| Section | Content |
|---|---|
| Frontmatter `name:` | kebab-case; MUST equal the binding name (`research`, `diagrams`, etc.) |
| Frontmatter `description:` | rich description: what + when; drives automatic selection |
| `## Role` | which capability role this implements (its skills.toml slot) |
| `## Purpose` | what it does |
| `## Composed by` | which loops/exports use it and when |
| `## Knowledge` | reusable know-how: vocabulary, rules, schema, examples |
| `## Output` | what it produces and where (if any) |
| `## Source` | recycled from (if applicable) |

See [`design/ROLE.md`](design/ROLE.md) as a reference implementation.
