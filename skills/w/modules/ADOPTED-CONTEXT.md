# ADOPTED-CONTEXT — the host as a producer of input

Loaded when the conversation already produced the analysis, plan or answers the run needs (signal `adopted`).

The host is not only the loop's executor — it is a legitimate **producer** of input. Conclusions **already established in the current conversation** (a host-native analysis, answers the user already gave, a plan built with the host's planner) count as **completed research**: on entry, **adopt** them — seed `SESSION.Objective`/`Success criteria`, reference them in `CONCLUSIONS`, record provenance (`## Origin` = adopted from the host conversation) — never re-derive or re-ask them.

- Adoption is **transcription, not trust**: the convergence gate still verifies adopted conclusions (*gate integrity*); anti-duplicate still applies.
- Materialization pattern = the quick escalation's (single-pass, **NO RESEARCH**), inverted: **host → flow**.
- Gap signals already resolved by adopted context do **not** fire (e.g. "ambiguous requirements" after a host pre-analysis).
- To persist finished work without a loop: [`/w:persist`](../commands/persist.md) (transversal).
