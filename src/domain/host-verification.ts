// VERIFICATION LEDGER — written by `npm run smoke:hosts` and `scripts/host-run/`, never by hand.
//
// It is deliberately a separate module from the catalog: `harnesses.ts` is
// hand-authored (ids, dirs, tiers — what we DECIDE), this file records what a
// run actually PROVED. Keeping the two apart is what lets every projection say
// "verified against X on date Y" without a surface ever claiming a verification
// that no run backs (spec 010, criterion 10).
//
// A host absent from this record has simply never been verified by a run.

import type { HarnessId } from "./harnesses.js";

/** The six surfaces a host run observes, in the doctor's order. */
export type RunSurface =
  | "commands"
  | "structured-choice"
  | "hooks"
  | "mcp"
  | "host-memory"
  | "compaction";

/** A cell as the last host run left it (plan 085, catalog → cell). */
export type RunCellState =
  | "works"
  | "degraded-declared"
  | "broken"
  | "not-reached"
  | "catalog-outdated";

export interface HarnessRunVerification {
  /** Id of the run under `tests/fixtures/host-runs/<id>/` whose matrix backs this block. */
  id: string;
  /** ISO date (YYYY-MM-DD) of that run. */
  at: string;
  /** Host version the run launched; null when the host exposes none. */
  version: string | null;
  /** The checkout the run exercised. */
  cli: { version: string; revision: string };
  /** Last observation of each surface, across the runs merged into this block. */
  cells: Record<RunSurface, RunCellState>;
  /** agy only: what it ran against — "gemini" (a Gemini API key) or "sign-in". */
  model_provider?: string;
}

export interface HarnessVerification {
  /** Host version the run probed. null = the host exposes no CLI version (Warp is an app). */
  version: string | null;
  /** ISO date (YYYY-MM-DD) of the run that produced this entry. */
  at: string;
  /**
   * How far that run went:
   * - `invocation` — runtime present and its version read;
   * - `install`    — the above PLUS the installed artifacts matched what the catalog promises.
   */
  depth: "invocation" | "install";
  /** What a host run inside the host observed; the smoke keeps it when it regenerates. */
  run?: HarnessRunVerification;
}

export const HOST_VERIFICATIONS: Partial<Record<HarnessId, HarnessVerification>> = {
  "claude-code": { version: "2.1.226", at: "2026-08-10", depth: "install" },
  codex: { version: "0.147.0", at: "2026-08-10", depth: "install" },
  oz: { version: "0.2026.08.05.09.03.stable_01", at: "2026-08-10", depth: "invocation" },
  warp: { version: null, at: "2026-08-10", depth: "install" },
  gemini: { version: "1.0.16", at: "2026-08-10", depth: "install" },
  opencode: { version: "1.18.15", at: "2026-08-10", depth: "invocation" },
  crush: { version: "0.88.1", at: "2026-08-10", depth: "invocation" },
  kimi: { version: "0.34.0", at: "2026-08-10", depth: "install" },
};
