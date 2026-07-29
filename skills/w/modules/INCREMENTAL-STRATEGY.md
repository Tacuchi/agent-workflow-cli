# INCREMENTAL-STRATEGY — the reference shape of an incremental change

Loaded when the work is being staged into tranches or phases (signal `split`).

## Incremental strategy (reference, never a template)

A change spread over consumer, service and data often lands well as: consumer shell → minimal real integration → vertical skeleton → real implementation from the source outwards → hardening → finish. **Reference to adapt, never a mandatory shape.** Backend-only, CLI, batch, library and database-only changes have their own journey, and inserting a layer the project does not have fails the minimality lens. A small change may be **one phase**, when that phase already is a coherent verifiable state.
