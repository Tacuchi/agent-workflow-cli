import { join } from "node:path";
import {
  HARNESSES,
  HOST_INSTALL_TARGETS,
  type HarnessId,
  type HarnessSpec,
  type InstallTarget,
  SHARED_INSTALL_TARGETS,
} from "../../domain/harnesses.js";

import type { FileSystemPort } from "../../ports/file-system.js";
import { type WrapperOwnership, inspectCapabilityDirVia } from "../capability/wrapper.js";

// InstallTarget is defined canonically in domain/harnesses.ts (HarnessSpec.installTarget).
// This module owns the target→dir map and capability placement shared by install,
// uninstall and readiness. It must not import the install/uninstall services.
export type { InstallTarget };
// Re-exported so the install/uninstall side never has to re-derive the
// host-vs-shared split: `HOST_INSTALL_TARGETS` is what `--target all` means,
// `SHARED_INSTALL_TARGETS` is what it deliberately leaves out.
export { HOST_INSTALL_TARGETS, SHARED_INSTALL_TARGETS };

export const TARGET_ROOTS: Record<InstallTarget, readonly string[]> = {
  claude: [".claude", "skills"],
  codex: [".codex", "skills"],
  agents: [".agents", "skills"],
  warp: [".warp", "skills"],
  oz: [".agents", "skills"],
  // Antigravity reads .agents/skills only in projects, never under HOME.
  gemini: [".gemini", "skills"],
  opencode: [".opencode", "skills"],
  // Crush's global skill roots are ~/.config/crush/skills on EVERY OS (its
  // home.Config() is $HOME/.config even on Windows; LOCALAPPDATA is only a
  // legacy extra). ~/.crush is read for commands, and .crush/skills only
  // project-relative — never from $HOME (crush v0.81.0 config/load.go
  // GlobalSkillsDirs/projectSkillSubdirs). ≤v19.1.0 wrote ~/.crush/skills,
  // a root crush ignores; see LEGACY_SKILL_ROOTS_BY_TARGET migration.
  crush: [".config", "crush", "skills"],
  // Kimi's user "brand" tier is <KIMI_CODE_HOME>/skills (default ~/.kimi-code);
  // it ALSO reads ~/.agents/skills, so `--target agents` stays the cross-host
  // alternative. Verified against v0.29.2 (USER_BRAND_DIRS/USER_GENERIC_DIRS).
  kimi: [".kimi-code", "skills"],
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
  kimi: [],
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
  // Kimi Code reads no commands dir either: skills ARE its command surface,
  // invoked as `/skill:<name>` (probe 2026-07-29 — a skill dropped in
  // ~/.agents/skills was listed and invoked that way), so each bundle command
  // ships as a `w-<command>` skill next to the bundle.
  "kimi",
]);

/**
 * Hosts whose hook set Workline installs AND removes by merging into a
 * user-level config file. Derived from `HarnessSpec.hooks.managed` — the three
 * sites that need it (install-skill's auto-install, install-hooks' writer,
 * uninstall's remover) each used to carry their own `new Set(["claude"])`, so a
 * new host could land in one and not the others.
 */
export const HOOKS_MANAGED_TARGETS: ReadonlySet<InstallTarget> = new Set(
  HARNESSES.filter((h) => h.hooks?.managed === true).map((h) => h.installTarget),
);

/**
 * Every dir-backed install target, derived from the exhaustive TARGET_ROOTS
 * record so per-command target lists can't drift when a host is added
 * (the clean-legacy v14.5.1 lesson).
 */
export const INSTALL_TARGETS: readonly InstallTarget[] = Object.keys(
  TARGET_ROOTS,
) as InstallTarget[];

/** HOME discovery excludes roots that the catalog also lists for projects only. */
export function homeSkillDirs(host: HarnessSpec): readonly string[] {
  const legacy = LEGACY_SKILL_ROOTS_BY_TARGET[host.installTarget].map((parts) => parts.join("/"));
  return (host.globalSkillsDirs ?? host.skillsDirs).filter((dir) => !legacy.includes(dir));
}

export interface CapabilityLocation {
  target: InstallTarget;
  root: string;
  readers: HarnessId[];
  ownership: WrapperOwnership;
  selected: boolean;
  legacy: boolean;
  boundHost?: HarnessId;
}

export interface CapabilityPlacement {
  keep: CapabilityLocation[];
  remove: CapabilityLocation[];
}

/** One snapshot per operation; neither target order nor earlier writes choose placement. */
export async function capabilityPlacement(
  fs: FileSystemPort,
  home: string,
  name: string,
  targets: readonly InstallTarget[],
  operation: "install" | "uninstall",
  installed: readonly InstallTarget[] = [],
): Promise<CapabilityPlacement> {
  const all = await capabilityLocations(fs, home, name, targets);
  const keep = new Set(
    all.filter((location) => {
      if (location.legacy) return false;
      if (operation === "install") {
        return location.ownership.state === "ours" || location.selected;
      }
      if (!location.selected) return location.ownership.state === "ours";
      return (
        location.ownership.state === "ours" &&
        installed.some(
          (target) =>
            !targets.includes(target) &&
            HARNESSES.some(
              (host) => host.installTarget === target && location.readers.includes(host.id),
            ),
        )
      );
    }),
  );
  if (operation === "install") pruneCoveredLocations(keep);
  return {
    keep: [...keep],
    remove: all.filter(
      (location) =>
        !keep.has(location) &&
        (operation === "install" ? location.ownership.state === "ours" : location.selected),
    ),
  };
}

async function capabilityLocations(
  fs: FileSystemPort,
  home: string,
  name: string,
  targets: readonly InstallTarget[],
): Promise<CapabilityLocation[]> {
  const locations = new Map<string, CapabilityLocation>();
  for (const target of INSTALL_TARGETS) {
    for (const parts of [TARGET_ROOTS[target], ...LEGACY_SKILL_ROOTS_BY_TARGET[target]]) {
      const root = join(home, ...parts);
      const previous = locations.get(root);
      if (previous !== undefined) {
        if (targets.includes(target)) previous.target = target;
        previous.selected ||= targets.includes(target);
        continue;
      }
      const dir = parts.join("/");
      const readers = HARNESSES.filter((host) => homeSkillDirs(host).includes(dir)).map(
        (host) => host.id,
      );
      locations.set(root, {
        target,
        root,
        readers,
        ownership: await inspectCapabilityDirVia(fs, join(root, name)),
        selected: targets.includes(target),
        legacy: parts !== TARGET_ROOTS[target],
        ...(readers.length === 1 && readers[0] !== undefined ? { boundHost: readers[0] } : {}),
      });
    }
  }
  return [...locations.values()];
}

function pruneCoveredLocations(keep: Set<CapabilityLocation>): void {
  // Every reader must retain a shared copy before a native one can be removed.
  for (const location of keep) {
    if (location.ownership.state === "foreign") continue;
    const alternatives = [...keep].filter(
      (other) =>
        other !== location && other.readers.length > 1 && other.ownership.state !== "foreign",
    );
    if (capabilityCoveredBy(location, alternatives)) {
      keep.delete(location);
    }
  }
}

/** The same coverage rule chooses placement and permits retirement after publication. */
export function capabilityCoveredBy(
  location: CapabilityLocation,
  replacements: readonly CapabilityLocation[],
): boolean {
  return location.readers.every((reader) =>
    replacements.some((other) => other.root !== location.root && other.readers.includes(reader)),
  );
}
