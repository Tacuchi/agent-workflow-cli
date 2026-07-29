# PROBE — proof of concept, the resolver for executable doubt

Loaded when the run rests on a runnable assumption that reading cannot settle (signal `probe`).

## Proof of concept (probe)

A **probe** (PoC / spike) is the resolver for **executable doubt**: research *reads*, a probe *runs* — an **atomic, throwaway-by-default** experiment answering **one falsifiable question** (does this connection / SDK / UI behavior work as assumed?). De-risk atomic parts **early**, never everything at the end.

- **When**: risky assumption + not answerable by reading + failure would invalidate downstream work. Proposed via **structured-choice**.
- **Lifecycle** (verification-first applies to the probe): seed question + pass/fail check **BEFORE** → run minimal → verdict in `CONCLUSIONS` (consequences → `DECISION`) → **discard** or promote to a real task/test.
- **Isolation**: probe code lives in the **session folder** (gitignored) — never the source tree, **never committed**; DB probes are read-only (never DDL/DML).
- A **failed probe is a finding, not a failure** — report it; the human decides if the plan reshapes.
