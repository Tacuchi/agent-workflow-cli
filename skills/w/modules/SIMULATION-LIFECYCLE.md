# SIMULATION-LIFECYCLE — the life of temporary behavior in a plan

Loaded when the journey introduces temporary behavior (signal `simulation`).

## Simulation lifecycle

**This section applies only when the journey introduces temporary behavior** — a stub, fake, in-memory adapter, controlled fixture or temporary response. None in the change → no `Límite de simulación`, and no artificial phase invented to retire one. When there is, it is planned, never improvised: every simulation declares **purpose · location · the contract it stands for · the phase where it appears · the phase where it moves or disappears · what prevents its accidental selection in a production runtime · the minimum proof needed while it exists**.

- **Explicit over hidden**: `Stub…` / `Fake…`, in-memory adapter, temporary provider or controlled fixture — never a hardcode buried inside production code.
- **Displacement rule**: each affected phase writes its `Límite de simulación` as normalized prose — `antes <where it is>` → `después <where it lands, or removed>` — never as an implicit assumption.
- **Removal gate**: the change is not complete while a main-path simulation stays active, a configuration can still select it, the plan does not explain why it remains, or its removal was never validated. Test doubles isolated from the production runtime may stay.
