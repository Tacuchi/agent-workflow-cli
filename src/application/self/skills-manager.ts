// Standalone-skills INVENTORY and ownership (skills.sh model): canonical copy
// in ~/.agents/skills/<n> (the open-standard anchor that non-Claude hosts
// scan) + a replica per host that does not read it.
//
// This module READS. Since Spec 043 the only way to change an installation is
// `prepareSkillChange` + `applySkillChange` (skills-change / skills-apply):
// one preparation, one preview, one concrete approval and one journal. There
// is deliberately no mutating function here for a surface to reach for — that
// was how the TUI could install without showing what it was about to do.
//
// The user-level registry (skills-registry.ts) stays the source of truth for
// WHAT this engine manages, and `installedAt` is still the only signal that
// says this engine materialized a directory: everything else on those roots
// belongs to somebody else (the `w` bundle, plugin skills, a manual install)
// and is reported, never touched.

import { readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { CliContext } from "../../cli/types.js";
import { harnessByInstallTarget } from "../../domain/harnesses.js";
import { hasValidFrontmatter } from "./install-plugin-skills.js";
import { COMMAND_SKILL_PREFIX, LEGACY_SKILL_NAMES, SKILL_DIR_NAME } from "./install-skill.js";
import {
  type SeedSkill,
  type SkillCuration,
  curationOf,
  isRecommendedEntry,
} from "./skills-catalog.js";
import {
  type SkillRegistryEntry,
  type SkillReplicaMode,
  isValidSkillName,
  readSkillsRegistry,
  readSkillsShLockSources,
} from "./skills-registry.js";

/** `unmanaged`: canonical dir present in ~/.agents/skills WITHOUT a registry
 *  entry (skills.sh, manual) — visible but not operable (register rejects it:
 *  SKILL_NAME_COLLISION, ownership guard). */
export type SkillStatus = "installed" | "unmanaged" | "registered" | "recommended";

/** The curated catalog's shape lives in `skills-catalog.ts`; its entries are
 *  defined by the TUI data module and passed in as a parameter (application
 *  does not import from cli/). Re-exported so consumers of this engine keep
 *  one import site. */
export type { SeedSkill, SkillCuration } from "./skills-catalog.js";

export interface SkillListItem {
  name: string;
  source: string;
  ref?: string;
  mode?: SkillReplicaMode;
  installedAt?: string;
  description?: string;
  status: SkillStatus;
  /** What the reviewed catalog says about this name — absent when it says
   *  nothing, which is NOT the same as recommending it. */
  curation?: SkillCuration;
  /** Materialized replicas: .agents anchor (canonical), .claude and .gemini. */
  replicas: { agents: boolean; claude: boolean; gemini: boolean };
}

type ResolvedSource = { kind: "git"; url: string; ref?: string } | { kind: "local"; path: string };

export function canonicalSkillsRoot(home: string): string {
  return join(home, ".agents", "skills");
}

export function claudeReplicaRoot(home: string): string {
  return join(home, ".claude", "skills");
}

export function geminiReplicaRoot(home: string): string {
  return join(home, ".gemini", "skills");
}

// Ownership marker for COPY replicas (counterpart of the symlink, which
// authenticates by pointing at our canonical): without it, a same-named real
// dir from another origin would be indistinguishable from our copy and
// teardown/reinstall could clobber it.
export const REPLICA_MARKER_FILENAME = ".aw-replica";

// Per-host replicas: hosts that do NOT read the user-level anchor
// ~/.agents/skills get a replica of every installed standalone skill.
// - claude: only reads ~/.claude/skills → symlink (copy fallback without
//   symlinks, e.g. Windows without Developer Mode).
// - gemini/Antigravity (agy 1.0.16): tiers Workspace <repo>/.agents/skills ·
//   Global ~/.gemini/antigravity-cli/skills · Shared ~/.gemini/skills — does
//   NOT read the user-level anchor (field research 2026-07). Replica goes in
//   Shared, mode ALWAYS copy: agy's walker is not verifiable (Go
//   filepath.WalkDir does not follow dir symlinks by default) — the copy
//   guarantees discovery.
interface ReplicaHost {
  key: "claude" | "gemini";
  root: (home: string) => string;
  preferSymlink: boolean;
}

const REPLICA_HOSTS: readonly ReplicaHost[] = [
  { key: "claude", root: claudeReplicaRoot, preferSymlink: true },
  { key: "gemini", root: geminiReplicaRoot, preferSymlink: false },
];

/**
 * Labels of the hosts that get a replica, for surfaces that describe the
 * action. The TUI used to spell "Claude, Gemini" into four separate strings, so
 * adding a replica host meant remembering all four.
 */
export const REPLICA_HOST_LABELS: readonly string[] = REPLICA_HOSTS.map(
  (h) => harnessByInstallTarget(h.key)?.label ?? h.key,
);

/** Replica host keys in display order — surfaces enumerate from here, not by hand. */
export const REPLICA_HOST_KEYS: readonly ReplicaHost["key"][] = REPLICA_HOSTS.map((h) => h.key);

/**
 * Normalizes the user's source: git URL (with `#ref`), `owner/repo` shorthand
 * (→ GitHub) or absolute local path. Relative paths are rejected on purpose:
 * the registry must resolve from any future cwd.
 */
export function resolveSkillSource(raw: string, ref?: string): ResolvedSource | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: "la fuente no puede estar vacía" };
  // file:// counts as git (clone over local transport) — lets users register
  // local repos WITH history, unlike a plain path.
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(trimmed)) {
    const hashIdx = trimmed.indexOf("#");
    const url = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
    const parsedRef = ref ?? (hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : undefined);
    return { kind: "git", url, ...(parsedRef ? { ref: parsedRef } : {}) };
  }
  if (isAbsolute(trimmed)) return { kind: "local", path: trimmed };
  // The GitHub shorthand requires segments starting alphanumeric: "./x" or
  // "../x" are relative paths (rejected), not owner/repo.
  if (/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(trimmed)) {
    return { kind: "git", url: `https://github.com/${trimmed}.git`, ...(ref ? { ref } : {}) };
  }
  return {
    error: `fuente inválida: '${raw}'. Usá owner/repo, una URL git o un path local absoluto.`,
  };
}

async function isSkillDir(dir: string): Promise<boolean> {
  try {
    return hasValidFrontmatter(await readFile(join(dir, "SKILL.md"), "utf8"));
  } catch {
    return false;
  }
}

/** Frontmatter `name:` — the skill's real name when the source IS a skill dir
 *  (the basename of a temp clone is random, never usable). Exported so the
 *  path-addressable discovery reads identity the same way this engine does. */
export function skillFrontmatterName(content: string): string | null {
  const block = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return block.match(/^name:\s*(\S[^\r\n]*)/m)?.[1]?.trim() ?? null;
}

/** What this manager may touch for a name, and what belongs to somebody else.
 *  READ-ONLY: a preparation needs the ownership picture before proposing an
 *  effect, and asking for it must not move a byte. */
export interface SkillOwnership {
  name: string;
  canonical: { path: string; state: SkillReplicaState };
  replicas: { host: "claude" | "gemini"; path: string; state: SkillReplicaState }[];
}

export async function inspectSkillOwnership(
  ctx: CliContext,
  name: string,
  entry?: SkillRegistryEntry,
): Promise<SkillOwnership> {
  const home = ctx.env.homeDir();
  const canonicalPath = join(canonicalSkillsRoot(home), name);
  const present = await ctx.fs.exists(canonicalPath);
  // `installedAt` is the only signal that says THIS manager materialized it;
  // a same-named dir nobody registered belongs to whoever put it there.
  const canonicalState: SkillReplicaState = !present
    ? "absent"
    : entry?.installedAt
      ? "ours"
      : "foreign";
  const replicas: SkillOwnership["replicas"] = [];
  for (const host of REPLICA_HOSTS) {
    replicas.push({
      host: host.key,
      path: join(host.root(home), name),
      state: await inspectReplica(ctx, name, entry?.mode, host),
    });
  }
  return { name, canonical: { path: canonicalPath, state: canonicalState }, replicas };
}

/** The catalog's contribution to a row: what the review says about this name,
 *  or nothing at all — an unreviewed installation borrows no verdict. */
function catalogFields(
  entry: SeedSkill | undefined,
): Pick<SkillListItem, "description" | "curation"> {
  const curation = curationOf(entry);
  return {
    ...(entry?.description ? { description: entry.description } : {}),
    ...(curation !== undefined ? { curation } : {}),
  };
}

/** Single list for the TUI: registered (installed or not) + canonicals outside
 *  the registry (`unmanaged`) + the recommended catalog entries nobody has.
 *  Order: installed → unmanaged → registered → recommended; alphabetical
 *  within each group.
 *
 *  `catalog` is the WHOLE reviewed record (Spec 043): its metadata reaches
 *  every row it knows — a withdrawn entry included, which is what keeps an
 *  installation readable after it stops being recommended — while only the
 *  recommended entries produce a `recommended` row of their own. */
export async function listSkills(
  ctx: CliContext,
  catalog: readonly SeedSkill[],
): Promise<SkillListItem[]> {
  const { registry, warning } = await readSkillsRegistry(ctx);
  const home = ctx.env.homeDir();
  const catalogByName = new Map(catalog.map((s) => [s.name, s]));

  const items: SkillListItem[] = [];
  for (const [name, entry] of Object.entries(registry.skills)) {
    const canonical = await ctx.fs.exists(join(canonicalSkillsRoot(home), name));
    const replica = (await ctx.fs.lstat(join(claudeReplicaRoot(home), name))) !== null;
    const gemini = (await ctx.fs.lstat(join(geminiReplicaRoot(home), name))) !== null;
    items.push({
      name,
      source: entry.source,
      ...(entry.ref ? { ref: entry.ref } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.installedAt ? { installedAt: entry.installedAt } : {}),
      ...catalogFields(catalogByName.get(name)),
      status: canonical ? "installed" : "registered",
      replicas: { agents: canonical, claude: replica, gemini },
    });
  }

  // Canonicals outside the registry (skills.sh, manual): shown as `unmanaged`
  // so the tab reflects the WHOLE anchor, without making them operable
  // (ownership guard intact). The source comes from the skills.sh lock when it
  // knows it; "" when nobody does. Excluded: the `w` bundle and its
  // synthesized `w-*` namespace (skill-as-command) + legacy names (managed by
  // [Workline], not "someone else's"). With an UNREADABLE registry nothing is
  // classified: entries could belong to this engine and would be mislabeled as
  // foreign.
  const bundleOwned = new Set<string>([SKILL_DIR_NAME, ...LEGACY_SKILL_NAMES]);
  const unmanaged = new Set<string>();
  const root = canonicalSkillsRoot(home);
  if (warning === undefined) {
    try {
      const lockSources = await readSkillsShLockSources(ctx);
      for (const entry of await ctx.fs.list(root)) {
        // A symlink-to-dir is typed "other" (Dirent does not resolve it); only
        // files are discarded — isSkillDir reads THROUGH the link and decides.
        if (entry.type === "file" || entry.name.startsWith(".")) continue;
        if (bundleOwned.has(entry.name) || entry.name.startsWith(COMMAND_SKILL_PREFIX)) continue;
        if (Object.hasOwn(registry.skills, entry.name) || !isValidSkillName(entry.name)) continue;
        if (!(await isSkillDir(join(root, entry.name)))) continue;
        unmanaged.add(entry.name);
        const replica = (await ctx.fs.lstat(join(claudeReplicaRoot(home), entry.name))) !== null;
        const gemini = (await ctx.fs.lstat(join(geminiReplicaRoot(home), entry.name))) !== null;
        items.push({
          name: entry.name,
          source: lockSources[entry.name] ?? "",
          ...catalogFields(catalogByName.get(entry.name)),
          status: "unmanaged",
          replicas: { agents: true, claude: replica, gemini },
        });
      }
    } catch {
      // Anchor absent or unreadable (e.g. permissions): the scan is best-effort —
      // managed skills are already listed; never empty the tab over this.
    }
  }

  for (const s of catalog) {
    // A withdrawn entry is no longer offered: it keeps its metadata for the
    // rows above, but it never comes back as a `recommended` one.
    if (!isRecommendedEntry(s)) continue;
    if (Object.hasOwn(registry.skills, s.name) || unmanaged.has(s.name)) continue;
    // Same-named canonical the scan did not list (invalid frontmatter, file,
    // unreadable registry): offering Install guarantees SKILL_NAME_COLLISION —
    // better not to offer the catalog entry.
    if (await ctx.fs.exists(join(root, s.name))) continue;
    items.push({
      name: s.name,
      source: s.source,
      ...catalogFields(s),
      status: "recommended",
      replicas: { agents: false, claude: false, gemini: false },
    });
  }

  const rank: Record<SkillStatus, number> = {
    installed: 0,
    unmanaged: 1,
    registered: 2,
    recommended: 3,
  };
  return items.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
}
// --- internals ---
/** Whether a materialized location belongs to this manager. */
export type SkillReplicaState = "absent" | "ours" | "foreign";

/** Replica ownership on a host: ours only if it is a symlink pointing at OUR
 *  canonical, a real dir with the `.aw-replica` marker, or — legacy
 *  (pre-marker copies, Windows) — a real dir with registered mode:"copy". A
 *  user's symlink pointing elsewhere is foreign — never re-pointed. */
async function inspectReplica(
  ctx: CliContext,
  name: string,
  registeredMode: SkillReplicaMode | undefined,
  host: ReplicaHost,
): Promise<SkillReplicaState> {
  const home = ctx.env.homeDir();
  const replicaRoot = host.root(home);
  const replica = join(replicaRoot, name);
  // A location this manager cannot even READ is definitely not one it owns —
  // e.g. somebody left a FILE where the skills root goes. `foreign` is the
  // honest answer: report it, never write through it.
  const existing = await ctx.fs.lstat(replica).catch(() => "unreadable" as const);
  if (existing === "unreadable") return "foreign";
  if (!existing) return "absent";
  if (existing.isSymlink) {
    try {
      const target = await readlink(replica);
      const canonical = join(canonicalSkillsRoot(home), name);
      return resolve(replicaRoot, target) === resolve(canonical) ? "ours" : "foreign";
    } catch {
      return "foreign";
    }
  }
  if (await ctx.fs.exists(join(replica, REPLICA_MARKER_FILENAME))) return "ours";
  // Legacy: pre-marker copies on the claude host authenticated only via the
  // registered mode.
  return host.key === "claude" && registeredMode === "copy" ? "ours" : "foreign";
}
