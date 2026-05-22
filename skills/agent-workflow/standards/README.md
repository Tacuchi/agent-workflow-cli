# standards/

Estándares técnicos universales (no doctrina del lifecycle, no específicos de empresa).

Contenido esperado (T2 PR2):

- `coding-standards.md` — estándares por stack (Java/Spring, Angular/TS, Node) + seguridad (sin secrets, SQL parametrizado, logging por nivel).
- `sql-mutation-guard.md` — patrón del hook que aborta SQL no parametrizado / DDL fuera de scripts/.
- `i18n-conventions.md` — convención EN-canon + ES-legacy aliases bilingües.
- `commit-style.md` — formato de commit messages compatible con el ecosistema.

Inyectables vía `profile.migrate_legacy_rules[]` cuando una empresa tiene estilos heredados.
