---
schema: workline.ui-flow/v1
id: DES-001/FLW-001
revision: 2
maturity: handoff
supersedes: DES-001/FLW-001@r1
purpose: Dar de alta a un miembro nuevo de la familia
platform: web
actors: [operador]
entry: DES-001/SCR-001@r2#default
nodes:
  - DES-001/SCR-001@r2#default
  - DES-001/SCR-001@r2#error
  - DES-001/SCR-002@r1#success
edges:
  - from: DES-001/SCR-001@r2#default
    trigger: submit
    action: crear el miembro
    condition: el documento todavía no pertenece a nadie
    to: DES-001/SCR-002@r1#success
  - from: DES-001/SCR-001@r2#default
    trigger: submit
    action: null
    condition: el documento ya pertenece a otro miembro
    to: DES-001/SCR-001@r2#error
  - from: DES-001/SCR-001@r2#error
    trigger: corregir
    action: null
    condition: null
    to: DES-001/SCR-001@r2#default
dependencies: [DES-001/RUL-001@r1]
trace:
  - criterion: S046/AC-01
    source: docs/specs/046-spec-nacimiento-familias.md
unknowns:
  - question: ¿El alta desde el compañero local usa este mismo recorrido?
    blocking: false
not_applicable: {permissions_and_privacy: el recorrido vive detrás del guard de admin y no expone datos que el operador no vea ya}
---

## Goal and outcome

El operador incorpora un miembro nuevo y termina viendo su ficha creada. El
resultado observable es un miembro con documento único y su primer teléfono.

## Preconditions and entry

El operador ya está autenticado como admin y entra desde el listado de miembros,
en DES-001/SCR-001@r2#default.

## Main journey

Desde DES-001/SCR-001@r2#default el operador completa nombre, documento y
teléfono, y confirma. Si el documento está libre, el recorrido termina en
DES-001/SCR-002@r1#success.

## Alternatives and recovery

Si el documento ya pertenece a otro miembro, el recorrido pasa a
DES-001/SCR-001@r2#error, que explica de quién es y ofrece corregir el dato sin
perder lo ya cargado.

## Permissions and privacy

No aplica: el recorrido corre detrás del guard de admin y no expone ningún dato
que el operador no vea ya en el listado.

## Traceability

Cubre S046/AC-01 (un miembro nace con documento único). La regla de densidad
visual del formulario viene de DES-001/RUL-001@r1.
