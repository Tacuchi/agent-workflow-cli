# COMPACTION — the loop watching its own context pressure

Loaded when the run is long enough that context pressure governs its pacing (signal `compaction`).

`Compactar` is not only reactive: the loop **watches its own context pressure** and raises compaction itself.

- **Signal**: the host's context-pressure signal when it exists (see the *compaction* capability in [`../harness/HARNESS.md`](../harness/HARNESS.md)); with no signal the fallback is **qualitative** — at batch/phase boundaries of an already-long run, ask *"would a fresh reader need the CHECKPOINT to continue?"*. Doctrine fixes **no numeric thresholds** (harness-agnostic).
- **Modes** — config `[compaction]` table in `.workflow/skills.toml`, key `mode` (values `confirm` | `auto`):
  - **`confirm`** (default, also with no config): raise a **proactive structured-choice** whose `flow` control carries `Compactar` as the recommended action — the human ratifies; consent is never skipped.
  - **`auto`** (opt-in): write `CHECKPOINT.md`, then trigger the host's compaction binding **without asking**. Viable only where the host has a **non-interactive** mechanism (see the *Harness binding matrix*); otherwise it **degrades to `confirm`**.
- **Invariant — CHECKPOINT before compacting**: in every mode, `CHECKPOINT.md` is written (or verified fresh) **before** any compaction fires; resume keys off it.

> **`Compactar`** (the `flow` control) → write `CHECKPOINT.md` in the session (in-flight progress, remaining gaps, Q&A, `attempts`) → trigger the harness **compaction** (Claude Code: `/compact`; see [`../harness/HARNESS.md`](../harness/HARNESS.md)) → resume by reading the checkpoint.
