import {
  HARNESSES,
  HOST_INSTALL_TARGETS,
  type InstallTarget,
  SHARED_INSTALL_TARGETS,
} from "../../domain/harnesses.js";

export type { InstallTarget };
export { HOST_INSTALL_TARGETS, SHARED_INSTALL_TARGETS };

/** Per-host and shared roots into which the Workline bundle can be installed. */
export const TARGET_ROOTS: Record<InstallTarget, readonly string[]> = {
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  agents: [".agents", "skills"],
  warp: [".warp", "skills"],
  oz: [".agents", "skills"],
  gemini: [".gemini", "config", "skills"],
  opencode: [".opencode", "skills"],
  crush: [".config", "crush", "skills"],
  kimi: [".kimi-code", "skills"],
};

/** Abandoned roots which the host no longer reads; cleaned only with ownership proof. */
export const LEGACY_SKILL_ROOTS_BY_TARGET: Record<InstallTarget, readonly (readonly string[])[]> = {
  claude: [],
  codex: [],
  agents: [],
  warp: [],
  oz: [],
  // agy 1.0.x read it as its Shared tier; agy 1.2.x reads only ~/.gemini/config/skills.
  gemini: [[".gemini", "skills"]],
  opencode: [],
  crush: [[".crush", "skills"]],
  kimi: [],
};

/** Hosts that expose commands as synthesized top-level skills. */
export const COMMAND_SKILLS_HOSTS: ReadonlySet<InstallTarget> = new Set([
  "codex",
  "warp",
  "oz",
  "gemini",
  "kimi",
]);

export const HOOKS_MANAGED_TARGETS: ReadonlySet<InstallTarget> = new Set(
  HARNESSES.filter((h) => h.hooks?.managed === true).map((h) => h.installTarget),
);

export const INSTALL_TARGETS: readonly InstallTarget[] = Object.keys(
  TARGET_ROOTS,
) as InstallTarget[];
