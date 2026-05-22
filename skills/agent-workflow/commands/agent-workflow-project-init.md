---
description: Inicializa el bloque AW-PROJECT en CLAUDE.md y AGENTS.md del proyecto con las 4 secciones gestionadas (Proyecto, Fuentes, Stack, Status). Para workspaces multi-repo usar `/agent-workflow:hub-init`.
argument-hint: (opcional) --proyecto "descripción" | --fuente alias:path[:rama] | --main-branch <rama>
allowed-tools:
  [
    "Read",
    "Write",
    "Bash",
    "AskUserQuestion",
  ]
---

# Project Init (agent-workflow)

Inicializa o reinicia el bloque `<!-- AW-PROJECT-START -->` en `CLAUDE.md` y `AGENTS.md` del directorio actual. Ese bloque es la memoria permanente del proyecto: quién es, qué repos tiene, qué stack, qué sesiones hay activas.

**Se ejecuta una vez por proyecto.** Después, `/agent-workflow:session` (en sus variantes: crear, retomar, cerrar) actualiza el bloque automáticamente vía `agent-workflow project-md-upsert`.

> Este comando vive en agent-workflow (Fase B; antes en qtc-core v2.5+, previamente en qtc-dev). Es agnóstico al flow — no requiere tener qtc-dev instalado. Para workspaces que coordinan **múltiples repos** (≥2 fuentes), usar `/agent-workflow:hub-init` que valida cross-fuente y persiste el marcador `Mode: hub`.

## Flujo

1. Ejecutar `agent-workflow project-md-upsert --read` (lee con cache si está disponible).
2. Si ya existe un bloque AW-PROJECT válido, mostrarlo al usuario y preguntar si quiere **reiniciarlo** (sobreescritura) o **abortar**.
3. Si no existe:
   - Pedir al usuario la descripción del proyecto (qué es + por qué existe) con `AskUserQuestion` o campo libre.
   - Preguntar por la fuente afectada: `alias`, `path` local al repo. La rama principal default es `certificacion` (constante interna del CLI) salvo override con `--main-branch`.
   - Si el usuario declara ≥2 fuentes en este flujo → sugerir cambiar a `/agent-workflow:hub-init` que está pensado para hub workspaces y captura ramas de trabajo cross-fuente.
   - Auto-detectar el stack con `agent-workflow stack` — mostrarlo al usuario y confirmar antes de escribirlo.
   - Invocar:
     ```
     agent-workflow project-md-upsert --init \
         --mode project \
         --proyecto "<descripción>" \
         --fuente "alias:path"
     ```
4. Si existe bloque `<!-- QTC-WORKFLOW-START -->` legacy en los mismos archivos, avisar al usuario y recomendar ejecutar `/agent-workflow:migrate --upgrade-topology` antes de continuar. No borrar el legacy automáticamente.

## Qué NO hace

- No crea `.workflow/sessions/`. Eso es responsabilidad de `/agent-workflow:session <descripción>`.
- No escribe en repos fuera del CWD — sólo en `CLAUDE.md` y `AGENTS.md` del directorio actual.
- No ejecuta `git` ni valida ramas — eso lo hace `/agent-workflow:session` al crear/retomar.
- No persiste `Mode: hub` (eso lo hace `/agent-workflow:hub-init`).

## Argumentos

Sin argumentos: flujo interactivo (pregunta todo).

Con argumentos: no-interactivo cuando se pasan todos los datos.

- `--proyecto "<texto>"` — descripción del proyecto.
- `--fuente "alias:path[:rama]"` — declarar la fuente. Repetible (pero ≥2 sugiere `/hub-init`).
- `--main-branch <rama>` — override del default `certificacion` (raro).

**Argumentos:** $ARGUMENTS

## Skill asociada

Ver `skills/project-init/SKILL.md` para el detalle del flujo, validaciones y manejo de bloques pre-existentes.
