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
  // Crush's global skill roots are ~/.config/crush/skills on EVERY OS (its
  // home.Config() is $HOME/.config even on Windows; LOCALAPPDATA is only a
  // legacy extra). ~/.crush is read for commands, and .crush/skills only
  // project-relative — never from $HOME (crush v0.81.0 config/load.go
  // GlobalSkillsDirs/projectSkillSubdirs). ≤v19.1.0 wrote ~/.crush/skills,
  // a root crush ignores; see LEGACY_SKILL_ROOTS_BY_TARGET migration.
  crush: [".config", "crush", "skills"],
};

// Skill roots written by prior releases that the host never (or no longer)
// reads; install/uninstall migrate them away. Ownership is verified before
// deleting — these can be shared namespaces.
export const LEGACY_SKILL_ROOTS_BY_TARGET: Record<InstallTarget, readonly (readonly string[])[]> = {
  claude: [],
  codex: [],
  agents: [],
  warp: [],
  oz: [],
  gemini: [],
  opencode: [],
  crush: [[".crush", "skills"]],
};

// Hosts with NO file-based commands dir: their command surface is the
// synthesized `w-<command>` skill-as-command wrappers, installed next to the
// bundle. Single source for install-skill.ts AND uninstall.ts — the two sides
// must stay symmetric or uninstall strands wrappers.
export const COMMAND_SKILLS_HOSTS: ReadonlySet<InstallTarget> = new Set([
  "codex",
  "warp",
  "oz",
  "gemini",
]);

/**
 * Every dir-backed install target, derived from the exhaustive TARGET_ROOTS
 * record so per-command target lists can't drift when a host is added
 * (the clean-legacy v14.5.1 lesson).
 */
export const INSTALL_TARGETS: readonly InstallTarget[] = Object.keys(
  TARGET_ROOTS,
) as InstallTarget[];
