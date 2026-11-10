---
description: Use to mark a spec or plan as abandoned for good. `aw discard` previews the state change and writes `abandoned` into the document on one approval; nothing is deleted and no other document is touched.
argument-hint: "<spec:NNN | plan:PPP | ruta>"
allowed-tools: ["Bash", "Read"]
---

# discard — mark a spec or plan abandoned

No loop. Output in the **user's language**.
`aw context-plan --command discard --root "${CLAUDE_PLUGIN_ROOT}/skills/w"` resolves this guide.

**Hard floor:**

1. **`prepare` first, always** — read-only: `aw discard prepare <target>` returns the
   current state, `abandoned` as the new one, the live plans of a spec it leaves
   untouched, and the **digest**.
2. Show that preview and ask approval with structured-choice.
3. **Apply only with that digest** — `aw discard apply <target> --approval <digest>`.
   A document changed since the preview is refused with `DOC_CHANGED_SINCE_READ`:
   prepare again.
4. **Nothing is deleted** — the document keeps its number and every reference to it;
   the spec of a discarded plan and the plans of a discarded spec keep their state.
5. **Reverting is git's** — to bring a document back, `git revert` or `git restore`
   it; the CLI has no reverse step.

The report says what changed state, what was left untouched and the commit to
propose (`aw flow propose-commit --source hub --path <document>`).
