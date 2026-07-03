---
description: Resolves the conflicts of an in-progress merge for a given or detected source. Identifies origin (theirs) and destination (ours), analyzes both sides' intent and resolves; asks (structured-choice) on ambiguity or incoherence. Git-safe — proposes the merge commit, never push/--amend/--no-verify. Transversal (not a flow), no loop, no session, never touches docs/. Works in any git repo, no initialized workspace required.
argument-hint: "[<source path | alias>]"
allowed-tools:
  [
    "Bash",
    "Read",
    "Edit",
  ]
---

# fix-git — merge-conflict resolver (transversal)

Single-pass, **no loop, no session**, **never writes `docs/`**. **Transversal** command (belongs to no SPEC / PLAN / QUICK flow). **Workspace-agnostic**: operates on any git repo — the given `<source>` (path or alias), or the cwd — without requiring `.workflow/`.

## Run

1. **Detect + identify** — run `aw merge-state [<source>]` (read-only; `--source <alias>` or `--all` when a workspace exists; a direct path otherwise). From the JSON, per repo: `is_merging`, `current_branch` (**destination / ours**), `merge_origin` (**origin / theirs**), `conflicted_files`.
   - If **no merge is in progress** (`is_merging:false`) and the user named a **target** (e.g. "merge `<branch>`"): that is an explicit request → `git -C <path> merge <branch>` and continue. No target → report there is no merge to resolve and stop.
2. **Resolve** — **read and follow** the ***Merge-conflict resolution*** section of the `git` role (`../roles/git/SKILL.md`): analyze each conflict's intent (3 versions `git show :1:/:2:/:3:<file>`, `git log --merge`), resolve (ours / theirs / combine / rewrite) and `git add` what is resolved. On **ambiguity or incoherence**, ask via *structured-choice* (never invent the resolution).
3. **Close** — **propose** the merge commit (propose-then-execute, canonical format, git-safe). Escape hatch: `git merge --abort` after user confirmation.

> Do not try `Skill: git` — the role is **read and followed** (it is the capability this command composes). The command **is** the entry; the conflict doctrine lives in the `git` role.

## Plan mode

Run `aw merge-state` (read-only), report **origin ↔ destination** and the per-file conflicts, and describe the **resolution strategy** you would apply — **without** editing files or committing.

## Resources

- Capability: `../roles/git/SKILL.md` (section *Merge-conflict resolution*)
- CLI: `aw merge-state` (read-only merge-state inspector)
- Design reference: `docs/referencias/workflow-skills/fix-git.md`
