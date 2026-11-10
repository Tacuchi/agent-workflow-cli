---
description: Use for hub knowledge and recoverable archives with approval; not conversation compaction.
argument-hint: "[inspect <id> | restore <id>]"
allowed-tools: ["Bash", "Read"]
---

# hub-compact

No flow; only `docs/` specs and plans are inventoried. Use the user's language; read `aw hub-compact --help`.
`aw context-plan --command hub-compact --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` resolves this guide.

1. Run `aw hub-compact inventory --json`; explain coverage, exclusions, protections and limitations before synthesis.
2. Read sources selectively. Only historical specs and plans are eligible; use current originals, not summaries.
3. Draft this JSON in conversation or host temporary storage:

```json
{
  "version": 1,
  "inventory_fingerprint": "<inventory.fingerprint>",
  "claims": [{"topic": "History", "kind": "pending-validation",
    "text": "Awaiting verification.", "references": ["docs/plans/001-plan-example.md"]}],
  "selection": []
}
```

`kind`: `fact`, `decision`, `hypothesis`, `contradiction`, `pending-validation`, `pending-work`.
Require references for every claim and both sources for contradictions. Preserve their kinds and uncertainties.
Select only `eligible` paths; `[]` permits synthesis alone. References prove provenance, not semantic truth.

4. Run `aw hub-compact prepare --input-json - --json` on stdin.
5. Show `view`, `originals`, catalog, `local.preview`, effects and retention policy; explain any `docs/context/hub.md` replacement.
6. Ask approval of `local.digest`: **Aprobar y aplicar** (recommended), **Pedir ajustes**, **Cancelar**. Silence applies nothing.
7. After approval, run `aw hub-compact apply --input-json - --approval <local.digest> --json` with identical input. Stale sources require a new preview and approval.
8. Run `aw hub-compact inspect <id> --json`. Add `--path <original>` for bounded `content_base64`; restore larger originals.
9. Report progress, exclusions, retained originals and net savings including catalog cost. Separate context bytes; tokens are unmeasured. Show negative savings.

For interruption, inspect and retry the approved input; report corruption and changed sources.
`aw hub-compact restore <id> [--path <original>] --json` previews restoration; repeat `--path` for several originals.
Show paths, conflicts, preserved view and digest; ask approval before `--approval <digest>`. Preserve later destinations; ask about conflicts.
Reads never restore. No AI provider, tools, MCP, Git or SQL effects required.
