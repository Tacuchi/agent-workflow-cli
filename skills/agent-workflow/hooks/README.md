# hooks/

Hooks que el host ejecuta automáticamente durante el ciclo de vida de una sesión. Distribuídos como templates; el CLI `agent-workflow self install --target <host>` los materializa con adapters por host (ver `src/application/self/install-hooks.ts`).

Contenido esperado (T2 PR2):

- `SessionStart.template.json` — carga `profile.json`, registra namespace, auto-copy profile si aplica.
- `PreCompact.template.json` — checkpoint-write antes de compactar contexto.
- `PostCompact.template.json` — resume-summary tras compactar.
- `sql-mutation-guard.template.json` — bloquea SQL no parametrizado / DDL en flujos de runtime.
- `branch-check.template.json` — gate de rama al entrar a execution.
- `git-commit-advisor.template.json` — recordatorio M1 ante intención de commit.
- `commit-prompt-universal.template.json` — disparo del prompt de cierre universal.

Cada template es agnóstico de host; los adapters lo traducen a `~/.claude/settings.json`, `~/.codex/config.toml`, etc.
