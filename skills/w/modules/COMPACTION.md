# COMPACTION — the loop watching its own context pressure

Loaded when the run is long enough that context pressure governs its pacing (signal `compaction`).

`Compactar` is not only reactive: the loop **watches its own context pressure** and raises compaction itself. Recognizing that pressure is judgment — the host's signal where it exists (*compaction* capability in [`../harness/HARNESS.md`](../harness/HARNESS.md)), otherwise the **qualitative** question *"would a fresh reader need the CHECKPOINT to continue?"* at a boundary of an already-long run. Doctrine fixes **no numeric thresholds**: a number that means anything is a number about one host.

> **Which mode runs, and whether the host can honour it, is not this document's call:** `aw checkpoint-write --can-pause` decides it from the `[compaction]` config (`mode` = `confirm` | `auto`), the host's binding and the session's state. `auto` needs a **non-interactive** mechanism and **degrades to `confirm`** without one; **CHECKPOINT before compacting** holds in every mode. What this document keeps is why: consent is never skipped where a person can be asked, and a compaction that fires before the checkpoint loses the thread it was meant to protect.

> **`Compactar`** (the `flow` control) → write `CHECKPOINT.md` in the session (in-flight progress, remaining gaps, Q&A, `attempts`) → trigger the harness **compaction** (Claude Code: `/compact`; see [`../harness/HARNESS.md`](../harness/HARNESS.md)) → resume by reading the checkpoint.
