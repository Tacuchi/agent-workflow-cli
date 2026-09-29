---
name: design
description: >-
  producir, actualizar, juzgar, proyectar y sellar un diseño sobre un contrato único: un DESIGN.md legible por defecto, el UI Design Package v1 cuando una señal observable lo pide. Operaciones: create, update, validate, render, record.
metadata:
  workline-capability-descriptor: "workline-capability.json#sha256=1b0334bfe8d1600dcccc0791e4bdafc8c746e580b55a3ac7892d3ad808d94244"
---

> Capability skill wrapper (installed by `aw self install-skill`). El contrato completo vive en `./workline-capability.json`; este archivo no lo repite.

# design

producir, actualizar, juzgar, proyectar y sellar un diseño sobre un contrato único: un DESIGN.md legible por defecto, el UI Design Package v1 cuando una señal observable lo pide.

## Cómo se ejecuta

Toda invocación pasa por el dispatcher compartido, con la operación (`create`, `update`, `validate`, `render`, `record`) viajando en el envelope:

```
aw capability prepare --capability design --operation <op> [--input k=v ...]
aw capability continue --capability design --operation <op> [--input k=v ...] # stdin: {"parent": <request>}
aw capability validate --capability design --operation <op> [--input k=v ...] # stdin: {"request": <request>, "answer": <answer>}
aw capability apply --capability design --operation <op> [--input k=v ...] --approval <plan.proposal.digest> # stdin: {"request": <request>, "plan": <plan>, "pin": <pin>}
```

Repetí los mismos `--capability`, `--operation`, TODOS los `--input` y `--consumer-document` si lo usaste, en cada etapa.
La respuesta viaja por stdin como un único objeto JSON; `prepare` no lee stdin. `pin` es opcional.
La aprobación usa el digest de `plan.proposal.digest`. Consultá `aw capability --help` para el sobre completo.
Si `aw harness` no reconoce el host, agregá `--host <id>` en cada etapa.

Cada intento devuelve `outcome`, `output` y `receipt`. Un `needs_input` se contesta con
`continue`, que construye el intento siguiente del mismo `invocation_id` — nunca reusa el anterior.

## Lo que esta ruta NO hace

- No crea, avanza, cierra ni publica una sesión o documento SPEC, PLAN o QUICK.
- No inicializa un workspace: si la operación necesita uno y no lo hay, devuelve un resultado explícito.
- No ejerce ningún efecto que el descriptor no declare, ni uno que exija aprobación sin pedirla.

La conversación es la del host. Las preguntas de un `needs_input` se hacen acá mismo.
El contrato de invocación completo — qué puede pedir cada caller — vive en
`roles/design/CONTRACT.md` del bundle `w`, y no se repite acá.

> **Structured-choice on this host (`claude`, stamped at install).** Present every human and authorization boundary with `AskUserQuestion`, at most 4 questions per call and 4 options each, always reserving one question slot for the `flow` control (`Compactar`/`Cerrar`).
> While it is reachable, never render a boundary as plain prose instead.
> The option's label and its functional sentence go in their own fields.
> It already offers a free-text answer, so do not add an `Other` option of your own.
> When the call fails, or the asker is a subagent (the tool belongs to the main agent only), fall back to labeled markdown — every option as `Label — functional sentence`, the `flow` control (`Compactar`/`Cerrar`) always among them, answered by label or `Aceptar recomendaciones`.
> Degrade the mechanism, never the content: no alternative is merged, truncated or dropped to fit, and any loss is declared as a degradation.
