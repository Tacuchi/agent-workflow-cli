// Standalone-skills engine (skills.sh model): canonical copy in
// ~/.agents/skills/<n> (the open-standard anchor that non-Claude hosts scan)
// + replica in ~/.claude/skills/<n> via symlink, with a copy fallback
// (Windows without links).
//
// The user-level registry (skills-registry.ts) is the source of truth for WHAT
// this engine manages. Ownership guards (the engine writes under the user's
// real HOME, which also hosts the `w` bundle, plugin skills and manual
// skills):
//   - every operation requires a registered name (SKILL_NOT_REGISTERED);
//   - the canonical dir is only created/deleted if this engine materialized it
//     — signal: `installedAt` in the registry (SKILL_NAME_COLLISION when
//     colliding with a foreign dir; on uninstall/remove the foreign dir is
//     preserved with a warning);
//   - the Claude replica is ours only if it is a symlink THAT POINTS AT the
//     canonical or a dir with registered mode:"copy" (FOREIGN_REPLICA
//     otherwise), verified BEFORE mutating anything;
//   - an unreadable registry (read warning) aborts every mutation: never
//     rewrite over entries that could not be read.

import type { Dirent } from "node:fs";
import { readFile, readdir, readlink, rename } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { CliContext } from "../../cli/types.js";
import type { CommandResult } from "../../domain/types.js";
import { gitClone } from "./install-plugin-skills-git.js";
import { copyDir, hasValidFrontmatter } from "./install-plugin-skills.js";
import { COMMAND_SKILL_PREFIX, LEGACY_SKILL_NAMES, SKILL_DIR_NAME } from "./install-skill.js";
import {
  type SkillRegistryEntry,
  type SkillReplicaMode,
  type SkillsRegistry,
  isValidSkillName,
  readSkillsRegistry,
  readSkillsShLockSources,
  writeSkillsRegistry,
} from "./skills-registry.js";

/** `unmanaged`: canonical dir present in ~/.agents/skills WITHOUT a registry
 *  entry (skills.sh, manual) — visible but not operable (register rejects it:
 *  SKILL_NAME_COLLISION, ownership guard). */
export type SkillStatus = "installed" | "unmanaged" | "registered" | "recommended";

/** Recommended-skills seed — defined by the TUI data module and passed in as a
 *  parameter (application does not import from cli/). */
export interface SeedSkill {
  name: string;
  source: string;
  description: string;
}

export interface SkillListItem {
  name: string;
  source: string;
  ref?: string;
  mode?: SkillReplicaMode;
  installedAt?: string;
  description?: string;
  status: SkillStatus;
  /** Materialized replicas: .agents anchor (canonical), .claude and .gemini. */
  replicas: { agents: boolean; claude: boolean; gemini: boolean };
}

export interface RegisterInput {
  /** `owner/repo`, git URL (with optional `#ref`) or absolute local path. */
  source: string;
  ref?: string;
  /** Skill-dir name to register when the source contains several. */
  pick?: string;
}

export interface RegisterData {
  status: "registered" | "needs-pick";
  name?: string;
  entry?: SkillRegistryEntry;
  /** Candidates when the source ships >1 skill and no `pick` was given. */
  candidates?: string[];
  summary: string;
}

export interface MaterializeData {
  status: "installed" | "updated" | "reinstalled";
  name: string;
  canonical: string;
  /** Primary replica (Claude) — compat with prior consumers. */
  replica: string;
  mode: SkillReplicaMode;
  /** All per-host replicas (claude symlink · gemini copy). */
  replicas: { host: "claude" | "gemini"; path: string; mode: SkillReplicaMode }[];
  summary: string;
}

export interface UninstallData {
  status: "uninstalled" | "removed";
  name: string;
  /** Present when a same-named foreign dir was preserved (canonical or replica). */
  warning?: string;
  summary: string;
}

type ResolvedSource = { kind: "git"; url: string; ref?: string } | { kind: "local"; path: string };

type SkillCandidate = { name: string; path: string };

// skills/<category>/<skill> (mattpocock/skills) fits within 3 levels below the root.
const MAX_SCAN_DEPTH = 3;

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
 *  (the basename of a temp clone is random, never usable). */
function frontmatterName(content: string): string | null {
  const block = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return block.match(/^name:\s*(\S[^\r\n]*)/m)?.[1]?.trim() ?? null;
}

/** Bounded walk: nested skills up to skills/<category>/<skill>; skips
 *  dot-dirs, node_modules and symlinks (a link's Dirent is not isDirectory). */
async function walkSkillDirs(dir: string, depth: number): Promise<SkillCandidate[]> {
  if (depth >= MAX_SCAN_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (await isSkillDir(full)) {
      out.push({ name: entry.name, path: full });
    } else {
      out.push(...(await walkSkillDirs(full, depth + 1)));
    }
  }
  return out;
}

/** Skill dirs of a source: the dir itself (if it IS a skill, named by its
 *  frontmatter) or the tree; duplicate or invalid names are discarded. */
async function collectCandidates(dir: string): Promise<SkillCandidate[]> {
  if (await isSkillDir(dir)) {
    const content = await readFile(join(dir, "SKILL.md"), "utf8");
    const name = frontmatterName(content) ?? basename(dir);
    return isValidSkillName(name) ? [{ name, path: dir }] : [];
  }
  const found = await walkSkillDirs(dir, 0);
  const byName = new Map<string, SkillCandidate>();
  for (const c of found) {
    if (!isValidSkillName(c.name) || byName.has(c.name)) continue;
    byName.set(c.name, c);
  }
  return [...byName.values()];
}

/** Brings the source into a readable dir and lists its skills (temp clone for git). */
async function fetchSourceCandidates(
  resolved: ResolvedSource,
  ctx: CliContext,
): Promise<
  { candidates: SkillCandidate[]; cleanup: () => Promise<void> } | { code: string; error: string }
> {
  if (resolved.kind === "local") {
    if (!(await ctx.fs.exists(resolved.path))) {
      return { code: "SOURCE_NOT_FOUND", error: `el path local '${resolved.path}' no existe` };
    }
    return { candidates: await collectCandidates(resolved.path), cleanup: async () => {} };
  }
  const temp = await mkdtemp(join(tmpdir(), "aw-skill-fetch-"));
  const cleanup = async () => {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await gitClone(resolved.url, temp, resolved.ref);
  } catch (err) {
    await cleanup();
    return { code: "GIT_CLONE_FAILED", error: `git clone falló: ${(err as Error).message}` };
  }
  return { candidates: await collectCandidates(temp), cleanup };
}

/** Read preceding a mutation: an unreadable registry ABORTS — the first write
 *  after a failed read would clobber every prior entry. */
async function readRegistryForWrite(
  ctx: CliContext,
): Promise<{ registry: SkillsRegistry } | { code: string; error: string }> {
  const read = await readSkillsRegistry(ctx);
  if (read.warning) {
    return {
      code: "REGISTRY_UNREADABLE",
      error: `${read.warning} Corregí (o borrá) el archivo antes de operar.`,
    };
  }
  return { registry: read.registry };
}

/** Side-effect-free inspection: lists a source's skills so the wizard can show
 *  the picker + third-party warning BEFORE registering anything. */
export async function probeSkillSource(
  ctx: CliContext,
  input: Pick<RegisterInput, "source" | "ref">,
): Promise<CommandResult<{ candidates: string[] }>> {
  const resolved = resolveSkillSource(input.source, input.ref);
  if ("error" in resolved) return fail("INVALID_SOURCE", resolved.error);
  const fetched = await fetchSourceCandidates(resolved, ctx);
  if ("error" in fetched) return fail(fetched.code, fetched.error);
  try {
    if (fetched.candidates.length === 0) {
      return fail(
        "SOURCE_NOT_FOUND",
        `no se encontró ninguna skill válida (SKILL.md con name+description) en '${input.source}'`,
      );
    }
    return {
      ok: true,
      data: { candidates: fetched.candidates.map((c) => c.name).sort() },
      exitCode: 0,
    };
  } finally {
    await fetched.cleanup();
  }
}

export async function registerSkill(
  ctx: CliContext,
  input: RegisterInput,
): Promise<CommandResult<RegisterData>> {
  const resolved = resolveSkillSource(input.source, input.ref);
  if ("error" in resolved) return fail("INVALID_SOURCE", resolved.error);

  const fetched = await fetchSourceCandidates(resolved, ctx);
  if ("error" in fetched) return fail(fetched.code, fetched.error);

  try {
    const picked = pickCandidate(fetched.candidates, input);
    if ("error" in picked) return fail(picked.code, picked.error);
    if ("candidates" in picked) {
      return {
        ok: true,
        data: {
          status: "needs-pick",
          candidates: picked.candidates,
          summary: `La fuente contiene ${picked.candidates.length} skills; elegí una para registrar.`,
        },
        exitCode: 0,
      };
    }

    const read = await readRegistryForWrite(ctx);
    if ("error" in read) return fail(read.code, read.error);
    const { registry } = read;
    if (registry.skills[picked.name]) {
      return fail(
        "SKILL_ALREADY_REGISTERED",
        `'${picked.name}' ya está registrada (fuente: ${registry.skills[picked.name]?.source})`,
      );
    }
    // `w-*` is the namespace of the bundle's synthesized wrappers
    // (install-skill.ts) — registering a standalone skill there would leave it
    // at the mercy of the install/uninstall sweep over the same roots.
    if (picked.name.startsWith(COMMAND_SKILL_PREFIX)) {
      return fail(
        "RESERVED_SKILL_PREFIX",
        `'${picked.name}' usa el prefijo reservado '${COMMAND_SKILL_PREFIX}' (wrappers del bundle) — elegí otro nombre`,
      );
    }
    // Ownership guard: an existing UNregistered canonical dir belongs to someone
    // else (`w` bundle, plugin skill, manual install) — we never adopt it.
    const canonical = join(canonicalSkillsRoot(ctx.env.homeDir()), picked.name);
    if (await ctx.fs.exists(canonical)) {
      return fail(
        "SKILL_NAME_COLLISION",
        `ya existe ${canonical} y no está en el registro de sueltas — elegí otro nombre o resolvé la colisión a mano`,
      );
    }

    const entry: SkillRegistryEntry = {
      source:
        resolved.kind === "git" ? (input.source.split("#")[0] ?? input.source) : resolved.path,
      ...(resolved.kind === "git" && resolved.ref ? { ref: resolved.ref } : {}),
    };
    registry.skills[picked.name] = entry;
    await writeSkillsRegistry(ctx, registry);
    return {
      ok: true,
      data: {
        status: "registered",
        name: picked.name,
        entry,
        summary: `Skill '${picked.name}' registrada desde ${entry.source}.`,
      },
      exitCode: 0,
    };
  } finally {
    await fetched.cleanup();
  }
}

function pickCandidate(
  candidates: SkillCandidate[],
  input: RegisterInput,
): SkillCandidate | { candidates: string[] } | { code: string; error: string } {
  if (candidates.length === 0) {
    return {
      code: "SOURCE_NOT_FOUND",
      error: `no se encontró ninguna skill válida (SKILL.md con name+description) en '${input.source}'`,
    };
  }
  if (input.pick !== undefined) {
    const found = candidates.find((c) => c.name === input.pick);
    return (
      found ?? {
        code: "INVALID_PICK",
        error: `la fuente no contiene la skill '${input.pick}' (disponibles: ${candidates
          .map((c) => c.name)
          .sort()
          .join(", ")})`,
      }
    );
  }
  if (candidates.length === 1 && candidates[0]) return candidates[0];
  return { candidates: candidates.map((c) => c.name).sort() };
}

export async function installSkill(
  ctx: CliContext,
  name: string,
  opts: { refetch: boolean } = { refetch: true },
): Promise<CommandResult<MaterializeData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);

  const home = ctx.env.homeDir();
  const canonical = join(canonicalSkillsRoot(home), name);

  // Pre-flight BEFORE mutating anything: a foreign replica (on any host) or a
  // canonical collision aborts without touching the prior install or the foreign dir.
  const replicaStates = new Map<ReplicaHost["key"], Exclude<ReplicaState, "foreign">>();
  for (const host of REPLICA_HOSTS) {
    const state = await inspectReplica(ctx, name, entry.mode, host);
    if (state === "foreign") {
      return fail(
        "FOREIGN_REPLICA",
        `ya existe ${join(host.root(home), name)} y no lo creó este manager — resolvé la colisión a mano`,
      );
    }
    replicaStates.set(host.key, state);
  }
  if (opts.refetch && !entry.installedAt && (await ctx.fs.exists(canonical))) {
    return fail(
      "SKILL_NAME_COLLISION",
      `ya existe ${canonical} y este manager no lo materializó — resolvé la colisión a mano`,
    );
  }

  if (opts.refetch) {
    const resolved = resolveSkillSource(entry.source, entry.ref);
    if ("error" in resolved) return fail("INVALID_SOURCE", resolved.error);
    const fetched = await fetchSourceCandidates(resolved, ctx);
    if ("error" in fetched) return fail("FETCH_FAILED", fetched.error);
    try {
      const skillDir = fetched.candidates.find((c) => c.name === name);
      if (!skillDir) {
        return fail(
          "FETCH_FAILED",
          `la fuente '${entry.source}' ya no contiene la skill '${name}'`,
        );
      }
      await materializeCanonical(ctx, skillDir.path, canonical, name);
    } catch (err) {
      return fail("MATERIALIZE_FAILED", (err as Error).message);
    } finally {
      await fetched.cleanup();
    }
  } else if (!entry.installedAt || !(await ctx.fs.exists(canonical))) {
    // Reinstall requires THIS manager to have materialized the canonical dir:
    // without installedAt, an existing same-named dir is foreign and is not replicated.
    return fail(
      "SKILL_NOT_INSTALLED",
      `'${name}' no está instalada (no existe ${canonical} materializada por este manager); usá Install/Update`,
    );
  }

  const replicas: Awaited<ReturnType<typeof replicateToHost>>[] = [];
  for (const host of REPLICA_HOSTS) {
    replicas.push(await replicateToHost(ctx, name, replicaStates.get(host.key) ?? "absent", host));
  }
  // The registered mode is still the Claude replica's (the primary one): the
  // TUI's "(copy)" badge flags ITS degradation (Windows without symlinks);
  // the gemini copy is by-design and authenticates via marker, not mode.
  const claudeReplica = replicas[0] ?? { path: canonical, mode: "symlink" as const };

  // Re-read before writing: the clone can take a while and another invocation
  // may have touched the registry in between — never write a stale snapshot.
  const fresh = await readRegistryForWrite(ctx);
  if ("error" in fresh) return fail(fresh.code, fresh.error);
  const current = fresh.registry.skills[name] ?? entry;
  fresh.registry.skills[name] = {
    ...current,
    mode: claudeReplica.mode,
    ...(opts.refetch ? { installedAt: new Date().toISOString() } : {}),
  };
  await writeSkillsRegistry(ctx, fresh.registry);

  return {
    ok: true,
    data: {
      status: opts.refetch ? "installed" : "reinstalled",
      name,
      canonical,
      replica: claudeReplica.path,
      mode: claudeReplica.mode,
      replicas: replicas.map((r) => ({ host: r.host, path: r.path, mode: r.mode })),
      summary: `Skill '${name}' materializada en ${canonical} (réplicas: ${replicas
        .map((r) => `${r.host} ${r.mode}`)
        .join(" · ")}).`,
    },
    exitCode: 0,
  };
}

/** Reinstall: repairs canonical→replica without touching the source (offline-safe). */
export async function reinstallSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<MaterializeData>> {
  return installSkill(ctx, name, { refetch: false });
}

/** Update: re-fetches the registered ref; git sources only. Staging+swap: a
 *  fetch failure leaves the prior install intact. */
export async function updateSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<MaterializeData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);
  const resolved = resolveSkillSource(entry.source, entry.ref);
  if ("error" in resolved || resolved.kind !== "git") {
    return fail(
      "UPDATE_REQUIRES_GIT",
      `Update re-fetchea git; '${name}' viene de un path local — usá Reinstall (o re-registrá la fuente).`,
    );
  }
  if (!(await ctx.fs.exists(join(canonicalSkillsRoot(ctx.env.homeDir()), name)))) {
    return fail("SKILL_NOT_INSTALLED", `'${name}' no está instalada; usá Install`);
  }
  const result = await installSkill(ctx, name, { refetch: true });
  if (!result.ok || !result.data) return result;
  return {
    ...result,
    data: {
      ...result.data,
      status: "updated",
      summary: `Skill '${name}' actualizada (ref registrado re-fetcheado).`,
    },
  };
}

export async function uninstallSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<UninstallData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);

  const warning = await teardownSkill(ctx, name, entry);
  read.registry.skills[name] = {
    source: entry.source,
    ...(entry.ref ? { ref: entry.ref } : {}),
  };
  await writeSkillsRegistry(ctx, read.registry);
  return {
    ok: true,
    data: {
      status: "uninstalled",
      name,
      ...(warning ? { warning } : {}),
      summary: `Skill '${name}' desinstalada; sigue registrada (fuente: ${entry.source}).`,
    },
    exitCode: 0,
  };
}

export async function removeSkill(
  ctx: CliContext,
  name: string,
): Promise<CommandResult<UninstallData>> {
  const read = await readRegistryForWrite(ctx);
  if ("error" in read) return fail(read.code, read.error);
  const entry = read.registry.skills[name];
  if (!entry) return notRegistered(name);

  const warning = await teardownSkill(ctx, name, entry);
  delete read.registry.skills[name];
  await writeSkillsRegistry(ctx, read.registry);
  return {
    ok: true,
    data: {
      status: "removed",
      name,
      ...(warning ? { warning } : {}),
      summary: `Skill '${name}' desinstalada y quitada del registro.`,
    },
    exitCode: 0,
  };
}

/** Single list for the TUI: registered (installed or not) + canonicals outside
 *  the registry (`unmanaged`) + unregistered seed. Order: installed → unmanaged
 *  → registered → recommended; alphabetical within each group. */
export async function listSkills(
  ctx: CliContext,
  seed: readonly SeedSkill[],
): Promise<SkillListItem[]> {
  const { registry, warning } = await readSkillsRegistry(ctx);
  const home = ctx.env.homeDir();
  const seedByName = new Map(seed.map((s) => [s.name, s]));

  const items: SkillListItem[] = [];
  for (const [name, entry] of Object.entries(registry.skills)) {
    const canonical = await ctx.fs.exists(join(canonicalSkillsRoot(home), name));
    const replica = (await ctx.fs.lstat(join(claudeReplicaRoot(home), name))) !== null;
    const gemini = (await ctx.fs.lstat(join(geminiReplicaRoot(home), name))) !== null;
    const description = seedByName.get(name)?.description;
    items.push({
      name,
      source: entry.source,
      ...(entry.ref ? { ref: entry.ref } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.installedAt ? { installedAt: entry.installedAt } : {}),
      ...(description ? { description } : {}),
      status: canonical ? "installed" : "registered",
      replicas: { agents: canonical, claude: replica, gemini },
    });
  }

  // Canonicals outside the registry (skills.sh, manual): shown as `unmanaged`
  // so the tab reflects the WHOLE anchor, without making them operable
  // (ownership guard intact). The source comes from the skills.sh lock when it
  // knows it; "" when nobody does. Excluded: the `w` bundle and its
  // synthesized `w-*` namespace (skill-as-command) + legacy names (managed by
  // [Workflows], not "someone else's"). With an UNREADABLE registry nothing is
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
          status: "unmanaged",
          replicas: { agents: true, claude: replica, gemini },
        });
      }
    } catch {
      // Anchor absent or unreadable (e.g. permissions): the scan is best-effort —
      // managed skills are already listed; never empty the tab over this.
    }
  }

  for (const s of seed) {
    if (Object.hasOwn(registry.skills, s.name) || unmanaged.has(s.name)) continue;
    // Same-named canonical the scan did not list (invalid frontmatter, file,
    // unreadable registry): offering Install guarantees SKILL_NAME_COLLISION —
    // better not to offer the seed.
    if (await ctx.fs.exists(join(root, s.name))) continue;
    items.push({
      name: s.name,
      source: s.source,
      description: s.description,
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

/**
 * Copies src into a hidden staging dir and swaps it with the canonical one;
 * the .bak is only discarded once the swap completed — a failure restores the
 * previous state. `renameFn` is injectable to test the restore branch.
 */
export async function materializeCanonical(
  ctx: CliContext,
  srcDir: string,
  canonical: string,
  name: string,
  renameFn: typeof rename = rename,
): Promise<void> {
  const root = canonicalSkillsRoot(ctx.env.homeDir());
  await ctx.fs.mkdirp(root);
  const staging = join(root, `.staging-${name}-${process.pid}`);
  const bak = join(root, `.bak-${name}-${process.pid}`);
  await ctx.fs.remove(staging);
  try {
    await copyDir(srcDir, staging);
    const hadPrevious = await ctx.fs.exists(canonical);
    if (hadPrevious) await renameFn(canonical, bak);
    try {
      await renameFn(staging, canonical);
    } catch (err) {
      if (hadPrevious) await renameFn(bak, canonical).catch(() => {});
      throw err;
    }
    if (hadPrevious) await ctx.fs.remove(bak);
  } finally {
    await ctx.fs.remove(staging);
  }
}

type ReplicaState = "absent" | "ours" | "foreign";

/** Replica ownership on a host: ours only if it is a symlink pointing at OUR
 *  canonical, a real dir with the `.aw-replica` marker, or — legacy
 *  (pre-marker copies, Windows) — a real dir with registered mode:"copy". A
 *  user's symlink pointing elsewhere is foreign — never re-pointed. */
async function inspectReplica(
  ctx: CliContext,
  name: string,
  registeredMode: SkillReplicaMode | undefined,
  host: ReplicaHost,
): Promise<ReplicaState> {
  const home = ctx.env.homeDir();
  const replicaRoot = host.root(home);
  const replica = join(replicaRoot, name);
  const existing = await ctx.fs.lstat(replica);
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

/** Materializes the replica on a host (pre-flight already ensured it is not foreign). */
async function replicateToHost(
  ctx: CliContext,
  name: string,
  state: Exclude<ReplicaState, "foreign">,
  host: ReplicaHost,
): Promise<{ host: ReplicaHost["key"]; path: string; mode: SkillReplicaMode }> {
  const home = ctx.env.homeDir();
  const canonical = join(canonicalSkillsRoot(home), name);
  const replicaRoot = host.root(home);
  const replica = join(replicaRoot, name);

  if (state === "ours") await ctx.fs.remove(replica);
  await ctx.fs.mkdirp(replicaRoot);
  if (host.preferSymlink) {
    try {
      await ctx.fs.symlink(canonical, replica);
      return { host: host.key, path: replica, mode: "symlink" };
    } catch {
      // No symlinks (Windows without Developer Mode / EPERM) → real copy.
    }
  }
  await copyDir(canonical, replica);
  await ctx.fs.writeText(join(replica, REPLICA_MARKER_FILENAME), `${canonical}\n`);
  return { host: host.key, path: replica, mode: "copy" };
}

/** Tears down replicas and the canonical dir respecting ownership; returns a
 *  warning if a same-named foreign dir was preserved. */
async function teardownSkill(
  ctx: CliContext,
  name: string,
  entry: SkillRegistryEntry,
): Promise<string | undefined> {
  const home = ctx.env.homeDir();
  const warnings: string[] = [];

  for (const host of REPLICA_HOSTS) {
    const replica = join(host.root(home), name);
    const replicaState = await inspectReplica(ctx, name, entry.mode, host);
    if (replicaState === "ours") await ctx.fs.remove(replica);
    else if (replicaState === "foreign") {
      warnings.push(`se conservó ${replica}: existe pero no lo creó este manager`);
    }
  }

  const canonical = join(canonicalSkillsRoot(home), name);
  if (entry.installedAt) {
    await ctx.fs.remove(canonical);
  } else if (await ctx.fs.exists(canonical)) {
    warnings.push(`se conservó ${canonical}: este manager no lo materializó`);
  }
  return warnings.length > 0 ? warnings.join(" · ") : undefined;
}

function notRegistered<T>(name: string): CommandResult<T> {
  return {
    ok: false,
    error: {
      code: "SKILL_NOT_REGISTERED",
      message: `'${name}' no está en el registro de sueltas — este manager no toca dirs que no registró (bundle w, skills de plugins o manuales).`,
    },
    exitCode: 1,
  };
}

function fail<T>(code: string, message: string): CommandResult<T> {
  return { ok: false, error: { code, message }, exitCode: 1 };
}
