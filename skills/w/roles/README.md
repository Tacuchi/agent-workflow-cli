# roles/ — Capability role catalog

> Built-in default implementations of the **capability roles** that loops and exports compose.
> A role is a slot in the system; a skill is one concrete implementation of that slot.
> Changing implementation = changing one line in `skills.toml`.

---

## Capability catalog

All 6 roles, their built-in defaults, their tier, and which loops/exports compose them:

| Role | Default built-in | Tier | Composed by |
|---|---|---|---|
| `ui-design` | [`ui-spec`](ui-spec/SKILL.md) | must | `spec-refine-loop` (when requirement involves UI) |
| `sql` | `sql` | must | inline research · `plan-exec-loop` · `quick-loop` · `export-scripts` |
| `git` | `git` | must | `plan-exec-loop` · `quick-loop` |
| `research` | [`research`](research/SKILL.md) | should | all loops (on-demand investigation) |
| `diagrams` | [`diagrams`](diagrams/SKILL.md) | should | `export-diagrams` |
| `overview` | `workflow` | should | any loop (orientation about the workflow itself) |

**Tiers:**
- `must` — core to almost every session; built-in always active unless explicitly `off`.
- `should` — loaded on-demand; active by default but lower priority to override.

> **Convenciones ambientes (no roles).** Los estándares de código, testing, redacción **y la creación de herramientas** (`creating-tools`) **no son roles** del workflow ni se bindean: son **skills standalone que el host auto-descubre por su `description`** y aplica cuando son relevantes. El workflow es **indiferente** (no las lee ni las busca). Familias útiles viven en plugins del marketplace (`dev-conventions`, `tool-builder`), pero el workflow **no depende** de ellos.

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

1. **Role with a binding** (workspace, or global if not workspace) → use that skill name.
   - If the name exists under `roles/<name>/` → it is a built-in skill.
   - If not → it is a third-party skill installed by name on the host (e.g. via skills.sh).
2. **Role with no binding at any level** → use the built-in default (table above). No config needed for the common case.
3. **`off`** → capability disabled. The loop continues without it; if the task required it, the loop reports why it cannot proceed or asks the human.

---

## skills.toml format

```toml
[skills]
# Built-in defaults (no entry needed — listed here for reference only)
# ui-design        = "ui-spec"
# sql              = "sql"
# git              = "git"
# research         = "research"
# diagrams         = "diagrams"
# overview         = "workflow"

# Override examples:
ui-design        = "acme/figma-spec"    # third-party skill installed via skills.sh
diagrams         = "mermaid-only"       # custom built installed locally
sql              = "off"                # disable the sql capability
```

### Override: point to a third-party skill

```toml
[skills]
ui-design = "acme/figma-spec"
```

`acme/figma-spec` must be installed on the host (e.g. via `skills.sh install acme/figma-spec`). The binding is **advisory**: the resolver emits the name as-is — it does **not** verify the skill is installed and does **not** auto-fall-back to the built-in default. A typo'd name silently leaves the role bound to a skill that does not exist. Verify the resolution with `aw skills`, which warns when a bound skill is not found in the standard skill roots.

### Override: disable a capability

```toml
[skills]
sql = "off"
```

The loop that composes `sql` will skip it. If the task required the capability and the role is `off`, the loop should inform the human and ask how to proceed.

### Override: use a different built-in

```toml
[skills]
diagrams = "diagrams-lite"   # if a "diagrams-lite" built-in were registered
```

Only meaningful if multiple built-ins for the same role are registered. Currently each role has exactly one built-in default.

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
ui-design         ui-spec                 built-in
sql               sql                     built-in
git               git                     built-in
research          research                built-in
diagrams          mermaid-only            global      (~/.workflow/skills.toml)
overview          workflow                built-in
```

---

## Adding a new role

1. Define the role in this README (name, default built-in, tier, composed by).
2. Author the built-in skill under `roles/<name>/SKILL.md` following the schema.
3. Register it in the CLI resolver so `aw skills` lists it.
4. Document the binding key in the `skills.toml` reference above.

## Authoring a built-in skill

Each `SKILL.md` follows this schema:

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

See [`research/SKILL.md`](research/SKILL.md) as a reference implementation.
