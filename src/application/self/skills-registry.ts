// Registro user-level de skills sueltas (las que administra [Skills], NO el
// bundle `w` ni skills de plugins). Archivo separado del .skill-lock.json a
// propósito: ciclos de vida distintos (el lock lo escribe install-skill del
// bundle; este registro lo escribe skills-manager).

import { join } from "node:path";
import type { CliContext } from "../../cli/types.js";

export const SKILLS_REGISTRY_REL = [".agents", ".skills-registry.json"] as const;

export type SkillReplicaMode = "symlink" | "copy";

export interface SkillRegistryEntry {
  /** Git URL, atajo `owner/repo` o path local absoluto. */
  source: string;
  /** Ref git registrado (branch/tag); update siempre re-fetchea ESTE ref. */
  ref?: string;
  /** Modo con que se materializó la réplica de Claude (fallback Windows = copy). */
  mode?: SkillReplicaMode;
  /** ISO timestamp del último install/update; ausente = registrada sin instalar. */
  installedAt?: string;
}

export interface SkillsRegistry {
  skills: Record<string, SkillRegistryEntry>;
}

export interface SkillsRegistryRead {
  registry: SkillsRegistry;
  path: string;
  /** Presente si el archivo existía pero no parseó — se deja intacto (patrón lock). */
  warning?: string;
}

export function skillsRegistryPath(home: string): string {
  return join(home, ...SKILLS_REGISTRY_REL);
}

/**
 * Un nombre de skill es un segmento de path seguro: el registro se joinea a
 * rutas que luego se borran recursivamente — "..", separadores o vacíos jamás.
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
      // Nombre inválido (p.ej. "..", con separadores) = entrada descartada: un
      // registro editado a mano nunca convierte un remove en rm fuera del root.
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
