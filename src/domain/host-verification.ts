// VERIFICATION LEDGER — written by `npm run smoke:hosts`, never by hand.
//
// It is deliberately a separate module from the catalog: `harnesses.ts` is
// hand-authored (ids, dirs, tiers — what we DECIDE), this file records what a
// run actually PROVED. Keeping the two apart is what lets every projection say
// "verified against X on date Y" without a surface ever claiming a verification
// that no run backs (spec 010, criterion 10).
//
// A host absent from this record has simply never been verified by a run.

import type { HarnessId } from "./harnesses.js";

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
}

export const HOST_VERIFICATIONS: Partial<Record<HarnessId, HarnessVerification>> = {
  "claude-code": { version: "2.1.222", at: "2026-08-05", depth: "install" },
  codex: { version: "0.146.0", at: "2026-08-05", depth: "install" },
  oz: { version: "0.2026.07.29.09.05.stable_02", at: "2026-08-05", depth: "invocation" },
  warp: { version: null, at: "2026-08-05", depth: "install" },
  gemini: { version: "1.0.16", at: "2026-08-05", depth: "install" },
  opencode: { version: "1.18.5", at: "2026-08-05", depth: "invocation" },
  crush: { version: "0.87.0", at: "2026-08-05", depth: "invocation" },
  kimi: { version: "0.31.1", at: "2026-08-05", depth: "install" },
};
