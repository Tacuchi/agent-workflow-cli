# Catálogo de patrones de code-scan + recomendaciones

> **Port directo** de `agent-workflow/skills/release/references/code-scan-patterns.md` v2.0.0. DEC-004 de session061: el contenido es idéntico al original. Si Fase 2 remueve `release`, este archivo queda como canónico.

## Patrones built-in del CLI `agent-workflow code-scan`

| ID | Severidad | Patrón | Recomendación |
|---|---|---|---|
| `LOCALHOST` | media | `http://localhost`, `127.0.0.1`, `0.0.0.0` literal | Reemplazar por env var o configuración por ambiente. |
| `IP_LITERAL` | media | IP estática IPv4 en código (excepto `127.0.0.1` ya capturado) | Mover a configuración externa. |
| `TODO` | baja | `TODO`, `FIXME`, `XXX`, `HACK` en comentarios | Resolver antes de release o documentar deuda técnica. |
| `HARDCODED_SECRET` | alta | strings con `password=`, `api_key=`, `secret=`, tokens base64 largos | Mover a env var o gestor de secretos. Si fue commiteado: **rotar la credencial**. |
| `CONSOLE_LOG` | baja | `console.log`, `console.debug`, `print()`, `System.out.println` en código de producción | Eliminar o reemplazar por logger por nivel. |

## Patrones extendidos (opt-in vía `--pattern`)

| ID | Severidad | Patrón | Recomendación |
|---|---|---|---|
| `SQL_INJECTION` | alta | string concatenation en construcción de SQL | Usar prepared statements / query parameters. |
| `DEPRECATED_API` | baja | uso de APIs marcadas deprecated en deps actuales | Migrar antes del próximo upgrade mayor. |
| `MAGIC_NUMBER` | baja | literal numérico sin constante con nombre | Extraer a constante con nombre descriptivo. |
| `TODO_FECHADO` | media | `TODO(YYYY-MM-DD)` con fecha pasada | Resolver — la deuda venció. |

## Override de patrones

Pasar al CLI:

```bash
agent-workflow code-scan --pattern "SQL_INJECTION:string\.format.*SELECT:high" \
                         --pattern "DEPRECATED_API:@Deprecated:low"
```

O archivo de patterns:

```json
{
  "patterns": [
    { "id": "CUSTOM_RULE", "regex": "...", "severity": "medium", "recommendation": "..." }
  ]
}
```

## Excludes y extensiones

Default excludes: `node_modules/`, `target/`, `dist/`, `build/`, `.workflow/`, `docs/`, `tests/`, `test/`, `.git/`, `__pycache__/`, `.idea/`, `.vscode/`.

Default extensions: `.java`, `.ts`, `.js`, `.py`, `.go`, `.rb`, `.php`, `.cs`, `.kt`, `.scala`, `.vue`, `.tsx`, `.jsx`, `.properties`, `.yml`, `.yaml`, `.json`, `.xml`, `.sql`.

Override:

```bash
agent-workflow code-scan --exclude vendor/,third_party/ --ext .java,.ts,.kt
```

## Output del CLI

```json
{
  "matches": [
    {
      "pattern_id": "HARDCODED_SECRET",
      "severity": "high",
      "file": "src/main/java/com/example/Config.java",
      "line": 42,
      "snippet": "password = \"...\"",
      "recommendation": "Mover a variable de entorno o gestor de secretos. Rotar la credencial si fue commiteada."
    }
  ],
  "counts": { "high": 1, "medium": 3, "low": 12 },
  "by_severity": { ... },
  "total_matches": 16
}
```

## Integración con el manifest

El skill `export-scripts` consume este output y lo presenta en §5 del `manifest.md`:
- §5.1 — severidad alta (tabla completa).
- §5.2 — severidad media (tabla completa).
- §5.3 — severidad baja (top 10 + conteo si >20).
- §5.4 — alcance del escaneo (excludes + extensiones efectivas).

Si `--skip-code-scan` se usó, §5 se reemplaza por nota inline `_(Escaneo omitido por --skip-code-scan)_` (V4.b de `validations.md`).
