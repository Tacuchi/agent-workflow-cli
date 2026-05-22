# M7 — refactor-legacy-detected (rename Strangler en skill `refactor`)

Spec literal del prompt M7. Index: [`../prompts-catalog.md#m7--refactor-legacy-detected-rename-strangler-en-skill-refactor`](../prompts-catalog.md#m7--refactor-legacy-detected-rename-strangler-en-skill-refactor).

- **Cuándo**: en `qtc-dev/skills/refactor` después de completar la sección "Análisis legacy" de REFACTOR.md y antes de tocar paths.
- **Forma**: 1 question + preview con file tree antes/después.
  - `header`: `legacy`.
  - `question`: "Detecté feature `<nombre>` en `<path>`. ¿Cómo procedemos con el rename Strangler?"
  - `multiSelect`: false.
  - `options`:
    1. "Rename + AI actualiza imports (Recomendado)" — "`git mv <path> <path>-legacy/` y la AI actualiza imports/módulos automáticamente. Diff por archivo antes de aplicar."
    2. "Solo rename, yo actualizo imports vía IDE" — "Ejecuta `git mv` y deja imports rotos para que los resuelvas con refactor del IDE; la build fallará hasta que migrés. Más seguro en codebases grandes."
    3. "Solo análisis, no tocar paths" — "REFACTOR.md queda como artefacto exploratorio (`status: discovery`); útil si querés decidir el rename después o si el refactor se promovió desde un análisis."
  - **Other auto** = path/nombre custom para el legacy (ej. `<path>-v0` en lugar de `<path>-legacy`).
- **Preview** (sugerido): file tree ASCII before → after, recortado a 10 líneas:

  ```
  src/app/admin/                src/app/admin/
  ├── categorias/         →     ├── categorias/         (vacía, Phase 0 stub)
  │   ├── *.module.ts           ├── categorias-legacy/
  │   ├── *.service.ts          │   ├── *.module.ts
  │   └── *.component.ts        │   ├── *.service.ts
  └── ...                       │   └── *.component.ts
                                └── ...
  ```

- **Si match=false en alguna fuente afectada**: omitir el rename y pedir alinear ramas primero (coherente con `branch-verification.md`).
- **Refina**: paso "Marcar legacy" en `qtc-dev/skills/refactor/SKILL.md`.
