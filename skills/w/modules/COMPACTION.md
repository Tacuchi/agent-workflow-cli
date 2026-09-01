# COMPACTION — the loop watching its own context pressure

Loaded when the run is long enough that context pressure governs its pacing (signal `compaction`).

`Compactar` is not only reactive: the loop **watches its own context pressure** and raises compaction itself. Recognizing that pressure is judgment — the host's signal where it exists (*compaction* capability in [`../harness/HARNESS.md`](../harness/HARNESS.md)), otherwise the **qualitative** question *"would a fresh reader need the CHECKPOINT to continue?"* at a boundary of an already-long run. Doctrine fixes **no numeric thresholds**: a number that means anything is a number about one host.

> **Whether the host can honour it is not this document's call:** `aw checkpoint-write` writes the CHECKPOINT and **never holds the compaction back** — there is no configurable mode; an ambiguity degrades and parks a refuge checkpoint to adopt later. **CHECKPOINT before compacting** is the invariant. What this document keeps is why: consent lives in the `Compactar` control a person ratifies, and a compaction that fires before the checkpoint loses the thread it was meant to protect.

> **`Compactar`** (the `flow` control) → write `CHECKPOINT.md` in the session (in-flight progress, remaining gaps, Q&A, `attempts`) → trigger the harness **compaction** (Claude Code: `/compact`; see [`../harness/HARNESS.md`](../harness/HARNESS.md)) → resume by reading the checkpoint.
