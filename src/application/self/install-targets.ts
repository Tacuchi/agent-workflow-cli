import type { InstallTarget } from "../../domain/harnesses.js";

// InstallTarget is defined canonically in domain/harnesses.ts (HarnessSpec.installTarget).
// This module owns the target→dir map with no other imports, so consumers on
// both sides of install-skill (e.g. plugin-cache-clear) can share it cycle-free.
export type { InstallTarget };

export const TARGET_ROOTS: Record<InstallTarget, readonly string[]> = {
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  agents: [".agents", "skills"],
  warp: [".warp", "skills"],
  oz: [".agents", "skills"],
  // New hosts install to their native skill dir; all of them ALSO read
  // .agents/skills, so `--target agents` is the cross-host alternative.
  gemini: [".gemini", "skills"],
  opencode: [".opencode", "skills"],
  crush: [".crush", "skills"],
};

/**
 * Every dir-backed install target, derived from the exhaustive TARGET_ROOTS
 * record so per-command target lists can't drift when a host is added
 * (the clean-legacy v14.5.1 lesson).
 */
export const INSTALL_TARGETS: readonly InstallTarget[] = Object.keys(
  TARGET_ROOTS,
) as InstallTarget[];
