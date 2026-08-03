---
schema: workline.ui-screen/v1
id: DES-001/SCR-002
revision: 1
maturity: handoff
supersedes: null
title: Confirmación del alta
purpose: Confirmar que el miembro quedó creado y ofrecer el siguiente paso
platform: web
default_state: success
states:
  - anchor: success
    purpose: El miembro quedó creado y se muestra su ficha recién nacida
flow_refs: [DES-001/FLW-001@r2]
dependencies:
  rules: [DES-001/RUL-001@r1]
  tokens: []
  assets: []
trace:
  - criterion: S046/AC-03
    source: docs/specs/046-spec-nacimiento-familias.md
    classification: visual
    states: [success]
    renditions: [DES-001/VIS-004@r1]
    reason: null
external: []
unknowns: []
not_applicable: {localization: el producto es monolingüe en esta etapa y no hay plan de i18n, edge_cases_and_degradation: la pantalla no hace pedidos propios y solo muestra lo que el alta ya devolvió}
---

## Purpose and context

Es la única superficie que confirma un alta. Se llega desde el formulario al
confirmar con un documento libre, y se sale hacia la ficha del miembro.

## Structure and content

Un solo estado: título de confirmación, el nombre del miembro creado y una
acción para ir a su ficha.

## Components and design-system deltas

Usa el bloque de confirmación estándar. El único delta es la densidad compacta
que fija DES-001/RUL-001@r1.

## Data, permissions and validation

Solo un admin llega acá. No hay campos ni validación: la pantalla muestra lo que
el alta ya devolvió.

## States and transitions

Un único estado, DES-001/SCR-002@r1#success. No hay transición interna: ir a la
ficha sale del recorrido.

## Interaction and navigation

El foco entra en la acción principal. Enter va a la ficha y Escape vuelve al
listado.

## Responsive and adaptation

Una sola columna en todos los anchos; la acción queda al pie por debajo de
640 px.

## Localization

No aplica: el producto es monolingüe en esta etapa.

## Accessibility

La confirmación se anuncia por una región viva y el foco se mueve a la acción
principal.

## Edge cases and degradation

No aplica: la pantalla no hace pedidos propios y solo muestra lo que el alta ya
devolvió.

## Traceability

Cubre S046/AC-03 y participa de DES-001/FLW-001@r2.
