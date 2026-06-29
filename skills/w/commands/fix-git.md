---
description: Resuelve conflictos de un merge en curso para una fuente dada o detectada. Identifica origen (theirs) y destino (ours), analiza la intención de ambos lados y resuelve; pregunta (structured-choice) ante ambigüedad o incoherencia. Git-safe — propone el commit de merge, nunca push/--amend/--no-verify. Transversal (no es flow), sin loop ni session, no toca docs/. Funciona en cualquier repo git, sin workspace inicializado.
argument-hint: "[<source path | alias>]"
allowed-tools:
  [
    "Bash",
    "Read",
    "Edit",
  ]
---

# fix-git — resolvedor de conflictos de merge (transversal)

Single-pass, **sin loop ni session**, **no escribe en `docs/`**. Comando **transversal** (no pertenece a SPEC / PLAN / QUICK). **Agnóstico al workspace**: opera sobre cualquier repo git — el `<source>` dado (path o alias), o el cwd — sin requerir `.workflow/`.

## Ejecutar

1. **Detectar + identificar** — corré `aw merge-state [<source>]` (read-only; `--source <alias>` o `--all` si hay workspace; un path directo si no). Del JSON, por repo: `is_merging`, `current_branch` (**destino / ours**), `merge_origin` (**origen / theirs**), `conflicted_files`.
   - Si **no hay merge en curso** (`is_merging:false`) y el usuario indicó un **target** (p.ej. "merge `<branch>`"): es pedido explícito → `git -C <path> merge <branch>` y seguí. Sin target → informá que no hay merge que resolver y terminá.
2. **Resolver** — **leé y seguí** la sección ***Resolución de conflictos de merge*** del rol `git` (`../roles/git/SKILL.md`): analizá la intención de cada conflicto (3 versiones `git show :1:/:2:/:3:<file>`, `git log --merge`), resolvé (ours / theirs / combinar / reescribir) y `git add` lo resuelto. Ante **ambigüedad o incoherencia**, preguntá vía *structured-choice* (no inventes la resolución).
3. **Cerrar** — **proponé** el commit de merge (propose-then-execute, formato canónico, git-safe). Escape: `git merge --abort` tras confirmación del usuario.

> No intentes `Skill: git` — el rol se **lee y se sigue** (es la capacidad que este comando compone). El comando **es** la entrada; la doctrina de conflictos vive en el rol `git`.

## Plan mode

Corré `aw merge-state` (read-only), reportá **origen ↔ destino** y los conflictos por archivo, y describí la **estrategia de resolución** que aplicarías — **sin** editar archivos ni commitear.

## Resources

- Capability: `../roles/git/SKILL.md` (sección *Resolución de conflictos de merge*)
- CLI: `aw merge-state` (inspector read-only del estado de merge)
- Design reference: `docs/referencias/workflow-skills/fix-git.md`
