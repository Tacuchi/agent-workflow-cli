---
name: writing
description: >-
  Clear technical writing capability — built-in default for the `writing` role. Rules
  for any prose the AI produces in agent-workflow context: spec/plan/session artifacts,
  commit messages, PR descriptions, export deliverables (manuals/reports). Short
  sentences, lists over prose, one idea per line, "what + why" on one line, no jargon,
  no filler. Use across all loops and in export-manuals / export-reports.
---

# writing — Clear technical writing

## Role

`writing` — built-in default. Rebindable in `.workflow/skills.toml` (third-party skill or `off`). The most broadly composed role.

## Purpose

Reglas de estilo y formato para **toda la prosa** que la IA produce en contexto agent-workflow. Read-only por diseño: carga reglas; el `.md` lo materializa el consumidor (loop o export).

## Composed by

- **Todos los loops** — al escribir specs, planes, artefactos de sesión, mensajes de commit, descripciones de PR.
- **`export-manuals`** — al redactar manuales técnicos (`docs/manuals`).
- **`export-reports`** — al redactar informes ejecutivos (`docs/reports`).

(También aplica a respuestas en chat sobre temas agent-workflow.)

## Knowledge

### Las 6 reglas

1. **Frases cortas**: máximo ~15 palabras. Si pasa de 20, partir en dos.
2. **Listas sobre prosa**: 3+ ideas paralelas van en bullets. Prosa solo para narrar.
3. **Una idea por línea**: si el bullet usa "y" o ";" para meter una segunda idea, separar.
4. **"Qué + por qué" en una línea**: formato `<qué>: <por qué corto>`. Sin párrafo aparte para el "por qué".
5. **Sin jerga ni abreviaturas raras**: palabras comunes. Términos técnicos (MCP, C4) OK; abreviaturas inventadas (ej. "TLDR del CTX") no.
6. **Sin relleno**: borrar "es importante notar que…", "cabe destacar…", "como se mencionó…", "en conclusión…". La idea va directo.

### Palabras a evitar / preferir

| Evitar | Preferir |
|---|---|
| "es importante notar que" / "cabe destacar" | (borrar, empezar con la idea) |
| "en otras palabras" / "asimismo" | (borrar) / "también" |
| "se procede a" / "llevar a cabo" | verbo directo / "hacer" |
| "implementar la funcionalidad de X" | "implementar X" |
| "realizar la validación de" | "validar" |
| "a los efectos de" / "en el marco de" | "para" / "en" |
| "no obstante" / "previamente mencionado" | "pero" / "antes" |
| "TLDR", "FYI", "WIP" | escribir la palabra completa |

### Ejemplo antes / después

Antes:
> Es importante notar que cada llamada implica un round-trip al servidor MCP además del consumo de tokens correspondiente al JSON de respuesta.

Después (-50%):
> Cada llamada MCP cuesta un round-trip y los tokens del JSON.

Decisión densa, antes:
> Se decidió, luego de analizar las alternativas, implementar la validación de roles solo en el frontend, dado que el backend no requiere la lógica y evita duplicar la regla.

Después:
> **Decisión**: validar permisos solo en el frontend.
> **Por qué**: el backend no necesita la lógica; evita duplicar la regla.

### Cuándo SÍ se permite prosa larga

- Resúmenes ejecutivos donde la decisión necesita 4-6 oraciones para sostenerse.
- Cadena causal de un incidente (causa raíz puede requerir un párrafo).
- Tradeoffs de UX que necesitan explicación.

Aún ahí: oraciones simples encadenadas, no oraciones largas.

### Aplicación a los documentos del modelo nuevo

- **spec** (`docs/specs`): brief y criterios de aceptación claros; la sección `## UI spec` la formatea el rol `ui-design`.
- **plan** (`docs/plans`): resumen + fases + tasks con dependencias; tasks sin código inline (el código va en evidencia y se referencia).
- **decisiones**: `**Decisión**:` + `**Por qué**:`, 3-6 líneas; si es obvia, no se registra.
- **commit messages / PR**: mismas reglas (frases cortas, sin jerga, sin relleno). Formato canónico del mensaje en el rol `git`.
- **export manuals/reports**: audiencia operadores/gerencia; bullets sobre prosa, sin relleno corporativo.

## Output

Ninguno propio. La skill aporta reglas; el `.md` lo escribe el consumidor (loop o export). Cuando escribe a `docs/`, lo hace solo el export que la compone (invariante 1) y solo en su carpeta (invariante 2).

## Source

Reciclada de `standards/redaccion-simple/` (las 6 reglas, tabla evitar/preferir, ejemplos, cuándo permitir prosa larga). Se descarta el catálogo de estructuras por artefacto del modelo viejo (OBJETIVO/DECISIONES/etc.); los documentos del modelo nuevo son spec/plan + artefactos de sesión, y su estructura la definen los loops y exports.
