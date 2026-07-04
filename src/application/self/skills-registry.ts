// User-level registry of standalone skills (the ones [Skills] manages — NOT
// the `w` bundle nor plugin skills). Kept as a separate file from
// .skill-lock.json on purpose: distinct lifecycles (the lock is written by the
// bundle's install-skill; this registry is written by skills-manager).

import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";
import { AGENTS_LOCK_REL } from "./install-skill.js";

export const SKILLS_REGISTRY_REL = [".agents", ".skills-registry.json"] as const;

export type SkillReplicaMode = "symlink" | "copy";

export interface SkillRegistryEntry {
  /** Git URL, `owner/repo` shorthand, or absolute local path. */
  source: string;
  /** Registered git ref (branch/tag); update always re-fetches THIS ref. */
  ref?: string;
  /** Mode the Claude replica was materialized with (Windows fallback = copy). */
  mode?: SkillReplicaMode;
  /** ISO timestamp of the last install/update; absent = registered, not installed. */
  installedAt?: string;
}

export interface SkillsRegistry {
  skills: Record<string, SkillRegistryEntry>;
}

export interface SkillsRegistryRead {
  registry: SkillsRegistry;
  path: string;
  /** Present when the file existed but failed to parse — left untouched (lock pattern). */
  warning?: string;
}

export function skillsRegistryPath(home: string): string {
  return join(home, ...SKILLS_REGISTRY_REL);
}

/**
 * A skill name is a safe path segment: registry names are joined into paths
 * that later get removed recursively — never "..", separators, or empty.
 */
export function isValidSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(name);
}

export async function readSkillsRegistry(ctx: CliContext): Promise<SkillsRegistryRead> {
  const path = skillsRegistryPath(ctx.env.homeDir());
  if (!(await ctx.fs.exists(path))) return { registry: { skills: {} }, path };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ctx.fs.readText(path));
  } catch (err) {
    return {
      registry: { skills: {} },
      path,
      warning: `No se pudo parsear ${path}: ${(err as Error).message}. Registro tratado como vacío; el archivo queda intacto.`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { registry: { skills: {} }, path, warning: `${path} no es un objeto JSON.` };
  }
  const rawSkills = (parsed as { skills?: unknown }).skills;
  const skills: Record<string, SkillRegistryEntry> = {};
  if (rawSkills && typeof rawSkills === "object" && !Array.isArray(rawSkills)) {
    for (const [name, value] of Object.entries(rawSkills as Record<string, unknown>)) {
      // Invalid name (e.g. "..", with separators) = entry discarded: a
      // hand-edited registry never turns a remove into an rm outside the root.
      if (!isValidSkillName(name)) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      if (typeof v.source !== "string" || v.source.length === 0) continue;
      skills[name] = {
        source: v.source,
        ...(typeof v.ref === "string" ? { ref: v.ref } : {}),
        ...(v.mode === "symlink" || v.mode === "copy" ? { mode: v.mode } : {}),
        ...(typeof v.installedAt === "string" ? { installedAt: v.installedAt } : {}),
      };
    }
  }
  return { registry: { skills }, path };
}

export async function writeSkillsRegistry(
  ctx: CliContext,
  registry: SkillsRegistry,
): Promise<string> {
  const path = skillsRegistryPath(ctx.env.homeDir());
  await ctx.fs.mkdirp(join(ctx.env.homeDir(), ".agents"));
  await ctx.fs.writeText(path, `${JSON.stringify(registry, null, 2)}\n`);
  return path;
}

/** Lock shared with skills.sh (same path the bundle's install-skill flow
 *  writes — single constant in install-skill.ts). This engine only READS it:
 *  a source hint for canonicals outside the registry. */
export async function readSkillsShLockSources(ctx: CliContext): Promise<Record<string, string>> {
  const path = join(ctx.env.homeDir(), ...AGENTS_LOCK_REL);
  try {
    const parsed = JSON.parse(await ctx.fs.readText(path)) as {
      skills?: Record<string, { source?: unknown }>;
    };
    const sources: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed?.skills ?? {})) {
      if (!isValidSkillName(name)) continue;
      if (typeof value?.source === "string" && value.source.length > 0) {
        sources[name] = value.source;
      }
    }
    return sources;
  } catch {
    // Absent or broken = no hints; the lock never blocks listing.
    return {};
  }
}
