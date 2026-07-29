---
description: Use when a merge left conflicts to resolve. Backed by `aw fix-git`, which reads the three versions of each conflict, validates the semantic resolution and stages only files still in conflict. You supply the resolved content; the CLI decides which paths stay authorized and owns edit, stage and commit. Git-safe — the merge commit is a separate confirmed action, never push/--amend/--no-verify. Transversal (not a flow), no session, never touches docs/.
argument-hint: "[--source <alias> | --path <ruta>]"
allowed-tools:
  [
    "Bash",
    "Read",
  ]
---

# fix-git — merge-conflict resolver (transversal)

Single-pass, **no loop, no session**, **never writes `docs/`**. **Workspace-agnostic**: any git repo, with or without `.workflow/`. User-facing output in the **user's language**.

> **Hard floor — applies even if you read nothing beyond this file:**
>
> 1. **You supply content; the CLI owns the effects.** Never edit a conflicted file, never `git add`, never `git commit` by hand — `Edit` is deliberately not in `allowed-tools`.
> 2. **Only unambiguous resolutions.** Anything you cannot resolve on evidence is `state: "ambiguous"`, which the CLI turns into a question. Never guess a side.
> 3. **The commit is a separate action**, always confirmed, and the message is proposed to the user first. Never `--no-verify`, `--amend` or push.
> 4. **Never `git merge --abort` on your own** — propose it; the user decides.

## Run

1. `aw fix-git prepare --format human [--source <alias> | --path <ruta>]` (`--detail` prints the response contract and the request size). Returns the merge direction (`theirs → ours`), the conflicted paths, their three index stages and their blob hashes.
2. **Resolve each conflict from the three versions the request carries** — `base` (common ancestor), `ours` (HEAD) and `theirs` (the incoming branch). Read both sides' *intent*, not just their text: `ours`, `theirs`, a combination, or a rewrite that preserves both intents.
3. Compose one JSON answer: `version`, `operation` and `input_digest` copied verbatim; `state: "proposed"`; `artifacts` with **one `{ path, content }` per conflicted file**, `content` being the complete resolved file with **no conflict markers**.
   - Any file you cannot settle on evidence → `state: "ambiguous"` with `reason`. Nothing is written; present the choice to the user.
   - A binary conflict is rejected by the CLI: propose `git checkout --ours|--theirs` to the user instead.
4. `echo '<json>' | aw fix-git apply --format human [--source …]`. The invocation authorizes the write **because** the set is unambiguous and still current — a conflict another process resolved meanwhile fails as stale.
5. **Propose the merge commit** to the user (canonical one-line format). On approval:
   `aw fix-git commit --message "<mensaje>" --confirm [--source …]`.

Every rejection names its cause and one valid next action; nothing was written. Fix the answer and repeat from step 4.

> **No merge in progress?** If the user explicitly asked to merge a branch, run `git -C <path> merge <branch>` and continue. Otherwise report there is nothing to resolve and stop.

## What the CLI decides (do not re-derive)

- **Which paths are writable**: exactly the files still unmerged. A path outside that set is rejected, not silently skipped.
- **Whether the conflict is still yours**: the blob hashes seal the set; if it moved, `apply` fails stale instead of overwriting someone else's resolution.
- **Whether the content is really resolved**: leftover `<<<<<<<` / `=======` / `>>>>>>>` is a rejection.
- **Whether the merge can close**: `commit` refuses while any file stays unmerged.

## Plan mode

Run `aw fix-git prepare` (read-only), report **origin ↔ destination** and the per-file conflicts, and describe the resolution you would propose — without applying or committing.

## Resources

- CLI: `aw fix-git prepare | apply | commit` (service `fix-git-service` over `semantic-operation/`) · `aw merge-state` (read-only inspector)
- Reference: `../roles/git/ROLE.md` § *Merge-conflict resolution* — the reasoning about intent; the mechanics now live in the CLI
- Design reference: `docs/referencias/workflow-skills/fix-git.md`
