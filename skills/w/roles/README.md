# roles/ — Workline orientation

The only Workline-owned binding role is `overview`, fulfilled by the bundled `w` skill. It is available to any loop when orientation is useful. The CLI resolves this binding from its built-in default, then `~/.workflow/skills.toml`, then `.workflow/skills.toml`. The canonical value `w` or `off` applies; unrelated names are reported without changing the file. `[docs]` has its own cascade.

```toml
[skills]
# overview = "w"  # built-in default
```

`aw skills` lists the effective binding and source. Previous bindings for retired capabilities are inert and do not select, validate or credit a host skill.

## Host help

Code, testing, writing, UI, SQL, Git, research, diagrams and tool authoring may come from whatever the host exposes. Workline does not bind, inventory, install or require that help. A host contribution is ordinary input subject to the flow's existing permissions, destinations, approvals and validation. In SPEC, a functional UI choice and its reason belong in `## Decisions`; observable effects go to criteria and scenarios as appropriate.

The code loops' closing review is a loop step, not a binding role. Minimality is part of the convergence gate even with no installed convention skill.
