---
schema: workline.ui-screen/v1
id: DES-001/SCR-001
revision: 2
maturity: handoff
supersedes: DES-001/SCR-001@r1
title: Alta de miembro
purpose: Capturar los datos mínimos de un miembro nuevo
platform: web
default_state: default
states:
  - anchor: default
    purpose: Formulario vacío, listo para completar
  - anchor: error
    purpose: El documento ingresado ya pertenece a otro miembro
flow_refs: [DES-001/FLW-001@r2]
dependencies:
  rules: [DES-001/RUL-001@r1]
  tokens: [DES-001/TOK-001@r1]
  assets: [sha256:5555555555555555555555555555555555555555555555555555555555555555]
trace:
  - criterion: S046/AC-02
    source: docs/specs/046-spec-nacimiento-familias.md
external:
  - provider: DES-002
    revision: 3
    digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
unknowns:
  - question: ¿El documento admite pasaporte además de DNI?
    blocking: false
not_applicable: {localization: el producto es monolingüe en esta etapa y no hay plan de i18n}
---

## Purpose and context

Es la única superficie donde nace un miembro. Se llega desde el listado y se
sale hacia su ficha.

## Structure and content

Encabezado con el título de la pantalla, formulario de tres campos —nombre,
documento y teléfono— y una barra de acciones con confirmar y cancelar.

## Components and design-system deltas

Usa el formulario estándar del design system. El único delta es la densidad
compacta que fija DES-001/RUL-001@r1.

## Data, permissions and validation

Solo un admin llega acá. El documento es obligatorio y único; el teléfono se
valida en formato internacional. Nada se persiste hasta confirmar.

## States and transitions

En DES-001/SCR-001@r2#default el formulario está vacío. Al confirmar con un
documento ya tomado pasa a DES-001/SCR-001@r2#error, y corregir el campo vuelve
al estado base sin perder lo cargado.

## Interaction and navigation

El foco entra en el primer campo. Enter confirma, Escape cancela y pide
confirmación si hay datos cargados.

## Responsive and adaptation

Una sola columna por debajo de 640 px; la barra de acciones queda fija abajo.

## Localization

No aplica: el producto es monolingüe en esta etapa.

## Accessibility

Cada campo tiene label asociado. El error se anuncia por una región viva y el
foco se mueve al campo que lo causó.

## Edge cases and degradation

Si el backend no responde, el formulario conserva lo cargado y ofrece
reintentar; nunca descarta la carga en silencio.

## Traceability

Cubre S046/AC-02 y participa de DES-001/FLW-001@r2.
