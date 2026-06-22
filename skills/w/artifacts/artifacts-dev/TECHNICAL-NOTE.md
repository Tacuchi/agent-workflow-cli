# TECHNICAL-NOTE.md — technical design note (schema reference)

> **Model note:** in PLANIFICATION these sections live **inline in the plan-doc** (`docs/plans/PPP-plan.md`, rich plan), not as an exec-session artifact. This file is kept as a reference of the technical schema that the plan absorbs. Use it standalone only when the plan-doc approach does not apply (e.g. a `quick` session that needs scoped technical context).

## Solution
Technical/functional explanation of how the solution will be implemented.

## Impacted
Impacted components:
- Frontend
- Backend
- Database (schemas/tables/functions)
- APIs (controllers/endpoints)
- Integrations with external systems

## Dependencies
Dependencies: sessions / documents / projects / sources / databases, etc.

## Current State
Simple representation of the wiring or cabling (interfaces and methods) — AS-IS behavior.

Example:
```
ContratoEfectivoData.demo()
        │
        ▼
ContratoTemplateRenderer
   (iface)
        │ @Service impl
        ▼
ThymeleafContratoTemplateRenderer ──── reads ──> templates/contratos/efectivo.html
        │ (returns String HTML)
        ▼
PreviewController.efectivoHtml()  ──> respond TEXT_HTML
              │
              └─> efectivoPdf() ─> PdfRenderer (iface @Qualifier("chromePdfRenderer"))
                                            │ @Service impl
                                            ▼
                                       CdpPdfRenderer  ──> Chrome headless via CDP
                                                              │
                                                              ▼
                                                       respond APPLICATION_PDF
```

## Target State
Simple representation of the wiring or cabling (interfaces and methods) — TO-BE behavior.

## Final Behavior
How the entire flow should behave at the end (must be aligned with the requirements and acceptance/success criteria in SESSION.md).

Example:
The user must be able to recover their password via OTP to their mobile number and the mobile number must be saved in the user's data:
1. [User] Accesses the login screen
2. [User] Clicks [Forgot Password]
3. [System] Shows a window to enter mobile number
4. [User] Enters mobile number
5. [System] Sends OTP via SMS
6. [System] Confirms OTP
7. [System] Saves the mobile number and associates it with the [User]

## Impact / Risks
Technical impacts and risks.

## Assumptions
Assumptions.

## Estimated Time
Time estimates for [Development] and [Internal Testing].
The work week has 5 days (Monday–Friday only).
Size scale XS/S/M/L/XL:
- XS -> 1 day or less
- S  -> 1 to 2 days
- M  -> 3 to 5 days
- L  -> 6 to 10 days
- XL -> More than 10 days

## Validations
Validations, constraints, business-specific logic.

## Open Questions
Pending items, doubts, open questions.
