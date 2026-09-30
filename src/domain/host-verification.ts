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
  | "degraded-undeclared"
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
  /** agy only: which keychain its sign-in used — "real (accepted by the person)". */
  agy_keychain?: string;
  /** crush only: the provider it ran against ("gemini", "openai") or "own-data". */
  crush_provider?: string;
  /** crush only: the model a provider key selected; null with its own data. */
  crush_model?: string | null;
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
  "claude-code": {
    version: "2.1.226",
    at: "2026-08-10",
    depth: "install",
    run: {
      id: "2026-09-30T09-49-27Z",
      at: "2026-09-30",
      version: "2.1.285",
      cli: { version: "28.0.0", revision: "7ef6aae" },
      cells: {
        commands: "works",
        "structured-choice": "not-reached",
        hooks: "not-reached",
        mcp: "not-reached",
        "host-memory": "not-reached",
        compaction: "not-reached",
      },
    },
  },
  codex: {
    version: "0.147.0",
    at: "2026-08-10",
    depth: "install",
    run: {
      id: "2026-09-30T09-49-27Z",
      at: "2026-09-30",
      version: "0.157.1",
      cli: { version: "28.0.0", revision: "7ef6aae" },
      cells: {
        commands: "degraded-declared",
        "structured-choice": "not-reached",
        hooks: "degraded-declared",
        mcp: "works",
        "host-memory": "degraded-declared",
        compaction: "degraded-declared",
      },
    },
  },
  oz: { version: "0.2026.08.05.09.03.stable_01", at: "2026-08-10", depth: "invocation" },
  warp: { version: null, at: "2026-08-10", depth: "install" },
  gemini: {
    version: "1.0.16",
    at: "2026-08-10",
    depth: "install",
    run: {
      id: "2026-09-30T09-49-27Z",
      at: "2026-09-30",
      version: "1.2.13",
      cli: { version: "28.0.0", revision: "7ef6aae" },
      cells: {
        commands: "broken",
        "structured-choice": "not-reached",
        hooks: "degraded-undeclared",
        mcp: "broken",
        "host-memory": "degraded-undeclared",
        compaction: "degraded-undeclared",
      },
      model_provider: "sign-in-in-pane",
      agy_keychain: "real (accepted by the person)",
    },
  },
  opencode: {
    version: "1.18.15",
    at: "2026-08-10",
    depth: "invocation",
    run: {
      id: "2026-09-30T09-49-27Z",
      at: "2026-09-30",
      version: "1.18.30",
      cli: { version: "28.0.0", revision: "7ef6aae" },
      cells: {
        commands: "broken",
        "structured-choice": "not-reached",
        hooks: "not-reached",
        mcp: "not-reached",
        "host-memory": "not-reached",
        compaction: "not-reached",
      },
    },
  },
  crush: { version: "0.88.1", at: "2026-08-10", depth: "invocation" },
  kimi: { version: "0.34.0", at: "2026-08-10", depth: "install" },
};
