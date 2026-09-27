---
name: git
description: >-
  Git-safe capability — built-in default for the `git` role. Verifies the expected
  work branch per source before editing, proposes commits (one per source) and only
  commits when the user approves, and NEVER runs push, --amend, --no-verify, force,
  merge/rebase/cherry-pick, tags, or destructive resets without explicit user request.
  Read-only git (status/log/diff/branch) is always allowed. Use when a loop is about
  to edit code, when the user asks to commit / save / push changes, or to resolve an
  in-progress merge conflict (via /w:fix-git).
---

# git — git-safe capability

## Role

`git` — built-in default. Rebindable in `.workflow/skills.toml` (third-party skill or `off`). This skill encodes invariant 5: **safe git**.

## Purpose

Operate git in a **safe, controlled** way: verify the expected branch before editing, **propose** commits per source, and never run destructive or publishing operations without the user's explicit request.

## Composed by

- **`plan-exec-loop`** — verifies the branch before each edit; proposes commits on close/checkpoint.
- **`quick-loop`** — same, in the lightweight shortcut.
- **`/w:fix-git`** (transversal command) — composes the *Merge-conflict resolution* section to resolve an in-progress merge in any repo.

(Any flow that edits code, or any user commit request, uses it.)

## Knowledge

### Operations forbidden without an explicit user request

Closed list. The AI **never** runs them on its own initiative:

- `git commit` (includes `--amend`)
- `git push` (includes `--force` / `-f`)
- `git merge` · `git rebase` · `git cherry-pick`
- `git tag` (create or edit)
- `git reset --hard` · `git restore .` · `git checkout -- .` · `git clean -fd` · `git stash` (when there is uncommitted work)

And **always** forbidden, even when the user asks for a commit: `--no-verify` (respect the pre-commit hooks), `--force`, `Co-Authored-By` trailers, model signatures.

> **Exception — merge in progress:** resolving the conflicts of an **already started** merge (MERGE_HEAD), or one started at the user's **explicit** request via `/w:fix-git`, **is** allowed (it is an explicit request, not own initiative) — see *Merge-conflict resolution*.

### Read-only operations (always allowed, no asking)

`status` · `log` · `diff` · `branch --show-current` · `rev-parse` · `show`. `git checkout` (branch switch) is **not** read-only: it requires *structured-choice* (canonical rule: `../../loops/CHASSIS.md` § *Structured-choice*; per-harness binding: `../../harness/HARNESS.md`) even though it is not destructive (see branch verification).

### Branch verification (before editing)

The expected branch is **never assumed from the current branch** — the user may have switched it by hand. Verify before any `Write/Edit`: the session's isolation unit branch when it owns a unit (`aw worktree`); otherwise its document's own, inherited, or registered work branch (in that order). An unrelated unit does not block a document editing the shared checkout in its expected branch.

**Primary mechanism**: `aw check-branch --source <alias>` (or `--file <path-of-the-imminent-edit>`; `--strict` returns exit 2 on mismatch — useful as a gate). It returns the per-source fields already computed: `alias`, `path`, `main_branch` (base), `expected_work_branch`, `current_branch`, `match` (`current == expected`), `dirty` (uncommitted changes). **Fallback** (loose repo without workspace/CLI): compute them with direct read-only git (`git branch --show-current` + `git status --porcelain`) plus the session's declared branch.

Cases:

- **`match=true`** → OK, edit.
- **`match=false, dirty=false`** (Case A — different branch, clean repo) → *structured-choice*: `git checkout <expected>` / confirm `aw doc-branch set --doc <tipo:NNN> --source <alias> --rama <actual>` to use the current branch for this document / cancel.
- **`match=false, dirty=true`** (Case B — different branch + uncommitted changes) → **pause and wait for manual resolution**. Never propose checkout (it could lose work). Ask the user to commit/stash/discard and to say when to continue.
- **Cross-source (hub)**: `aw sources --code <NNN>` checks each source against its own expected branch; different branch names are fine when every source matches. Pause only the divergent sources.
- **Detached HEAD** → treat as Case A.
- **Source outside git** (`is_repo=false`) → report, do not block.

To request a document branch, first run `aw doc-branch show --code <NNN>` (or `--doc <tipo:NNN>`), ask the person to confirm or change its proposed name, then run `aw doc-branch set --code <NNN> --source <alias> --rama <nombre>`. No branch is registered just by showing a proposal.

Closing, releasing or reclaiming a unit preserves the document branch and its base. A later cleanup may remove only an `aw/*` unit branch already contained in that base (decision `S049/AC-10`); it never deletes either protected branch.

### Commits — propose-then-execute, one source at a time

On any commit request or trigger (loop close, "commit this", "save the changes"):

1. Resolve the sources and their dirty/branch state with `aw sources` (inventory with enriched git status; fallback: direct git per source).
2. With 1+ `dirty=true` sources, invoke **a single** *structured-choice* with one content question per dirty source (≤3 per call + `flow` control; N>3 → in batches):
   - Question header: the source's `alias`.
   - Options: "Approve suggested (Recommended)" with the canonical message / "Skip this source". `Other` = custom message.
3. Run `git -C <path> commit -m "<msg>"` only on the approved sources, **one at a time**. Respect hooks (no `--no-verify`).
4. If a source has `match=false` (branch differs from expected): **skip it and abort its commit**; ask to align the branch first.
5. If all are `dirty=false` → silent skip; report in chat that there is nothing to commit.

**Bypass** (Rule 5): if the user provides the exact literal message (`-m "..."`, quoted), commit directly without *structured-choice*, still validating branch, hooks and format. If the literal violates the format, warn before executing.

### Canonical message format

- **A single line**, short (≤72 chars suggested), descriptive (what changes, not how), written in the user's language.
- Include the active session code (`session<NNN>` as a tag or prefix) when it applies.
- Conventional Commits prefix **optional** (`feat:` `fix:` `docs:` `chore:` `refactor:` `test:`).
- **Forbidden**: multi-line/body, `Co-Authored-By` trailers, model signatures, emojis (unless explicitly requested), `--no-verify`.

Valid:
```
session007: agrega politica de commits controlados
feat(session012): nuevo export-scripts
fix(session018): corrige drift en hooks.json
```

Outside an active session: relax to "1 line + no co-author"; the `session<NNN>` tag is omitted. Propose-then-execute stays active.

### Merge-conflict resolution

Autonomous `git merge` is forbidden (above), **but** resolving an **in-progress** merge (MERGE_HEAD), or one invoked by the user via `/w:fix-git`, **is** sanctioned work. **Workspace-agnostic**: it operates on any repo (no `.workflow/`, flows or sessions required).

**The mechanics live in the CLI** (`aw fix-git prepare | apply | commit`); what follows is the reasoning it expects from you. Never edit a conflicted file, `git add` or `git commit` by hand here — see [`../../commands/fix-git.md`](../../commands/fix-git.md) for the exact invocations.

1. **Detect + identify**: `aw merge-state` reports unreadable sources and units, never "no merge" when they could not be inspected. `aw fix-git prepare` (read-only) summarizes each conflict's path, `kind`, binary, bytes, EOL, allowed resolutions and max bytes; it warns about multiple merge bases (virtual base). It seals the index-stage hashes but does not ship the full contents by default. Repeat `--show <path>` for each file whose three versions are needed. `--adapt <path>` includes a tracked file merged cleanly but needing a semantic adjustment, including after all conflicts were resolved while MERGE_HEAD remains.
2. **Analyze intent** before resolving — never pick a side blindly. With `--show` read `base` (ancestor), `ours` (destination), `theirs` (origin). Add `git log --merge -p -- <file>` when the *why* of a hunk is not evident, and read adjacent code for coherence.
3. **Resolve** with a complete text `{path,content}` without conflict markers, or a `resolution` `{path,choice}` where `choice` is `ours`, `theirs` or `delete`. A binary takes the intact `ours`/`theirs` blob via the CLI; absent stage → `delete`. Apply a subset and repeat prepare/apply for the remaining files. The CLI updates the index with Git plumbing and checks out with repo attributes/EOL, with no hand-run `git add` or `git checkout`.
4. **Ask** (*structured-choice*) when intent is ambiguous or both sides are incoherent: answer `state: "ambiguous"`, ask one content question per doubtful file/hunk (≤3 + `flow` control), with consequences for each option. Never guess. A binary is not an exception to the intent rule — choosing `ours`/`theirs` still needs evidence.
5. **Proposed commit**: `aw fix-git commit --message "<msg>"` without `--confirm` previews the message, build, included files and `left_out`. After approval repeat with `--confirm` and a **long host timeout**: it runs the versioned source build in the merge repo and refuses failed/undeclared builds or unmerged files. `ninguno` or `--skip-build "<motivo>"` is explicit and visible with its origin; the result also warns if build ran on a tree different from the commit. Never hand-run `git commit`, `--no-verify`, `--amend` or push.
6. **Escape hatch**: if the merge must not complete, `git merge --abort` **after user confirmation** (*structured-choice*) — leaves the repo as before the merge.

> **Resume via git**: the merge state in `.git` (MERGE_HEAD + index) **is** the checkpoint; re-running `/w:fix-git` resumes from the remaining conflicts. No session, no artifact.
> **Rebase / cherry-pick**: out of v1 (same marker resolution; different `--continue` / `REBASE_HEAD`).

## Output

Nothing in `docs/`. It produces commits **only** when the user approves, in the source repos. Branch verification may update the session's branch expectation if the user picks that.

## Source

Rationale and history: design (`docs/referencias/workflow-roles/`).
