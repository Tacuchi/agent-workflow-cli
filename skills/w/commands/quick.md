---
description: Lightweight shortcut for scoped work (fix, tweak, chore) that warrants no spec or plan. Starts quick-loop. Never touches docs/. If the objective exceeds a quick or the task grows, it escalates — to SPEC live (with consent), to PLAN deferred.
argument-hint: <prompt with the scoped task>
allowed-tools:
  [
    "Bash",
    "Read",
    "Write",
    "Edit",
  ]
---

# quick — trampoline to the lightweight loop

For scoped, direct tasks that do not justify going through SPEC or PLAN. Creates a light session (traceability + resume) — unless the **entry size gate** escalates to SPEC before starting. Delegates to `quick-loop` (Layer 2).

## Run the loop

`quick-loop` is **not** a skill invocable by name — it is this command's operating manual (a sibling doc in the bundle). **Load it and execute it end to end**:

1. **Read** `../loops/quick-loop/SKILL.md` (inside the installed `w` skill — e.g. `~/.claude/skills/w/loops/…`).
2. **Follow** its instructions taking `$ARGUMENTS` as the task: it evaluates the size gate, creates the light session, works with minimal ceremony (git-safe), escalates if the task exceeds or grows (SPEC live / PLAN deferred), and reports.

> Do not try `Skill: quick-loop` — it is not registered as a skill. The command **is** the entry; the loop is its body.

## What the loop does

- Edits code in the workspace sources.
- Minimal session artifacts (lazy DECISION, proposed commit).
- **Proportional closing review gate** before proposing the single commit: re-reads the diff applying the installed ambient conventions and fixes or defers (see `../loops/quick-loop/SKILL.md` § *Sequence*).
- **Never touches `docs/`** and exports nothing.
- **Escalates** when complexity emerges — **entry size gate** (before creating the session) and mid-loop (many files, ≥2 sources, needs architecture, or the change is a feature/refactor). Accepting **SPEC** = **live** transition into the SPEC flow (draft via the spec-new procedure + spec-refine-loop); **PLAN** stays seeded for later. See `../loops/quick-loop/SKILL.md` § *QUICK delta*.

## Plan mode

The skill describes the changes it would apply and the files it would touch, without executing them. Escalation included: if the gate (entry or mid-loop) would fire, it describes it (options + the spec it would materialize) without writing `docs/` or starting loops.

## Resources

- Loop skill: `../loops/quick-loop/SKILL.md`
- Design reference: `docs/referencias/workflow-commands/quick.md`
